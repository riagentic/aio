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
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

// Inside the worker `aio.run()` never resolves, so the phase code below it
// runs on the main isolate only.
const CHILD = `
import { aio, cell } from "${MOD}";
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
export const wk = cell("wk", {
  worker: true,
  state: { big: BIG, items: [] },
  // The store refuses anything holding "BAD" (honest mode only).
  onPersist: (s) => {
    if (MODE === "honest" && PHASE === "go" && s.items.some((t) => t.startsWith("BAD"))) {
      throw new Error("disk says no");
    }
    return s;
  },
  methods: { add(s, t) { s.items.push(t); } },
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
const call = async (t) => {
  const cid = "c" + (++n);
  ws.send(JSON.stringify({ v: 2, t: "action", d: { type: "wk:add", payload: { args: [t] }, cid } }));
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
} else {
  out.trojan = await trojan("BAD1");
  out.ws = await call("BAD2");
}
Deno.writeTextFileSync(DIR + "/out.json", JSON.stringify(out));
Deno.writeTextFileSync(DIR + "/expected.json", JSON.stringify(wk.items));
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
  const dir = await tempDir(`aio-worker-owed-${mode}-`);
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
    return { out, expected, recovered };
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("worker cell: a call is answered after its batches' stand-in save — a kill at the reply keeps it", async () => {
  for (let i = 0; i < 3; i++) {
    const { out, expected, recovered } = await go("kill");
    assert(out.trojan.ok && out.ws.ok, JSON.stringify(out));
    // The trojan reply always carries the key (`null`: nothing unsaved).
    assertEquals(out.trojan.unsaved, null, JSON.stringify(out));
    assertEquals(out.ws.unsaved, undefined, JSON.stringify(out));
    assertEquals(expected, ["a1", "T1", "W1"], "live");
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
});
