// A sync op the server cannot apply RIGHT NOW is held, never refused (hunt
// round 2, area A). Refused (`op-rejected`), the client prunes the edit.
//
//  1. SHUTDOWN: dispatch closes first (the drain), the sockets last. An op
//     arriving in between was persisted, refused DISPATCH_CLOSED, deleted and
//     refused for good — every deploy/restart lost the edits in flight (and
//     the log blamed "your onStop hook"). Now held: `sync-err`, the client
//     keeps it and resends it to the NEXT server, where it lands. End to end:
//     real process, real restart, same data dir.
//  2. TIME TRAVEL paused while a burst is queued on the cell lock: the door's
//     check had passed for ops already queued, so they met the pause at
//     dispatch — 86 of 90 refused for good. The check now runs under the
//     lock, right before the persist (and a refusal of that kind is held too).
import { assert, assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import { cell } from "../mod.ts";
import { freePort, testServer } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

const CHILD = `
import { aio, cell } from "${MOD}";
const DIR = Deno.env.get("DIR");
const PORT = Number(Deno.env.get("PORT"));
const PHASE = Deno.env.get("PHASE");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stopping = () => {};
const inStop = new Promise((r) => (stopping = r));
const notes = cell("notes", { sync: true, version: 1, state: { items: [] },
  methods: { add(s, t) { s.items.push(t); } } });
const app = await aio.run({ cells: [notes], appId: "sync-held-shutdown",
  client: "server-only", port: PORT, appDir: DIR,
  onStop: async () => { stopping(); await sleep(600); } });
const items = () => app.getState().notes.items;
if (PHASE === "read") {
  Deno.writeTextFileSync(DIR + "/read.json", JSON.stringify(items()));
  await app.close();
  Deno.exit(0);
}
const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/ws");
const frames = [];
ws.onmessage = (e) => { try { frames.push(JSON.parse(e.data)); } catch { /* not a frame */ } };
await new Promise((r) => (ws.onopen = r));
const opB = { id: "c1-s-2", hlc: [Date.now(), 2, "c1"], cell: "notes", action: "add", payload: { args: ["b"] } };
const until = async (pred, what) => {
  const t0 = Date.now();
  while (!frames.some(pred)) { if (Date.now() - t0 > 5000) throw new Error("never: " + what); await sleep(2); }
};
if (PHASE === "stop") {
  ws.send(JSON.stringify({ v: 2, t: "op", d: { id: "c1-s-1", hlc: [Date.now(), 1, "c1"], cell: "notes",
    action: "add", payload: { args: ["a"] } } }));
  await until((f) => f.t === "sync-ack" && f.d.opId === "c1-s-1", "ack a");
  const closing = app.close();
  await inStop; // dispatch is closed, the socket is still open
  ws.send(JSON.stringify({ v: 2, t: "op", d: opB }));
  await sleep(300);
  Deno.writeTextFileSync(DIR + "/stop.json", JSON.stringify(frames.filter((f) =>
    ["sync-err", "op-rejected", "sync-ack"].includes(f.t)).map((f) => [f.t, f.d.opId ?? null, f.d.reason ?? null])));
  await closing;
  Deno.exit(0);
}
// PHASE === "resend": what the client does on reconnect — its catch-up
// carries the op it still holds.
ws.send(JSON.stringify({ v: 2, t: "sync-req", d: { clientId: "c1", session: "s", reqId: 1,
  cells: { notes: { lastHlc: null } }, pendingOps: [opB] } }));
await until((f) => f.t === "sync-ack" && f.d.opId === opB.id, "ack b after restart");
Deno.writeTextFileSync(DIR + "/resend.json", JSON.stringify(items()));
await app.close();
Deno.exit(0);
`;

async function run(dir: string, phase: string): Promise<string> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, join(dir, "app.ts")],
    env: {
      DIR: dir,
      PORT: String(freePort()),
      AIO_APPS_DIR: dir,
      PHASE: phase,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
  if (!out.success) throw new Error(`${phase} failed:\n${text}`);
  return text;
}

Deno.test("sync: an op arriving during shutdown is held, resent to the next server, and lands", async () => {
  const dir = await tempDir("aio-sync-held-shutdown-");
  try {
    await Deno.writeTextFile(join(dir, "app.ts"), CHILD);
    const stopLog = await run(dir, "stop");
    const read = async (f: string) =>
      JSON.parse(await Deno.readTextFile(join(dir, f)));
    const stop = await read("stop.json") as [string, string | null, string][];
    assertEquals(
      stop.filter(([t]) => t === "op-rejected"),
      [],
      "never refused",
    );
    const err = stop.find(([t]) => t === "sync-err");
    assert(err, JSON.stringify(stop));
    assertMatch(err[2], /shutting down .*held/);
    assert(
      !/came from your `onStop` hook/.test(stopLog),
      "a client's op is not the onStop hook's doing",
    );
    await run(dir, "resend");
    assertEquals(await read("resend.json"), ["a", "b"]);
    await run(dir, "read");
    assertEquals(await read("read.json"), ["a", "b"], "durable after restart");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("sync: ops queued on the cell lock when time travel pauses are held, not refused", async () => {
  const notes = cell("notes", {
    sync: true,
    state: { items: [] as string[] },
    methods: {
      add(s: { items: string[] }, t: string) {
        s.items.push(t);
      },
    },
  });
  const srv = await testServer({ cells: [notes] });
  const ws = new WebSocket(srv.url.replace("http", "ws") + "/ws");
  try {
    const frames: { t: string; d: { opId?: string } }[] = [];
    ws.onmessage = (e) => {
      try {
        const f = JSON.parse(e.data);
        if (["sync-ack", "op-rejected", "sync-err"].includes(f.t)) {
          frames.push(f);
        }
      } catch { /* not a frame */ }
    };
    await new Promise((r) => (ws.onopen = r));
    const N = 90;
    for (let i = 0; i < N; i++) {
      ws.send(JSON.stringify({
        v: 2,
        t: "op",
        d: {
          id: "o" + i,
          hlc: [Date.now(), i, "c1"],
          cell: "notes",
          action: "add",
          payload: { args: ["o" + i] },
        },
      }));
    }
    const t0 = Date.now();
    while (frames.length < 3 && Date.now() - t0 < 5000) {
      await new Promise((r) => setTimeout(r, 1));
    }
    const tt = (cmd: string) =>
      fetch(srv.url + "/__aio/trojan/tt", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-AIO": "1" },
        body: JSON.stringify({ cmd }),
      }).then((r) => r.text());
    await tt("pause");
    // Settled: nothing new for 300 ms.
    for (let last = -1; last !== frames.length;) {
      last = frames.length;
      await new Promise((r) => setTimeout(r, 300));
    }
    const count = (t: string) => frames.filter((f) => f.t === t).length;
    assertEquals(count("op-rejected"), 0, "none refused");
    assert(count("sync-ack") < N, "the pause landed mid-burst");
    // ONE held `sync-err` for the socket until it asks again: a client with a
    // retry loop per frame (v1.0.9) would otherwise run one loop per op.
    assertEquals(count("sync-err"), 1);
    // Resume, and resend the held ones — they land.
    await tt("resume");
    const acked = new Set(
      frames.filter((f) => f.t === "sync-ack").map((f) => f.d.opId),
    );
    const heldIds = [...Array(N).keys()].map((i) => "o" + i).filter((id) =>
      !acked.has(id)
    );
    ws.send(JSON.stringify({
      v: 2,
      t: "sync-req",
      d: {
        clientId: "c1",
        reqId: 1,
        cells: { notes: { lastHlc: null } },
        pendingOps: heldIds.map((id) => ({
          id,
          hlc: [Date.now(), Number(id.slice(1)), "c1"],
          cell: "notes",
          action: "add",
          payload: { args: [id] },
        })),
      },
    }));
    const t2 = Date.now();
    while (count("sync-ack") < N && Date.now() - t2 < 5000) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assertEquals(count("sync-ack"), N, "every op landed");
  } finally {
    ws.close();
    await srv.close();
  }
});
