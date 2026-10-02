// What a worker cell's call is told about its write's save — kept, bounded,
// and never a plain `ok` it cannot vouch for.
//
//  · a batch's failed save is kept by the call even when the save ended
//    before the call did, and the call holds no batch once it has settled
//    (a `long` method that writes forever grew memory by every batch);
//  · an async call that ends while the app shuts down is still answered with
//    its verdict (the settle hook was dropped BEFORE the workers drained);
//  · a noted verdict is never pushed out by a burst of others before its ack
//    reads it, and a call whose owed saves were pushed out is `unsaved`.
import { assert, assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import {
  _collect,
  _collector,
  _verdictOf,
} from "../src/server/cell-worker-pool.ts";
import {
  _dispatchUnsaved,
  _notesHeld,
  _noteUnsaved,
  _verdictLost,
} from "../src/server/action-ack.ts";
import { registerCall, resolveCall } from "../src/state/cell-impl.ts";
import { PERSIST_REFUSED } from "../src/server/server-trojan.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("worker ack: a collector keeps settled verdicts and lets go of every batch", async () => {
  const running = new Set([_collector()]);
  const [c] = running;
  const n = 5000;
  const all: Promise<string | undefined>[] = [];
  for (let i = 0; i < n; i++) {
    const p = Promise.resolve(
      i === 7 ? "persist failed: disk says no" : undefined,
    );
    _collect(running, p);
    all.push(p);
  }
  await Promise.all(all);
  await Promise.resolve(); // the fold runs on the same settle
  assertEquals(c!.pending.size, 0, "settled batches are still held");
  // A later batch, still saving, is waited for; one arriving after the call
  // stopped collecting is not its.
  let release!: (v: string | undefined) => void;
  const slow = new Promise<string | undefined>((r) => release = r);
  _collect(running, slow);
  const verdict = _verdictOf(running, c!);
  _collect(running, Promise.resolve("persist failed: someone else's"));
  release(undefined);
  assertEquals(await verdict, "persist failed: disk says no");
  assertEquals(c!.pending.size, 0);
});

Deno.test("worker ack: a burst of other notes does not push out one its ack has not read", () => {
  _noteUnsaved(undefined, "wa-first", "persist failed: mine");
  for (let i = 0; i < 2000; i++) {
    _noteUnsaved(undefined, `wa-burst-${i}`, "persist failed: theirs");
  }
  assertEquals(
    _dispatchUnsaved({ payload: { _callId: "wa-first" } }),
    "persist failed: mine",
  );
  for (let i = 0; i < 2000; i++) {
    _dispatchUnsaved({ payload: { _callId: `wa-burst-${i}` } });
  }
});

Deno.test("worker ack: a call whose verdict was pushed out is `unsaved` when it settles, however late", async () => {
  // The reviewer's shape: pushed out while running, still running past the
  // notes' age limit, with a full map of unread notes by the time it ends.
  const real = Date.now;
  let now = real();
  Date.now = () => now;
  try {
    const settled = registerCall("wa-live");
    _verdictLost("wa-live");
    now += 121_000;
    for (let i = 0; i < 16_500; i++) {
      _noteUnsaved(undefined, `wa-late-${i}`, "persist failed: theirs");
    }
    resolveCall("wa-live", "v");
    await settled;
    const said = _dispatchUnsaved({ payload: { _callId: "wa-live" } });
    assert(said?.startsWith(`${PERSIST_REFUSED} `), String(said));
    assertMatch(said!, /verdict lost/);
  } finally {
    Date.now = real;
    for (let i = 0; i < 16_500; i++) {
      _dispatchUnsaved({ payload: { _callId: `wa-late-${i}` } });
    }
  }
});

Deno.test("worker ack: unread notes are capped, and a capped-out one still reads `unsaved`", () => {
  const n = 50_000;
  for (let i = 0; i < n; i++) {
    _noteUnsaved(undefined, `wa-cap-${i}`, `persist failed: reason ${i}`);
  }
  assert(_notesHeld() <= 16_384, `${_notesHeld()} sentences held`);
  // The oldest kept only its id: unsaved, the reason gone — never ok.
  assertMatch(
    String(_dispatchUnsaved({ payload: { _callId: "wa-cap-0" } })),
    /^persist failed: verdict lost/,
  );
  assertEquals(
    _dispatchUnsaved({ payload: { _callId: `wa-cap-${n - 1}` } }),
    `persist failed: reason ${n - 1}`,
  );
  for (let i = 1; i < n - 1; i++) {
    assert(_dispatchUnsaved({ payload: { _callId: `wa-cap-${i}` } }));
  }
});

const MOD = new URL("../mod.ts", import.meta.url).href;
const APP = `
import { aio, cell } from "${MOD}";
const DIR = Deno.env.get("DIR");
const PORT = Number(Deno.env.get("PORT"));
const J = DIR + "/data/journal";
export const wk = cell("wk", {
  worker: true,
  state: { items: [] },
  onPersist: (s) => {
    if (s.items.some((t) => t.startsWith("BAD"))) throw new Error("disk says no");
    return s;
  },
  methods: {
    add(s, t) { s.items.push(t); },
    async late(s, t) {
      s.items.push(t);
      await new Promise((r) => setTimeout(r, 600)); // ignores $signal
      return "done";
    },
  },
});
await aio.run({ cells: [wk], appId: "worker-ack-shut", client: "server-only",
  journal: true, persistDebounceMs: 999999, port: PORT, appDir: DIR, watch: false });
const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/ws");
ws.onmessage = (e) => {
  const f = JSON.parse(e.data);
  if (f.t === "ack") Deno.writeTextFileSync(DIR + "/acks.jsonl", JSON.stringify(f.d) + "\\n", { append: true });
  if (f.t === "ack" && f.d.cid === "L0") {
    // The method is running: stop the app under it.
    Deno.kill(Deno.pid, "SIGTERM");
  }
};
await new Promise((r) => (ws.onopen = r));
await fetch("http://127.0.0.1:" + PORT + "/__aio/trojan/dispatch", { method: "POST",
  headers: { "Content-Type": "application/json", "X-AIO": "1" },
  body: JSON.stringify({ type: "wk:add", payload: { args: ["ok1"] } }) }).then((r) => r.json());
Deno.renameSync(J, J + ".save");
Deno.mkdirSync(J);
ws.send(JSON.stringify({ v: 2, t: "action", d: { type: "wk:late", payload: { args: ["BAD9"] }, cid: "L1" } }));
// Acked at once (a sync call on the same cell, queued behind nothing): the
// signal that L1 is in flight.
ws.send(JSON.stringify({ v: 2, t: "action", d: { type: "wk:add", payload: { args: ["BAD0"] }, cid: "L0" } }));
`;

Deno.test("worker ack: an async call that ends during shutdown is answered with its verdict", async () => {
  const dir = await tempDir("aio-worker-ack-shut-");
  try {
    await Deno.writeTextFile(join(dir, "app.ts"), APP);
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        new URL("../deno.json", import.meta.url).pathname,
        join(dir, "app.ts"),
      ],
      env: { DIR: dir, PORT: String(freePort()), AIO_APPS_DIR: dir },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const log = new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr);
    const acks = (await Deno.readTextFile(join(dir, "acks.jsonl")).catch(
      () => "",
    )).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const l1 = acks.find((a) => a.cid === "L1");
    assert(l1, `L1 was never answered:\n${JSON.stringify(acks)}\n${log}`);
    // Refused by the closing app is an honest answer too; `ok` must say why
    // its write is not on disk.
    if (l1.ok) {
      assertMatch(
        String(l1.unsaved),
        /^persist failed: \S/,
        JSON.stringify(l1),
      );
    }
  } finally {
    await dropTempDir(dir);
  }
});
