// A slow client of a big cell keeps its skipped patches instead of being owed
// the whole state on every skip.
//
// Measured 2026-10-21 (hunt round 3): a client on a ~1 MB/s link of an app
// with a ≥4 MB cell re-downloaded the WHOLE state every ~6 s while others
// wrote. Over the 4 MB backlog mark its rounds were skipped and it was owed
// full state; paying that full state put it over the mark again — a cycle.
// The skipped rounds are now queued per client up to the same fraction of the
// full state the patch-vs-full decision uses (`fullStateThreshold`, 0.5);
// past that it is owed the whole state as before.
import { assert, assertEquals } from "@std/assert";
import { createBroadcaster } from "../src/server/server-broadcast.ts";
import { WS_BUFFER_HIGH_WATER } from "../src/server/write-backlog.ts";
import type { PatchEntry } from "../src/protocol/broadcast-utils.ts";
import type { ClientMeta } from "../src/server/server-ws.ts";

/** A socket whose peer reads nothing until `drain()`; it starts holding the
 *  handshake's whole-state frame, still unread. */
function slowClient(state: unknown, held: number) {
  const sent: string[] = [];
  let buffered = held;
  const ws = {
    readyState: 1,
    get bufferedAmount() {
      return buffered;
    },
    send(msg: string) {
      sent.push(msg);
      buffered += msg.length;
    },
  } as unknown as WebSocket;
  const meta = {
    id: "slow",
    index: 0,
    clientType: "browser",
    isElectron: false,
    msgCount: 0,
    bytesThisSec: 0,
    bpMultiplier: 1,
    bpConsecutiveLow: 0,
    bpLastSentAt: 0,
    subscriptions: null,
    disconnected: false,
    consecutiveDrops: 0,
    lastFullJson: JSON.stringify(state), // what the handshake sent it
  } as unknown as ClientMeta;
  return { ws, meta, sent, drain: () => (buffered = 0) };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Frame = { t: string; d: unknown };

function rig(pad: number) {
  const state = { c: { items: [] as number[], pad: "p".repeat(pad) } };
  const c = slowClient(state, WS_BUFFER_HIGH_WATER + 1);
  const broadcaster = createBroadcaster({
    connections: new Map([[c.ws, c.meta]]),
    payloadStats: new Map(),
    getUIState: () => state,
    debug: () => {},
    syncIntervalMs: 1,
  });
  const push = (v: number) => {
    state.c = { ...state.c, items: [...state.c.items, v] };
    broadcaster.broadcast([{
      cell: "c",
      ops: [{ op: "add", path: ["items", v - 1], value: v }],
    }] as PatchEntry[]);
  };
  return { state, c, broadcaster, push };
}

Deno.test("ws slow client: skipped rounds are queued and sent as ONE patch once it drains — not the whole 6 MB state again", async () => {
  const { c, broadcaster, push } = rig(6 * 1024 * 1024);
  try {
    push(1);
    await wait(20);
    push(2);
    await wait(20);
    assertEquals(c.sent.length, 0, "instrument: both rounds were skipped");
    c.drain();
    push(3);
    await wait(20);
    assertEquals(c.sent.length, 1, `frames: ${c.sent.length}`);
    const f = JSON.parse(c.sent[0]!) as Frame;
    assertEquals(
      f.t,
      "patches",
      `a drained slow client was sent ${c.sent[0]!.length} B of whole state ` +
        "— which puts it over the mark again, forever",
    );
    const values = (f.d as { op: string; value: number }[]).map((o) => o.value);
    assertEquals(values, [1, 2, 3], "every skipped round, in order");
    assertEquals(c.meta.needsFull ?? false, false);
  } finally {
    broadcaster.shutdown();
  }
});

Deno.test("ws slow client: queued patches reach it once it drains even when no later round comes", async () => {
  const { c, broadcaster, push } = rig(6 * 1024 * 1024);
  try {
    push(1);
    await wait(20);
    push(2);
    await wait(20);
    assertEquals(c.sent.length, 0, "instrument: both rounds were skipped");
    c.drain(); // …and the app is idle from here on
    const t0 = Date.now();
    while (c.sent.length === 0 && Date.now() - t0 < 3000) await wait(20);
    assertEquals(c.sent.length, 1);
    const f = JSON.parse(c.sent[0]!) as Frame;
    assertEquals(f.t, "patches");
    assertEquals(
      (f.d as { value: number }[]).map((o) => o.value),
      [1, 2],
    );
  } finally {
    broadcaster.shutdown();
  }
});

Deno.test("ws slow client: a queue past 50% of the state is dropped and the whole state is owed instead", async () => {
  // A 64-byte pad: a handful of item adds outgrow half of this state.
  const { state, c, broadcaster, push } = rig(64);
  try {
    for (let v = 1; v <= 12; v++) {
      push(v);
      await wait(10);
    }
    assertEquals(c.sent.length, 0, "instrument: every round was skipped");
    assertEquals(c.meta.needsFull, true, "past the cap it is owed full state");
    c.drain();
    const t0 = Date.now();
    while (c.meta.needsFull && Date.now() - t0 < 3000) await wait(20);
    assertEquals(c.sent.length, 1);
    const f = JSON.parse(c.sent[0]!) as Frame;
    assertEquals(f.t, "state");
    assertEquals(
      f.d,
      state,
      "the whole state, current — no stale queue after it",
    );
    push(13);
    await wait(30);
    const next = JSON.parse(c.sent[c.sent.length - 1]!) as Frame;
    assertEquals(next.t, "patches");
    assert(
      (next.d as { value: number }[]).every((o) => o.value === 13),
      `only the new round follows the full state: ${JSON.stringify(next.d)}`,
    );
  } finally {
    broadcaster.shutdown();
  }
});

Deno.test("ws slow client: a queue whose changes were undone is dropped, never replayed on the state it already holds", async () => {
  const state: Record<string, unknown> = { c: { v: "p".repeat(300) } };
  const c = slowClient(state, WS_BUFFER_HIGH_WATER + 1);
  const broadcaster = createBroadcaster({
    connections: new Map([[c.ws, c.meta]]),
    payloadStats: new Map(),
    getUIState: () => state,
    debug: () => {},
    syncIntervalMs: 1,
  });
  const round = (c2: Record<string, unknown>, ops: unknown[]) => {
    state.c = c2;
    broadcaster.broadcast([{ cell: "c", ops }] as PatchEntry[]);
  };
  const v = "p".repeat(300);
  try {
    round({ v, a: "x" }, [{
      op: "add",
      path: ["a"],
      value: "x",
    }]);
    await wait(20);
    assert(c.meta.skipped, "instrument: the round was queued");
    c.drain();
    // Undone: the client already holds exactly this state.
    // A big replace that changes nothing makes the round a whole state —
    // the very one it already holds, so nothing is sent.
    round({ v }, [{ op: "remove", path: ["a"] }, {
      op: "replace",
      path: ["v"],
      value: v,
    }]);
    await wait(20);
    round({ v, b: 1 }, [{ op: "add", path: ["b"], value: 1 }]);
    await wait(20);
    const last = JSON.parse(c.sent[c.sent.length - 1]!) as Frame;
    const ops = last.t === "patches" ? (last.d as { path: string[] }[]) : [];
    assert(
      last.t === "state" || ops.every((o) => o.path[1] === "b"),
      `the undone add was replayed on top: ${JSON.stringify(last.d)}`,
    );
  } finally {
    broadcaster.shutdown();
  }
});
