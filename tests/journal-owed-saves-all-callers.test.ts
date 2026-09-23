// What a write's commit owes (a stand-in save for a journal line it could not
// write) is owed to EVERY caller, not only the network doors (review rev10):
//
//  1. An in-process caller — a route, an effect, a serverFn awaiting
//     `cell.method()` — was answered before the save: a SIGKILL right after
//     the route replied lost the write (12 in 24). The wait now sits in
//     dispatch and in the async call's settlement: one place, all callers.
//  2. A stand-in save that FAILED was acked `ok: true` on the WebSocket while
//     the trojan said `unsaved`. Every door now carries the same `unsaved`
//     sentence (the call ran; what it wrote is not on disk): the WS ack for a
//     sync and an async call, the trojan reply, the `sync-ack`.
//  3. A sync op sent while time travel is PAUSED was refused for good
//     (`op-rejected`, and the client dropped it — "resume to dispatch again"
//     was false for it). It is held: `sync-err`, no ack, no refusal — the
//     client re-sends it with its next catch-up, which lands after resume.
import { assert, assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

const CHILD = `
import { aio, cell } from "${MOD}";
const DIR = Deno.env.get("DIR");
const PORT = Number(Deno.env.get("PORT"));
const PHASE = Deno.env.get("PHASE");
const MODE = Deno.env.get("MODE");
const J = DIR + "/data/journal";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (PHASE === "read") {
  try { Deno.removeSync(J); Deno.renameSync(J + ".save", J); } catch { /* not swapped */ }
}
const BIG = Array.from({ length: 20000 }, (_, i) => "x".repeat(90) + i);
const notes = cell("notes", { sync: true, version: 1, state: { items: [] },
  methods: { add(s, t) { s.items.push(t); } } });
const kv = cell("kv", {
  state: { big: BIG, items: [] },
  // The store refuses anything holding "BAD" (honest mode only).
  onPersist: (s) => {
    if (MODE === "honest" && PHASE === "go" && s.items.some((t) => t.startsWith("BAD"))) {
      throw new Error("disk says no");
    }
    return s;
  },
  methods: {
    add(s, t) { s.items.push(t); },
    async addA(s, t) { await sleep(MODE === "honest" ? 80 : 1); s.items.push(t); },
    onNote(s, t) { s.items.push("n:" + t); },
  },
  listensTo: { onNote: notes.add },
});
const app = await aio.run({
  cells: [notes, kv],
  routes: {
    "/w": async () => { await kv.add("R1"); return new Response("ok"); },
    "/wa": async () => { await kv.addA("R2"); return new Response("ok"); },
  },
  appId: "journal-owed-saves",
  client: "server-only",
  journal: true,
  persistDebounceMs: 999999,
  port: PORT,
  appDir: DIR,
});
const snap = () => ({ notes: app.getState().notes.items, kv: app.getState().kv.items });
if (PHASE === "read") {
  Deno.writeTextFileSync(DIR + "/recovered.json", JSON.stringify(snap()));
  Deno.exit(0);
}
const base = "http://127.0.0.1:" + PORT;
const trojan = (path, body) => fetch(base + "/__aio/trojan/" + path, { method: "POST",
  headers: { "Content-Type": "application/json", "X-AIO": "1" }, body: JSON.stringify(body) })
  .then((r) => r.json());
const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/ws");
const frames = [];
ws.onmessage = (e) => { try { frames.push(JSON.parse(e.data)); } catch { /* not a frame */ } };
await new Promise((r) => (ws.onopen = r));
const waitFor = async (pred, what) => {
  const t0 = Date.now();
  while (!frames.some(pred)) {
    if (Date.now() - t0 > 5000) throw new Error("never: " + what);
    await sleep(1);
  }
  return frames.find(pred);
};
let n = 0;
const call = (type, arg) => {
  const cid = "c" + (++n);
  ws.send(JSON.stringify({ v: 2, t: "action", d: { type, payload: { args: [arg] }, cid } }));
  return waitFor((f) => f.t === "ack" && f.d.cid === cid, "ack " + cid).then((f) => f.d);
};
const op = (id, t) => {
  ws.send(JSON.stringify({ v: 2, t: "op", d: { id, hlc: [Date.now(), ++n, "c1"],
    cell: "notes", action: "add", payload: { args: [t] } } }));
};
const out = {};
await call("kv:add", "a1");
const refuseAppends = () => {
  Deno.renameSync(J, J + ".save");
  Deno.mkdirSync(J); // every append refused: saves stand in for the lines
};
if (MODE === "route") refuseAppends();
if (MODE === "route") {
  await fetch(base + "/w", { method: "POST" }).then((r) => r.text());
  await fetch(base + "/wa", { method: "POST" }).then((r) => r.text());
} else if (MODE === "honest") {
  // An async call whose CALL line lands and whose write-set's does not: the
  // failed save is owed to the call, not to the frame the ack answers.
  const pending = call("kv:addA", "BAD2");
  await sleep(20);
  refuseAppends();
  out.wsAsync = await pending;
  out.ws = await call("kv:add", "BAD1");
  out.trojan = await trojan("dispatch", { type: "kv:add", payload: { args: ["BAD3"] } });
  op("s1", "BAD4");
  out.syncAck = (await waitFor((f) => f.t === "sync-ack" && f.d.opId === "s1", "sync-ack")).d;
} else if (MODE === "paused") {
  await trojan("tt", { cmd: "pause" });
  op("h1", "held");
  out.held = (await waitFor((f) => f.t === "sync-err", "sync-err")).d;
  // A reconnecting client's offline queue, while paused: held the same way.
  ws.send(JSON.stringify({ v: 2, t: "sync-req", d: { clientId: "c1", reqId: 1,
    cells: { notes: { lastHlc: null } },
    pendingOps: [{ id: "h2", hlc: [Date.now(), ++n, "c1"], cell: "notes", action: "add", payload: { args: ["queued"] } }] } }));
  await waitFor((f) => f.t === "sync-err" && f !== frames.find((g) => g.t === "sync-err"), "second sync-err");
  await sleep(100);
  out.whilePaused = { notes: snap().notes, rejected: frames.filter((f) => f.t === "op-rejected").length,
    acked: frames.filter((f) => f.t === "sync-ack").length };
  await trojan("tt", { cmd: "resume" });
  // What the client's engine does on sync-err: re-request, pending ops in.
  ws.send(JSON.stringify({ v: 2, t: "sync-req", d: { clientId: "c1", reqId: 2,
    cells: { notes: { lastHlc: null } },
    pendingOps: [
      { id: "h1", hlc: [Date.now(), ++n, "c1"], cell: "notes", action: "add", payload: { args: ["held"] } },
      { id: "h2", hlc: [Date.now(), ++n, "c1"], cell: "notes", action: "add", payload: { args: ["queued"] } },
    ] } }));
  out.ack = (await waitFor((f) => f.t === "sync-ack" && f.d.opId === "h2", "ack after resume")).d;
}
Deno.writeTextFileSync(DIR + "/out.json", JSON.stringify(out));
Deno.writeTextFileSync(DIR + "/expected.json", JSON.stringify(snap()));
Deno.kill(Deno.pid, "SIGKILL");
`;

async function run(dir: string, phase: string, mode: string): Promise<string> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, join(dir, "app.ts")],
    env: {
      DIR: dir,
      PORT: String(freePort()),
      AIO_APPS_DIR: dir,
      PHASE: phase,
      MODE: mode,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
  if (phase === "read" && !out.success) throw new Error(text);
  return text;
}

async function go(mode: string) {
  const dir = await tempDir(`aio-owed-saves-${mode}-`);
  try {
    await Deno.writeTextFile(join(dir, "app.ts"), CHILD);
    const log = await run(dir, "go", mode);
    const read = async (f: string) =>
      JSON.parse(
        await Deno.readTextFile(join(dir, f)).catch(() => {
          throw new Error(`${mode}: the child never reached its kill:\n${log}`);
        }),
      );
    const out = await read("out.json");
    const expected = await read("expected.json");
    await run(dir, "read", mode);
    const recovered = await read("recovered.json");
    return { out, expected, recovered, log };
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("owed saves: a route awaiting a call is answered after the call's save — a kill at the reply keeps it", async () => {
  for (let i = 0; i < 3; i++) {
    const { expected, recovered } = await go("route");
    assertEquals(expected.kv, ["a1", "R1", "R2"], "live");
    assertEquals(recovered, expected, `run ${i}`);
  }
});

Deno.test("owed saves: a stand-in save that failed is `unsaved` at every door, alike", async () => {
  const { out } = await go("honest");
  const said = /^persist failed: \S/;
  assert(out.ws.ok, JSON.stringify(out.ws));
  assertMatch(String(out.ws.unsaved), said, JSON.stringify(out.ws));
  assert(out.wsAsync.ok, JSON.stringify(out.wsAsync));
  assertMatch(String(out.wsAsync.unsaved), said, JSON.stringify(out.wsAsync));
  assert(out.trojan.ok, JSON.stringify(out.trojan));
  assertMatch(String(out.trojan.unsaved), said, JSON.stringify(out.trojan));
  assertMatch(String(out.syncAck.unsaved), said, JSON.stringify(out.syncAck));
});

Deno.test("owed saves: a sync op sent while time travel is paused is held, then lands", async () => {
  const { out, expected, recovered } = await go("paused");
  assertMatch(String(out.held.reason), /time travel is paused .*held/);
  assertEquals(out.whilePaused, { notes: [], rejected: 0, acked: 0 });
  assertEquals(out.ack.opId, "h2");
  assertEquals(expected.notes, ["held", "queued"]);
  assertEquals(recovered.notes, ["held", "queued"]);
});
