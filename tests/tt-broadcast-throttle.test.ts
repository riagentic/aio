// The time-travel channel had a 250 ms throttle that never engaged once.
//
// `createCoalescer` registers every coalescer in an interactive-priority
// registry, and `flushAllUrgent()` — which aio-server calls after EVERY client
// action — drains all of them. The TT coalescer joined it by default, so its
// throttle was decorative: one frame per dispatch, each carrying the WHOLE
// action log (`toBroadcast` maps every entry, capped at MAX_ENTRIES = 2 000,
// so ~140 KB on a full history — while the comment in server-broadcast.ts
// still claimed "200 entries, ~15 KB"). Measured: 143 MB of tt traffic against
// 30 MB of state traffic for 1000 commits, growing with history length.
//
// And it went to every OPEN socket unconditionally — the one channel that
// re-sends its entire history was the one channel that did not skip a frozen
// or backlogged client, so a peer receiving no state still received every
// debug frame. (audit a2/W3)
import { assert, assertEquals } from "@std/assert";
import {
  createCoalescer,
  flushAllUrgent,
} from "../src/server/broadcast-coalescer.ts";
import { createBroadcaster } from "../src/server/server-broadcast.ts";
import { WS_BUFFER_HIGH_WATER } from "../src/server/write-backlog.ts";
import type { ClientMeta } from "../src/server/server-ws.ts";
import type { VitalsSystem } from "../src/vitals/mod.ts";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("coalescer: `urgent: false` opts a channel out of the interactive registry", async () => {
  const urgent: number[] = [];
  const paced: number[] = [];
  const a = createCoalescer<never>(250, () => urgent.push(1));
  const b = createCoalescer<never>(250, () => paced.push(1), { urgent: false });
  try {
    a.add();
    b.add();
    await tick(0); // both take their leading edge
    assertEquals([urgent.length, paced.length], [1, 1]);
    // A client action: everything in the registry is drained NOW.
    for (let i = 0; i < 5; i++) {
      a.add();
      b.add();
      flushAllUrgent();
    }
    assertEquals(
      urgent.length,
      6,
      "an interactive channel must flush on every client action",
    );
    assertEquals(
      paced.length,
      1,
      `a paced channel must stay inside its throttle window — it flushed ` +
        `${paced.length} times`,
    );
    await tick(400);
    assertEquals(paced.length, 2, "…and once when the window closes");
  } finally {
    a.dispose();
    b.dispose();
  }
});

function fakeClient(id: string, buffered = 0) {
  const sent: string[] = [];
  const ws = {
    readyState: 1,
    get bufferedAmount() {
      return buffered;
    },
    send(msg: string) {
      sent.push(msg);
    },
  } as unknown as WebSocket;
  const meta = {
    id,
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
  } as unknown as ClientMeta;
  return { ws, meta, sent };
}

const ttFrames = (sent: string[]) =>
  sent.filter((f) => JSON.parse(f).t === "tt-state").length;

Deno.test("tt: a client action does not put a tt frame on the wire", async () => {
  const c = fakeClient("c1");
  const broadcaster = createBroadcaster({
    connections: new Map([[c.ws, c.meta]]),
    payloadStats: new Map(),
    getUIState: () => ({ c: { n: 1 } }),
    debug: () => {},
    syncIntervalMs: 10,
    getTTBroadcast: () => ({ entries: [], index: -1, paused: false }),
  });
  try {
    broadcaster.broadcastTT();
    await tick(0);
    assertEquals(ttFrames(c.sent), 1, "leading edge");
    // Ten client actions inside one throttle window. Each one used to ship the
    // whole action log.
    for (let i = 0; i < 10; i++) {
      broadcaster.broadcastTT();
      flushAllUrgent();
    }
    assertEquals(
      ttFrames(c.sent),
      1,
      `the debug channel must stay throttled through a burst of client ` +
        `actions — it sent ${ttFrames(c.sent)} frames`,
    );
    await tick(400);
    assertEquals(ttFrames(c.sent), 2, "…and one on the trailing edge");
  } finally {
    broadcaster.shutdown();
  }
});

Deno.test("tt: frozen and backlogged clients are skipped, like every other frame", async () => {
  const good = fakeClient("good");
  const frozen = fakeClient("frozen");
  const stuffed = fakeClient("stuffed", WS_BUFFER_HIGH_WATER + 1);
  const vitalsSystem = {
    serverTransport: {
      isFrozen: (id: string) => id === "frozen",
      onClientStateSent: () => {},
    },
  } as unknown as VitalsSystem;
  const broadcaster = createBroadcaster({
    connections: new Map([
      [good.ws, good.meta],
      [frozen.ws, frozen.meta],
      [stuffed.ws, stuffed.meta],
    ]),
    payloadStats: new Map(),
    getUIState: () => ({ c: { n: 1 } }),
    debug: () => {},
    syncIntervalMs: 10,
    vitalsSystem,
    getTTBroadcast: () => ({ entries: [], index: -1, paused: false }),
  });
  try {
    broadcaster.broadcastTT();
    await tick(0);
    assert(ttFrames(good.sent) > 0, "a healthy client still gets the panel");
    assertEquals(
      ttFrames(frozen.sent),
      0,
      "a frozen client gets no state — it must not get debug frames either",
    );
    assertEquals(
      ttFrames(stuffed.sent),
      0,
      "…nor one whose socket buffer is already over the high-water mark",
    );
  } finally {
    broadcaster.shutdown();
  }
});
