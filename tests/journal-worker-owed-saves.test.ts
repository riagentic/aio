// A `worker: true` cell's call is answered after what its commits owe is
// durable — and says so when it is not (review rev11).
//
// A worker cell's method runs in its own isolate; its commits come home as
// patch batches the pool dispatched fire-and-forget, and the call was answered
// on the worker's `done`. With the journal refusing appends, a batch's line is
// replaced by a stand-in save — which the reply did not wait for: a SIGKILL at
// the reply lost the write, and a stand-in save that FAILED was acked `ok`.
// The pool now waits for the call's batches and carries their verdict: the
// same `unsaved` sentence every other door says
// (tests/journal-owed-saves-all-callers.test.ts).
//
// Real worker (the child's entry hosts it), real SIGKILL, real disk.
import { assert, assertEquals, assertMatch } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { spec } from "./module-spec-helper.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = fromFileUrl(new URL("../deno.json", import.meta.url));

// Inside the worker `aio.run()` never resolves, so the phase code below it
// runs on the main isolate only.
const CHILD = `
import { aio, cell } from "${spec(MOD)}";
const DIR = Deno.env.get("DIR");
const PORT = Number(Deno.env.get("PORT"));
const PHASE = Deno.env.get("PHASE");
const MODE = Deno.env.get("MODE");
const J = DIR + "/data/journal";
if (PHASE === "read") {
  try { Deno.removeSync(J); Deno.renameSync(J + ".save", J); } catch { /* not swapped */ }
}
// Big enough that a save takes a while: a reply that does not wait for it
// is answered — and killed — first.
const BIG = Array.from({ length: 20000 }, (_, i) => "x".repeat(90) + i);
// A userland serial queue (the p-queue shape): a job runs from whichever
// call's continuation drains it, not from the call that queued it.
const jobs = [];
let draining = false;
const queued = (job) => new Promise((done) => {
  jobs.push(async () => { await job(); done(); });
  if (draining) return;
  draining = true;
  (async () => {
    for (let j; (j = jobs.shift());) { await new Promise((r) => setTimeout(r, 3)); await j(); }
    draining = false;
  })();
});
export const wk = cell("wk", {
  worker: true,
  concurrency: { addFirst: "first" },
  state: { big: BIG, items: [] },
  // The store refuses anything holding "BAD" (honest mode only).
  onPersist: (s) => {
    if (MODE !== "kill" && PHASE === "go" && s.items.some((t) => t.startsWith("BAD"))) {
      throw new Error("disk says no");
    }
    return s;
  },
  methods: {
    add(s, t) { s.items.push(t); },
    // Its write ships at the await, and its save is over long before the
    // call ends: the reply must still carry that save's verdict.
    async addSlow(s, t) {
      s.items.push(t);
      await new Promise((r) => setTimeout(r, 400));
    },
    // In flight, and writes nothing.
    async idle() {
      await new Promise((r) => setTimeout(r, 600));
      return "idle";
    },
    // Written from inside the shared queue.
    async addQueued(s, t) {
      await queued(() => { s.items.push(t); });
    },
    // One run answers every caller that arrives while it is going.
    async addFirst(s, t) {
      await new Promise((r) => setTimeout(r, 25));
      s.items.push(t);
    },
    // An async body's own write-set.
    async addAsync(s, t) {
      await new Promise((r) => setTimeout(r, 20));
      s.items.push(t);
    },
  },
});
await aio.run({
  cells: [wk],
  appId: "journal-worker-owed-saves",
  client: "server-only",
  journal: true,
  persistDebounceMs: 999999,
  port: PORT,
  appDir: DIR,
});
if (PHASE === "read") {
  Deno.writeTextFileSync(DIR + "/recovered.json", JSON.stringify(wk.items));
  Deno.exit(0);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = "http://127.0.0.1:" + PORT;
const trojan = (t) => fetch(base + "/__aio/trojan/dispatch", { method: "POST",
  headers: { "Content-Type": "application/json", "X-AIO": "1" },
  body: JSON.stringify({ type: "wk:add", payload: { args: [t] } }) }).then((r) => r.json());
const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/ws");
const frames = [];
ws.onmessage = (e) => { try { frames.push(JSON.parse(e.data)); } catch { /* not a frame */ } };
await new Promise((r) => (ws.onopen = r));
let n = 0;
const call = async (t, type = "wk:add") => {
  const cid = "c" + (++n);
  ws.send(JSON.stringify({ v: 2, t: "action", d: { type, payload: { args: [t] }, cid } }));
  const t0 = Date.now();
  for (;;) {
    const f = frames.find((f) => f.t === "ack" && f.d.cid === cid);
    if (f) return f.d;
    if (Date.now() - t0 > 5000) throw new Error("never acked " + cid);
    await sleep(1);
  }
};
const out = {};
out.first = await trojan("a1"); // the journal's first line lands normally
Deno.renameSync(J, J + ".save");
Deno.mkdirSync(J); // every append refused: saves stand in for the lines
if (MODE === "kill") {
  out.trojan = await trojan("T1");
  out.ws = await call("W1");
  out.wsSlow = await call("W2", "wk:addSlow");
} else if (MODE === "whose") {
  // A call in flight on the cell while each failing save is made; only the
  // calls that WROTE are told.
  const idle = call("x", "wk:idle");
  out.sync = await call("BAD1");
  out.async = await call("BAD2", "wk:addAsync");
  out.idle = await idle;
} else if (MODE === "prop") {
  // Every save fails from here on (the slice holds BAD0): each call below
  // either wrote or is answered with a run that did.
  out.bad = await call("BAD0");
  let seed = Number(Deno.env.get("SEED"));
  // Math.imul and the high bits: the plain product passes 2^53 and its low
  // bits are then always 0.
  const rnd = (n) => ((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) >>> 12) % n;
  const kinds = ["wk:add", "wk:addAsync", "wk:addSlow", "wk:addQueued", "wk:addFirst"];
  out.calls = [];
  for (let round = 0; round < 6; round++) {
    await Promise.all(Array.from({ length: 12 }, async (_, i) => {
      const type = kinds[rnd(kinds.length)];
      const wait = rnd(30);
      await sleep(wait);
      const d = await call("r" + round + "." + i, type);
      out.calls.push({ type, wait, round, ok: d.ok, unsaved: d.unsaved ?? null });
    }));
  }
} else {
  out.trojan = await trojan("BAD1");
  out.ws = await call("BAD2");
  out.wsSlow = await call("BAD3", "wk:addSlow");
}
Deno.writeTextFileSync(DIR + "/out.json", JSON.stringify(out));
Deno.writeTextFileSync(DIR + "/expected.json", JSON.stringify(wk.items));
Deno.kill(Deno.pid, "SIGKILL");
`;

async function run(
  dir: string,
  phase: string,
  mode: string,
  seed = 0,
): Promise<string> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, join(dir, "app.ts")],
    env: {
      DIR: dir,
      PORT: String(freePort()),
      AIO_APPS_DIR: dir,
      PHASE: phase,
      MODE: mode,
      SEED: String(seed),
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
  if (phase === "read" && !out.success) throw new Error(text);
  return text;
}

async function go(mode: string, seed = 0) {
  const dir = await tempDir(`aio-worker-owed-${mode}-`);
  try {
    await Deno.writeTextFile(join(dir, "app.ts"), CHILD);
    const log = await run(dir, "go", mode, seed);
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
    return { out, expected, recovered };
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("worker cell: a call is answered after its batches' stand-in save — a kill at the reply keeps it", async () => {
  for (let i = 0; i < 3; i++) {
    const { out, expected, recovered } = await go("kill");
    assert(out.trojan.ok && out.ws.ok && out.wsSlow.ok, JSON.stringify(out));
    // The trojan reply always carries the key (`null`: nothing unsaved).
    assertEquals(out.trojan.unsaved, null, JSON.stringify(out));
    assertEquals(out.ws.unsaved, undefined, JSON.stringify(out));
    assertEquals(out.wsSlow.unsaved, undefined, JSON.stringify(out));
    assertEquals(expected, ["a1", "T1", "W1", "W2"], "live");
    assertEquals(recovered, expected, `run ${i}`);
  }
});

Deno.test("worker cell: a failed stand-in save is `unsaved` on the call's reply, trojan and WS alike", async () => {
  const { out } = await go("honest");
  const said = /^persist failed: \S/;
  assert(out.trojan.ok, JSON.stringify(out.trojan));
  assertMatch(String(out.trojan.unsaved), said, JSON.stringify(out.trojan));
  assert(out.ws.ok, JSON.stringify(out.ws));
  assertMatch(String(out.ws.unsaved), said, JSON.stringify(out.ws));
  // A save that ended before the call did: its verdict was dropped (the
  // batch left the pool's set as it settled), and the call read as saved.
  assert(out.wsSlow.ok, JSON.stringify(out.wsSlow));
  assertMatch(String(out.wsSlow.unsaved), said, JSON.stringify(out.wsSlow));
});

Deno.test("worker cell: a failed save is `unsaved` on the calls that wrote the batch — a call in flight that wrote nothing is not told", async () => {
  const { out, expected } = await go("whose");
  const said = /^persist failed: \S/;
  assertEquals(expected, ["a1", "BAD1", "BAD2"], "live");
  for (const k of ["sync", "async"]) {
    assert(out[k].ok, JSON.stringify(out));
    assertMatch(String(out[k].unsaved), said, `${k}: ${JSON.stringify(out)}`);
  }
  assert(out.idle.ok, JSON.stringify(out.idle));
  assertEquals(out.idle.unsaved, undefined, JSON.stringify(out));
});

// The property behind naming a batch's calls: fewer calls are told, never a
// wrong one. Seeded interleavings of every way a worker call writes — its own
// reduce, an async body's write-set (before and after an await), a write a
// shared userland queue runs from ANOTHER call's continuation, and a call
// answered with another call's run (`concurrency: "first"`).
Deno.test("worker cell: under any interleaving, no call that wrote a batch whose save failed — or is answered with the run that did — is told it was saved", async () => {
  const seed = Number(Deno.env.get("AIO_TEST_SEED")) ||
    Math.floor(Math.random() * 2 ** 31);
  const { out } = await go("prop", seed);
  assertMatch(String(out.bad.unsaved), /^persist failed: \S/);
  assertEquals(out.calls.length, 72);
  const toldSaved = out.calls.filter((c: { unsaved: unknown }) =>
    typeof c.unsaved !== "string"
  );
  assertEquals(
    toldSaved,
    [],
    `seed ${seed} (AIO_TEST_SEED=${seed} replays it)`,
  );
});
