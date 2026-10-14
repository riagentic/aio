// A failed save is `unsaved` on the call that WROTE it — also when a shared
// userland queue ran the write from another call's continuation.
//
// The owner named a write-set's call by the async context it was dispatched
// in (aio.ts `_callScope`). A serial queue shared by several calls (the
// p-queue shape) runs a job from whichever call's continuation drains it: the
// write was billed to THAT call, and its author — whose save had failed — was
// acked as saved. An async body now dispatches through a door of its own
// call (as a worker cell's does, tests/journal-worker-owed-saves.test.ts), so
// the write is its author's whoever's continuation runs it.
//
// A NESTED call made from such a job (`await peer.put(t)`) passes no call's
// door — a cell handle is nobody's — so it was still named by the drainer's
// scope, and so were the nested body's writes. Its author cannot be known at
// that dispatch; a failed save of it is owed to every call open right then,
// the author among them.
//
// The rule is one-sided: an extra `unsaved` is acceptable, a missing one never.
import { assertEquals } from "@std/assert";
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
const LATE = 150;
// A userland serial queue: a job runs from whichever call's continuation
// drains it, not from the call that queued it.
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
// The peer a nested call goes to: its own slice, refusing "BAD" the same way.
export const peer = cell("peer", {
  state: { items: [] },
  onPersist: (s) => {
    if (s.items.some((t) => t.startsWith("BAD"))) throw new Error("disk says no");
    return s;
  },
  methods: {
    put(s, t) { s.items.push(t); },
    async putLate(s, t) {
      await new Promise((r) => setTimeout(r, 2));
      s.items.push(t);
    },
    clean(s) { s.items = s.items.filter((t) => !t.startsWith("BAD")); },
  },
});
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
    // Each async body writes late: its CALL was saved while the slice was
    // still clean, so only its write-set's save can say "unsaved".
    async addAsync(s, t) {
      await new Promise((r) => setTimeout(r, LATE));
      s.items.push(t);
    },
    // Two write-sets; the first is clean.
    async addTwice(s, t) {
      s.items.push("ok" + t);
      await new Promise((r) => setTimeout(r, LATE));
      s.items.push(t);
    },
    // Written from inside the shared queue.
    async addQueued(s, t) {
      await new Promise((r) => setTimeout(r, LATE));
      await queued(() => { s.items.push(t); });
    },
    // A NESTED call from inside the shared queue — this call writes nothing
    // itself, so only the nested write's save can say "unsaved": a sync
    // method of the peer, and an async one whose body writes.
    async nestQueued(s, t) {
      await new Promise((r) => setTimeout(r, LATE));
      await queued(() => peer.put(t));
    },
    async nestQueuedAsync(s, t) {
      await new Promise((r) => setTimeout(r, LATE));
      await queued(() => peer.putLate(t));
    },
  },
});
await aio.run({
  cells: [own, peer],
  appId: "journal-owed-saves-whose-write",
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
const call = async (t, type = "own:add") => {
  const cid = "c" + (++n);
  ws.send(JSON.stringify({ v: 2, t: "action", d: { type, payload: { args: [t] }, cid } }));
  const t0 = Date.now();
  for (;;) {
    const f = frames.find((f) => f.t === "ack" && f.d.cid === cid);
    if (f) return f.d;
    if (Date.now() - t0 > 10000) throw new Error("never acked " + cid);
    await sleep(1);
  }
};
const out = {};
out.first = await call("a1"); // the journal's first line lands normally
Deno.renameSync(J, J + ".save");
Deno.mkdirSync(J); // every append refused: saves stand in for the lines
let seed = Number(Deno.env.get("SEED"));
// mulberry32. (The LCG this replaced multiplied past 2^53: its low bits were
// always 0, so every call was the FIRST kind and the queue was never met.)
const rnd = (n) => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) % n;
};
const kinds = Deno.env.get("KINDS").split(",");
out.calls = [];
out.cleans = [];
for (let round = 0; round < 6; round++) {
  // Async calls arrive while the slice is clean (0-30ms) and write "BAD…"
  // after LATE; a sync writer arrives with them. From the first write on
  // every save fails, until the round's \`clean\`.
  // Every kind in every round (12 calls, at most 7 kinds); the order and the
  // arrival times are the seed's.
  const off = rnd(kinds.length);
  await Promise.all(Array.from({ length: 12 }, async (_, i) => {
    const type = kinds[(i + off) % kinds.length];
    const wait = type === "own:add" ? LATE + rnd(30) : rnd(30);
    await sleep(wait);
    const d = await call("BAD" + round + "." + i, type);
    out.calls.push({ type, wait, round, ok: d.ok, unsaved: d.unsaved ?? null });
  }));
  // The peer first: while \`own\` still holds "BAD" its save fails anyway.
  await call("x", "peer:clean");
  out.cleans.push((await call("x", "own:clean")).unsaved ?? null);
}
Deno.writeTextFileSync(DIR + "/out.json", JSON.stringify(out));
Deno.kill(Deno.pid, "SIGKILL");
`;

/** 72 calls of \`kinds\` in random interleavings: the ones told they were
 *  saved (there must be none), and how to replay the run. */
async function toldSaved(
  kinds: string[],
): Promise<{ calls: unknown[]; replay: string }> {
  const seed = Number(Deno.env.get("AIO_TEST_SEED")) ||
    Math.floor(Math.random() * 2 ** 31);
  const dir = await tempDir("aio-owed-whose-");
  try {
    await Deno.writeTextFile(join(dir, "app.ts"), CHILD);
    const res = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--config", CONFIG, join(dir, "app.ts")],
      env: {
        DIR: dir,
        PORT: String(freePort()),
        AIO_APPS_DIR: dir,
        SEED: String(seed),
        KINDS: kinds.join(","),
      },
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
    assertEquals(out.first.unsaved, undefined);
    // The fixture's premise: once the slice is clean again, a save lands —
    // so an `unsaved` below is a verdict, not the store's standing state.
    assertEquals(out.cleans, [null, null, null, null, null, null]);
    assertEquals(out.calls.length, 72);
    // …and every kind was called: a run of one kind proves nothing about the
    // others (the shared queue is only met by the kinds that use it).
    assertEquals(
      [...new Set(out.calls.map((c: { type: string }) => c.type))].sort(),
      [...new Set(kinds)].sort(),
    );
    return {
      calls: out.calls.filter((c: { unsaved: unknown }) =>
        !/^persist failed: \S/.test(String(c.unsaved))
      ),
      replay: `seed ${seed} (AIO_TEST_SEED=${seed} replays it)`,
    };
  } finally {
    await dropTempDir(dir);
  }
}

const DOOR = ["own:addAsync", "own:addTwice", "own:addQueued", "own:addQueued"];

// Writes of async bodies only: each goes through its own call's door, so
// every author is KNOWN — nothing here is owed to a call by the guess below,
// and a door that stopped naming its call is a missing `unsaved`.
Deno.test("owed saves: an async body's write is its own call's, whoever's continuation runs it — no call whose write's save failed is told it was saved", async () => {
  const { calls, replay } = await toldSaved(DOOR);
  assertEquals(calls, [], replay);
});

Deno.test("owed saves: under any interleaving, no call whose write's save failed is told it was saved — a write, or a nested call, a shared queue runs from another call's continuation included", async () => {
  const { calls, replay } = await toldSaved([
    "own:add",
    ...DOOR,
    ...["own:nestQueued", "own:nestQueuedAsync"].flatMap((k) => [k, k]),
  ]);
  assertEquals(calls, [], replay);
});
