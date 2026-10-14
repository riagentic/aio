// A failed save of a PLAIN client action is `unsaved` on that action — and on
// no async call that merely happened to be open.
//
// An action whose author is a guess (a nested call a shared queue ran from
// another call's continuation, tests/journal-owed-saves-whose-write.test.ts)
// owes its failed save to every call open right then. An action that came in
// through a network door is nobody's guess: no call's continuation made it.
// It was owed the same way, so one refused save told every long-running call
// of every client that ITS work was not saved.
import { assertEquals, assertMatch } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { spec } from "./module-spec-helper.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = fromFileUrl(new URL("../deno.json", import.meta.url));

const CHILD = `
import { aio, cell } from "${spec(MOD)}";
const DIR = Deno.env.get("DIR");
const PORT = Number(Deno.env.get("PORT"));
const J = DIR + "/data/journal";
let release;
const gate = new Promise((r) => (release = r));
export const own = cell("own", {
  state: { items: [] },
  // The store refuses anything holding "BAD".
  onPersist: (s) => {
    if (s.items.some((t) => t.startsWith("BAD"))) throw new Error("disk says no");
    return s;
  },
  methods: {
    add(s, t) { s.items.push(t); },
    clean(s) { s.items = s.items.filter((t) => !t.startsWith("BAD")); },
    // Open for as long as the test says; writes nothing.
    async idle() { await gate; return "done"; },
    // Open as long, and writes once the slice is clean again.
    async writes(s, t) { await gate; s.items.push(t); },
    // An async call that ARRIVES while saves fail and writes: its ack must
    // say so, as before.
    async quickWrites(s, t) { await 0; s.items.push(t); },
    // …and one whose write is in its SYNC prefix — the part of an async
    // method that runs with the client's action.
    async prefix(s, t) { s.items.push(t); await 0; },
    release() { release(); },
  },
});
await aio.run({
  cells: [own],
  appId: "journal-owed-saves-plain-action",
  client: "server-only",
  journal: true,
  persistDebounceMs: 999999,
  port: PORT,
  appDir: DIR,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/ws");
const frames = [];
ws.onmessage = (e) => { try { frames.push(JSON.parse(e.data)); } catch { /* not a frame */ } };
await new Promise((r) => (ws.onopen = r));
let n = 0;
const call = async (type, ...args) => {
  const cid = "c" + (++n);
  ws.send(JSON.stringify({ v: 2, t: "action", d: { type, payload: { args }, cid } }));
  const t0 = Date.now();
  for (;;) {
    const f = frames.find((f) => f.t === "ack" && f.d.cid === cid);
    if (f) return f.d;
    if (Date.now() - t0 > 10000) throw new Error("never acked " + cid);
    await sleep(1);
  }
};
const out = {};
out.first = await call("own:add", "a1"); // the journal's first line lands normally
Deno.renameSync(J, J + ".save");
Deno.mkdirSync(J); // every append refused: saves stand in for the lines
const idle = call("own:idle");
const writes = call("own:writes", "w1");
// Both bodies are running (their calls were saved while the slice was clean).
out.probe = await call("own:add", "ok1");
out.bad = await call("own:add", "BAD1"); // the plain action whose save fails
out.quickWrites = await call("own:quickWrites", "w0");
out.clean = await call("own:clean");
out.prefix = await call("own:prefix", "BAD2");
out.clean2 = await call("own:clean");
await call("own:release");
out.idle = await idle;
out.writes = await writes;
Deno.writeTextFileSync(DIR + "/out.json", JSON.stringify(out));
Deno.kill(Deno.pid, "SIGKILL");
`;

Deno.test("owed saves: a plain client action's failed save is its own — an async call open beside it is not told `unsaved`", async () => {
  const dir = await tempDir("aio-owed-plain-");
  try {
    await Deno.writeTextFile(join(dir, "app.ts"), CHILD);
    const res = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--config", CONFIG, join(dir, "app.ts")],
      env: { DIR: dir, PORT: String(freePort()), AIO_APPS_DIR: dir },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const log = new TextDecoder().decode(res.stdout) +
      new TextDecoder().decode(res.stderr);
    const out = JSON.parse(
      await Deno.readTextFile(join(dir, "out.json")).catch(() => {
        throw new Error(`the child never reached its kill:\n${log}`);
      }),
    );
    // The premise: saves land while the slice is clean, with the journal
    // refusing every line — so an `unsaved` below is a verdict.
    assertEquals(out.first.unsaved, undefined);
    assertEquals(out.probe.unsaved, undefined);
    assertEquals(out.clean.unsaved, undefined);
    // The action that could not be saved says so…
    assertMatch(String(out.bad.unsaved), /^persist failed: \S/);
    // So does an async call that arrived while the store refused, and wrote.
    assertMatch(String(out.quickWrites.unsaved), /^persist failed: \S/);
    assertMatch(String(out.prefix.unsaved), /^persist failed: \S/);
    assertEquals(out.clean2.unsaved, undefined);
    // …and the calls that were open then do not: neither wrote it.
    assertEquals([out.idle.ok, out.idle.unsaved], [true, undefined]);
    assertEquals([out.writes.ok, out.writes.unsaved], [true, undefined]);
  } finally {
    await dropTempDir(dir);
  }
});
