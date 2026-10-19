// Cross-door differential: ONE app, ONE random program of method calls, sent
// interleaved through every door at once — WebSocket, UDS (the desktop wire),
// the trojan `POST /__aio/trojan/dispatch`, and an in-process call — against a
// main-isolate cell and a `worker: true` cell, persisted to a real state.db.
//
// Siblings pin one door against in-process (transport-differential,
// seam-method-differential, worker-cell-refusal-ack-parity); none ran the
// doors CONCURRENTLY, none restarted, none closed the app mid-program. Checked
// against a reference model, not against each other:
//   · every call settles exactly once, with the outcome its method implies
//     (throw → ok:false, validate refusal → ACTION_REFUSED, else ok:true),
//     and a return value arrives intact (unicode, NUL, U+2028, 5 KB);
//   · each write lands exactly once; `n` is the sum of the applied `inc`s;
//   · each ORDERED door (WS, UDS) applies its sync calls in send order;
//   · a restart restores exactly the state that was acked;
//   · closing the app mid-program loses no ACKED write, and applies no call
//     the door refused with DISPATCH_DRAINING.
import { assert, assertEquals } from "@std/assert";
import { dec, enc } from "../src/protocol/envelope.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { connectLocal } from "../src/server/local-listen.ts";
import { resolveSocketPath } from "../src/server/paths.ts";
import { unrunnableElectron } from "./unrunnable-electron.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
type Op = { cid: string; door: string; m: string; a: unknown[]; at: number };

function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WRITES = new Set(["inc", "slow", "uni", "throwAsync"]);

function program(seed: number): Op[] {
  const R = rng(seed);
  const ops: Op[] = [];
  for (let i = 0; i < 120; i++) {
    const door = ["ws", "uds", "trojan", "proc"][Math.floor(R() * 4)]!;
    const tag = `${door}#${i}`;
    const pick = Math.floor(R() * 8);
    const [m, a]: [string, unknown[]] = pick === 0
      ? ["slow", [Math.floor(R() * 15), tag]]
      : pick === 1
      ? ["chain", [tag]]
      : pick === 2
      ? ["throwSync", [tag]]
      : pick === 3
      ? ["throwAsync", [tag]]
      : pick === 4
      ? ["refuse", [tag]]
      : pick === 5
      ? ["uni", ["é😀\u0000 " + "z".repeat(Math.floor(R() * 5000)), tag]]
      : pick === 6
      ? ["retU", []]
      : ["inc", [1 + Math.floor(R() * 9), tag]];
    ops.push({ cid: `c${i}`, door, m, a, at: i >> 2 });
  }
  return ops;
}

async function run(worker: boolean, closeAt: number | null): Promise<void> {
  const dir = await tempDir("aio-xdoor-");
  // A local electron app speaks UDS and (with a named port) WS. No display →
  // no window is launched; elsewhere the launch stops at an unrunnable binary.
  const saved = ["DISPLAY", "WAYLAND_DISPLAY", "ELECTRON_PATH"].map(
    (k) => [k, Deno.env.get(k)] as const,
  );
  Deno.env.delete("DISPLAY");
  Deno.env.delete("WAYLAND_DISPLAY");
  Deno.env.set("ELECTRON_PATH", await unrunnableElectron(dir));
  await Deno.writeTextFile(
    `${dir}/App.tsx`,
    "export default function App() { return <div>Hi</div>; }\n",
  );
  const { aio, cell } = await import("../mod.ts");
  const { _resetAioRuntime } = await import("../src/state/runtime-reset.ts");
  const id = worker ? "xdoorw" : "xdoorm";
  const mk = (): Any =>
    cell(id, {
      ...(worker ? { worker: true } : {}),
      state: { n: 0, log: [] as string[], bad: false },
      methods: {
        inc(s: Any, by: number, tag: string) {
          s.n += by;
          s.log.push(tag);
          return s.n;
        },
        async slow(s: Any, ms: number, tag: string) {
          await new Promise((r) => setTimeout(r, ms));
          s.log.push(tag);
          return { tag };
        },
        async chain(s: Any, tag: string) {
          s.log.push(tag + "<");
          await new Promise((r) => setTimeout(r, 3));
          s.log.push(tag + ">");
          return null;
        },
        throwSync(_s: Any, _tag: string) {
          throw new Error("sync boom");
        },
        async throwAsync(s: Any, tag: string) {
          s.log.push(tag);
          await new Promise((r) => setTimeout(r, 2));
          throw new Error("async boom");
        },
        refuse(s: Any, _tag: string) {
          s.bad = true;
        },
        uni(s: Any, v: string, tag: string) {
          s.log.push(tag);
          return v;
        },
        retU(_s: Any) {
          return undefined;
        },
      },
      validate: (s: Any) => !s.bad || "bad",
    } as Any);
  const appId = `xdoor-${worker ? "w" : "m"}-${Deno.pid}`;
  const port = freePort();
  const boot = (c: Any): Promise<Any> =>
    aio.run({
      cells: [c],
      appId,
      client: "electron",
      persist: true,
      libraryMode: true,
      singleton: false,
      watch: false,
      port,
      baseDir: dir,
      appDir: dir,
      dbPath: `${dir}/state.db`,
    } as Any) as Promise<Any>;
  _resetAioRuntime();
  const box = mk();
  const app = await boot(box);
  let app2: Any;
  const acks = new Map<string, Any[]>();
  const note = (cid: string, d: Any) =>
    acks.set(cid, [...(acks.get(cid) ?? []), d]);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const conn = await connectLocal(resolveSocketPath(appId));
  const udsW = conn.writable.getWriter();
  let reading: Promise<void> | undefined;
  try {
    await new Promise<void>((r, j) => {
      ws.onopen = () => r();
      ws.onerror = () => j(new Error("ws never opened"));
    });
    ws.onmessage = (ev) => {
      const f = dec(String(ev.data)) as Any;
      if (f?.t === "ack") note(f.d.cid, f.d);
    };
    reading = (async () => {
      const r = conn.readable.getReader();
      const td = new TextDecoder();
      let buf = "";
      try {
        while (true) {
          const { value, done } = await r.read();
          if (done) break;
          buf += td.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const f = dec(buf.slice(0, i)) as Any;
            buf = buf.slice(i + 1);
            if (f?.t === "ack") note(f.d.cid, f.d);
          }
        }
      } catch { /* closed */ }
    })();
    const frame = (o: Op) =>
      enc("action", {
        type: `${id}:${o.m}`,
        payload: { args: o.a },
        cid: o.cid,
      });
    const doors: Record<string, (o: Op) => Promise<void>> = {
      ws: (o) => Promise.resolve(ws.send(frame(o))),
      uds: (o) => udsW.write(new TextEncoder().encode(frame(o) + "\n")),
      trojan: async (o) => {
        const r = await fetch(
          `http://127.0.0.1:${port}/__aio/trojan/dispatch`,
          {
            method: "POST",
            headers: { "x-aio": "1", "content-type": "application/json" },
            body: JSON.stringify({
              type: `${id}:${o.m}`,
              payload: { args: o.a },
            }),
          },
        );
        const b = await r.json();
        note(o.cid, { ...b, ok: b.ok === true, value: b.result });
      },
      proc: async (o) => {
        try {
          note(o.cid, { ok: true, value: await box[o.m](...o.a) });
        } catch (e) {
          note(o.cid, { ok: false, code: (e as Any).code });
        }
      },
    };
    const ops = program(worker ? 7 : 3);
    const sent = ops.map((o) =>
      sleep(o.at).then(() => doors[o.door]!(o)).catch(() => {
        // aio-ok: a door closed under the call (closeAt) — it never settles,
        // which the close-mode checks below allow for.
      })
    );
    const closing = closeAt === null
      ? undefined
      : sleep(closeAt).then(() => app.close());
    await Promise.all(sent);
    const until = Date.now() + 8_000;
    while (
      closeAt === null && Date.now() < until &&
      ops.some((o) => !acks.has(o.cid))
    ) await sleep(20);
    await sleep(100);
    await (closing ?? app.close());

    _resetAioRuntime();
    const box2 = mk();
    app2 = await boot(box2);
    const log: string[] = [...box2.log];
    const tagOf = (o: Op) => o.a[o.a.length - 1] as string;
    const problems: string[] = [];
    for (const o of ops) {
      const got = acks.get(o.cid) ?? [];
      const g = got[0];
      if (got.length > 1 || (closeAt === null && got.length !== 1)) {
        problems.push(`${o.cid} ${o.door} ${o.m} settled ${got.length}x`);
      }
      const applied = (t: string) => log.filter((x) => x === t).length;
      if (WRITES.has(o.m)) {
        const c = applied(tagOf(o));
        if (c > 1) problems.push(`${o.cid} ${o.door} ${o.m} applied ${c}x`);
        if (g?.ok === true && c !== 1) {
          problems.push(`${o.cid} ${o.door} ${o.m} ACKED but not restored`);
        }
        if (g?.code === "DISPATCH_DRAINING" && c > 0) {
          problems.push(
            `${o.cid} ${o.door} ${o.m} refused at the door yet ran`,
          );
        }
      }
      if (closeAt !== null) continue;
      if (o.m === "refuse" && o.door === "proc") continue; // documented: resolves
      const want = !["throwSync", "throwAsync", "refuse"].includes(o.m);
      if ((g?.ok === true) !== want) {
        problems.push(`${o.cid} ${o.door} ${o.m} ${JSON.stringify(g)}`);
      }
      if (o.m === "refuse" && g?.code !== "ACTION_REFUSED") {
        problems.push(`${o.cid} ${o.door} refuse code ${g?.code}`);
      }
      if (o.m === "uni" && g?.value !== o.a[0]) {
        problems.push(`${o.cid} ${o.door} uni return value altered`);
      }
      if (
        o.m === "chain" &&
        applied(tagOf(o) + "<") + applied(tagOf(o) + ">") !== 2
      ) {
        problems.push(`${o.cid} ${o.door} chain did not run whole`);
      }
    }
    const n = ops.filter((o) => o.m === "inc" && log.includes(tagOf(o)))
      .reduce((t, o) => t + (o.a[0] as number), 0);
    if (box2.n !== n) problems.push(`n=${box2.n}, applied incs sum to ${n}`);
    if (closeAt === null) {
      for (const d of ["ws", "uds"]) {
        const sync = ops.filter((o) =>
          o.door === d && (o.m === "inc" || o.m === "uni")
        ).sort((x, y) => x.at - y.at).map(tagOf);
        const seen = log.filter((t) => sync.includes(t));
        if (seen.join() !== sync.join()) {
          problems.push(`${d} reordered: ${seen.join()} vs ${sync.join()}`);
        }
      }
    }
    if (closeAt !== null) {
      // The instrument's own control: the close really cut the program —
      // some calls ran and were acked, some met the draining door.
      const all = [...acks.values()].flat();
      assert(all.some((g) => g.ok === true), "no call was acked before close");
      assert(
        all.some((g) => g.code === "DISPATCH_DRAINING"),
        "no call met the draining door — the close missed the program",
      );
    }
    assertEquals(problems, []);
  } finally {
    try {
      ws.close();
    } catch { /* closed */ }
    try {
      conn.close();
    } catch { /* closed */ }
    await reading;
    await app.close().catch(() => {});
    await app2?.close();
    _resetAioRuntime();
    for (const [k, v] of saved) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    await dropTempDir(dir);
  }
}

for (const worker of [false, true]) {
  const kind = worker ? "worker cell" : "main cell";
  // aio-ok: run() asserts the model diff (assertEquals(problems, []))
  Deno.test(`cross-door (${kind}): concurrent doors agree with the model, and a restart restores what was acked`, () =>
    run(worker, null));
  // aio-ok: run() asserts the model diff and that the close cut in
  Deno.test(`cross-door (${kind}): closing mid-program loses no acked write and runs no door-refused call`, () =>
    run(worker, 12));
}
