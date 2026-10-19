// Crash injection at ANNOUNCED windows over the server's sync path: the app
// (tests/fixtures/sync-announced-kill/app.js) counts every write it makes to a
// sync_* table (op persist, settled mark, refused-op delete, compaction,
// cursor/meta) and every journal append of a sync record, and at the KILLAT-th
// one writes a flag and SIGKILLs itself before the write leaves. A writer
// client sends ops (some refused by `validate`, some with a skewed clock), an
// observer client follows the broadcasts; after the kill a fresh server boots,
// the observer catches up from its cursor, the writer resends EVERY op, and a
// clean stop is booted once more to read the state.
//
// Against a reference model of what was acknowledged:
//  - an op acked before the kill is acked again on resend — never refused,
//  - an op its cell refuses is never acked,
//  - the state holds every acked op exactly once and nothing else,
//  - the listener counted each exactly once,
//  - the observer's replica (broadcasts + catch-up from its cursor) equals it.
//
// `AIO_SYNC_KILL_N` widens the sweep, `AIO_SYNC_KILL_AT` replays one window.
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { fuzzEnvInt } from "./fuzz-seed.ts";
import { stopChild } from "./stop-child.ts";

const APP = fromFileUrl(
  new URL("./fixtures/sync-announced-kill/app.js", import.meta.url),
);
const TREE = fromFileUrl(new URL("..", import.meta.url));
const H = 3600_000;

type Server = {
  port: number;
  out: () => string;
  status: Promise<Deno.CommandStatus>;
  child: Deno.ChildProcess;
};

async function boot(
  dir: string,
  phase: string,
  env: Record<string, string> = {},
): Promise<Server> {
  const port = freePort();
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", join(TREE, "deno.json"), APP],
    env: {
      ...env,
      DIR: dir,
      PORT: String(port),
      AIO_APPS_DIR: dir,
      XDG_RUNTIME_DIR: dir,
      PHASE: phase,
      FLAG: join(dir, "flag"),
      MOD: new URL(`file://${join(TREE, "mod.ts")}`).href,
      AIO_NO_OPEN: "1",
    },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let log = "";
  const pump = async (s: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    for await (const c of s) log += dec.decode(c, { stream: true });
  };
  const pumped = Promise.all([pump(child.stdout), pump(child.stderr)]);
  const status = child.status.then(async (s) => (await pumped, s));
  return { port, out: () => log, status, child };
}

async function ready(s: Server): Promise<boolean> {
  let done = false;
  s.status.then(() => (done = true));
  for (let i = 0; i < 3000; i++) {
    if (/^READY$/m.test(s.out())) return true;
    if (done) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no READY\n${s.out()}`);
}

type Frame = { t: string; d: Record<string, unknown> };
async function connect(
  port: number,
  on: (f: Frame) => void,
): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.onmessage = (e) => {
    try {
      on(JSON.parse(e.data));
    } catch { /* not a frame */ }
  };
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  return ws;
}
const closed = (ws: WebSocket) =>
  ws.readyState === WebSocket.CLOSED ? Promise.resolve() : new Promise<void>(
    (r) => ws.addEventListener("close", () => r()),
  );

type Op = { id: string; arg: string; hlc: [number, number, string] };
const frame = (o: Op) =>
  JSON.stringify({
    v: 2,
    t: "op",
    d: {
      id: o.id,
      hlc: o.hlc,
      cell: "notes",
      action: "add",
      payload: { args: [o.arg] },
    },
  });

/** The observer: a replica folded from broadcasts and catch-ups. */
function observer() {
  const o = {
    items: [] as string[],
    cursor: 0,
    res: undefined as Record<string, unknown> | undefined,
    on(f: Frame) {
      if (f.t === "op" && f.d.cell === "notes") {
        o.items.push((f.d.payload as { args: string[] }).args[0]!);
        o.cursor = Math.max(o.cursor, f.d.serverTs as number);
      } else if (f.t === "sync-res") {
        const r = f.d as {
          mode: string;
          snapshot?: { notes?: { items: string[] } };
          ops: { cell: string; payload: { args: string[] } }[];
          lastServerTs?: Record<string, number>;
        };
        if (r.mode === "snapshot" && r.snapshot?.notes) {
          o.items = [...r.snapshot.notes.items];
        }
        for (const op of r.ops) {
          if (op.cell === "notes") o.items.push(op.payload.args[0]!);
        }
        o.cursor = r.lastServerTs?.notes ?? o.cursor;
        o.res = r;
      }
    },
  };
  return o;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const syncReq = (cursor: number) =>
  JSON.stringify({
    v: 2,
    t: "sync-req",
    d: {
      clientId: "o1",
      reqId: 1,
      cells: { notes: { lastHlc: null, lastServerTs: cursor } },
      pendingOps: [],
    },
  });

/** One run: each round boots the app with a kill at its `kills[r]`-th sync
 *  write (0: none — that round is stopped cleanly); every op is (re)sent
 *  each round; a last clean round, then a read boot. */
async function episode(kills: number[], seed: number): Promise<number> {
  const dir = await tempDir("aio-sync-kill-");
  let rnd = seed >>> 0;
  const rng = () => {
    rnd = (rnd + 0x6D2B79F5) >>> 0;
    let t = rnd;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const tag = `kills=${kills} seed=${seed}`;
  const logs: string[] = [];
  /** Every answer, round by round. */
  const answers: Map<string, string>[] = [];
  let fired = 0;
  try {
    const now = Date.now();
    const ops: Op[] = Array.from({ length: 12 }, (_, i) => {
      const r = rng();
      const skew = r < 0.1
        ? 10 * 60_000 // ahead past maxDrift: refused
        : r < 0.2
        ? -30 * H // old, inside the 48h retention
        : r < 0.25
        ? -100 * H // older than any record: refused unless known
        : 0;
      return {
        id: `c1-s1-${i}.r${seed}`,
        arg: rng() < 0.15 ? `bad${i}` : `n${i}`,
        hlc: [now + skew, i, "c1"],
      };
    });
    const live = observer();
    // Sees the first broadcasts only, and comes back at the end — after
    // compactions removed what it missed.
    const late = observer();
    let lateWs: WebSocket | undefined;
    const rounds = [...kills, 0];
    for (const [r, killAt] of rounds.entries()) {
      const got = new Map<string, string>();
      answers.push(got);
      await Deno.remove(join(dir, "flag")).catch(() => {});
      const s = await boot(dir, "serve", { KILLAT: String(killAt) });
      await ready(s);
      let dead = false;
      s.status.then(() => (dead = true));
      const socks: WebSocket[] = [];
      if (!dead) {
        const o = await connect(s.port, (f) => live.on(f)).catch(() => {});
        if (o) {
          socks.push(o);
          live.res = undefined;
          if (r > 0) o.send(syncReq(live.cursor));
          for (let k = 0; k < 500 && r > 0 && !dead && !live.res; k++) {
            await sleep(10);
          }
          assert(dead || r === 0 || live.res, `${tag} no sync-res`);
        }
        if (r === 0) {
          lateWs = await connect(s.port, (f) => {
            if (late.items.length < 2 || f.t !== "op") late.on(f);
            else lateWs?.close();
          }).catch(() => undefined);
        }
        const w = await connect(s.port, (f) => {
          if (f.t === "sync-ack" || f.t === "op-rejected") {
            got.set(f.d.opId as string, f.t);
          }
        }).catch(() => undefined);
        if (w) socks.push(w);
        for (let i = 0; i < ops.length && w && !dead;) {
          const group = ops.slice(i, i + 1 + Math.floor(rng() * 4));
          i += group.length;
          for (const o of group) {
            try {
              w.send(frame(o));
            } catch { /* the server died */ }
          }
          for (let k = 0; k < 500; k++) {
            if (dead || group.every((o) => got.has(o.id))) break;
            await sleep(10);
          }
          assert(dead || group.every((o) => got.has(o.id)), `${tag} no answer`);
        }
      }
      if (!dead) {
        await sleep(50); // the last broadcasts
        if (r === rounds.length - 1 && lateWs !== undefined) {
          // The late observer returns, its cursor far behind.
          const o = await connect(s.port, (f) => late.on(f));
          socks.push(o);
          late.res = undefined;
          o.send(syncReq(late.cursor));
          for (let k = 0; k < 500 && !late.res; k++) await sleep(10);
          assert(late.res, `${tag} late: no sync-res`);
        }
        for (const x of socks) x.close();
        await Promise.all(socks.map(closed));
        // A clean stop on every OS: SIGTERM, or on Windows (where a SIGTERM
        // is a TerminateProcess) the stop request `am stop` sends. An
        // announced kill that came first is a child already gone.
        await stopChild(s.child, { quiet: true });
      }
      const st = await s.status;
      logs.push(`--- round ${r} (kill ${killAt})\n${s.out()}`);
      const flag = await Deno.readTextFile(join(dir, "flag")).catch(() => "");
      // Windows has no signals: `Deno.kill(pid, "SIGKILL")` is a
      // TerminateProcess, seen as exit code 1 — the flag is what says it was
      // the announced kill there.
      if (
        st.signal === "SIGKILL" ||
        (Deno.build.os === "windows" && st.code === 1 && flag !== "")
      ) {
        // The kill was the announced one, never a stray.
        assert(flag !== "", `${tag}: SIGKILL, no flag\n${logs.join("\n")}`);
        fired++;
        logs.push(`(flag: ${flag})`);
      } else {
        assertEquals(st.code, 0, `${tag} round ${r}\n${logs.join("\n")}`);
      }
    }
    const s3 = await boot(dir, "read");
    await s3.status;
    logs.push(`--- read\n${s3.out()}`);
    const line = /^RESULT (.*)$/m.exec(s3.out())?.[1];
    const ctx = () =>
      `${tag}\n${
        answers.map((a, i) => `answers ${i}: ${JSON.stringify([...a])}`).join(
          "\n",
        )
      }\nlive=${live.items}\nlate=${late.items}\n${logs.join("\n")}`;
    assert(line, `read boot\n${ctx()}`);
    const state = JSON.parse(line) as { items: string[]; n: number };
    const last = answers.at(-1)!;
    assertEquals(last.size, ops.length, `unanswered\n${ctx()}`);
    for (const o of ops) {
      const seen = answers.map((a) => a.get(o.id));
      const firstAck = seen.indexOf("sync-ack");
      if (firstAck >= 0) {
        for (const later of seen.slice(firstAck)) {
          assert(
            later === undefined || later === "sync-ack",
            `acked ${o.id} then refused\n${ctx()}`,
          );
        }
      }
      if (o.arg.startsWith("bad")) {
        assert(!seen.includes("sync-ack"), `bad acked ${o.id}\n${ctx()}`);
      }
    }
    const acked = ops.filter((o) => last.get(o.id) === "sync-ack").map((o) =>
      o.arg
    );
    assertEquals([...state.items].sort(), acked.sort(), `state\n${ctx()}`);
    // Never counted twice; a reaction short only where a boot NAMED it (a
    // crash between a persist and its commit holds it — never a guess;
    // tests/journal-crash-sweep.test.ts, the same contract).
    const all = logs.join("\n");
    const held = [
      ...all.matchAll(/"tally": (\d+) listensTo reactions? of the sync op/g),
    ].reduce((n, m) => n + Number(m[1]), 0);
    const open = /cannot tell whether "tally" holds/.test(all);
    assert(state.n <= state.items.length, `listener twice\n${ctx()}`);
    assert(
      state.items.length - state.n <= held || open,
      `listener: unnamed loss\n${ctx()}`,
    );
    assertEquals(live.items, state.items, `live replica\n${ctx()}`);
    if (lateWs !== undefined) {
      assertEquals(late.items, state.items, `late replica\n${ctx()}`);
    }
    if (Deno.env.get("AIO_SYNC_KILL_TRACE")) {
      console.log(
        `${tag} fired=${fired} items=${state.items} windows=${
          logs.map((l) => (l.match(/^WINDOW /gm) ?? []).length)
        }`,
      );
      if (Deno.env.get("TRACE")) console.log(logs.join("\n"));
    }
    return fired;
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("sync: a kill at any announced sync write loses no acked op, applies none twice, and every replica converges", async () => {
  const one = Deno.env.get("AIO_SYNC_KILL_AT"); // "k1,k2"
  const n = fuzzEnvInt("AIO_SYNC_KILL_N", 8, 1);
  const seed = fuzzEnvInt("AIO_SYNC_KILL_SEED", 7);
  const plans = one !== undefined
    ? [one.split(",").map(Number)]
    : Array.from({ length: n }, (_, i) => {
      const k = 1 + Math.floor(i * 56 / n);
      // Every other run is killed again in its recovery round.
      return i % 2 === 0 ? [k] : [k, 1 + (k % 8)];
    });
  let fired = 0;
  for (const [i, p] of plans.entries()) fired += await episode(p, seed + i);
  // Positive control: the instrument fired — announced kills happened.
  assert(fired > 0 || one !== undefined, "no kill window was reached");
});
