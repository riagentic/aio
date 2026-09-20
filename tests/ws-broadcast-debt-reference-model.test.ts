// Reference model for the WS broadcaster's lost-round debt (needsFull) and its
// idle retry: under a randomized mix of rounds, peers that stop draining,
// backpressure windows and rounds lost to a throw, every client — applying
// exactly the frames it was sent — must end up holding the server's state once
// the app goes idle and the peers drain. A patch after a full state that
// already held it, a full state overtaken by an older patch, or a debt left
// unpaid each shows up here as a diverged client, whichever path caused it.
import { assertEquals } from "@std/assert";
import { enablePatches } from "immer";
import { createBroadcaster } from "../src/server/server-broadcast.ts";
import { applyWirePatches } from "../src/protocol/patch-ops.ts";
import type { PatchEntry } from "../src/protocol/broadcast-utils.ts";
import type { ClientMeta } from "../src/server/server-ws.ts";
import type { WirePatch } from "../src/protocol/patch-ops.ts";
import { _resetDegraded } from "../src/diagnostics/degraded.ts";

enablePatches();

/** Deterministic PRNG (mulberry32) — a failing seed replays exactly. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// `pad` keeps a patch well under half the full state, so every round takes the
// patch path — a tiny state would mask a wrong patch behind a full resend.
type S = { c: { n: number; items: number[]; pad?: string } };
const PAD = "p".repeat(2000);

function client(id: string) {
  let held: unknown = undefined;
  let backlogged = false;
  let broken = false;
  const ws = {
    readyState: 1,
    get bufferedAmount() {
      return backlogged ? 64 * 1024 * 1024 : 0;
    },
    send(frame: string) {
      const m = JSON.parse(frame) as { t: string; d: unknown };
      if (m.t === "state") held = m.d;
      else if (m.t === "patches") {
        try {
          held = applyWirePatches(held, m.d as WirePatch[]);
        } catch {
          broken = true; // a real client would resync — here it is the bug
        }
      }
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
  return {
    ws,
    meta,
    held: () => held,
    broken: () => broken,
    setBacklogged: (b: boolean) => (backlogged = b),
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const seed of [1, 2, 3, 4, 5, 6]) {
  Deno.test(`ws broadcast debt: every client converges on the server's state (seed ${seed})`, async () => {
    const r = rng(seed);
    let state: S = { c: { n: 0, items: [], pad: PAD } };
    const clients = [client("a"), client("b"), client("c"), client("d")];
    const connections = new Map<WebSocket, ClientMeta>(
      clients.map((c) => [c.ws, c.meta]),
    );
    const broadcaster = createBroadcaster({
      connections,
      payloadStats: new Map(),
      getUIState: () => state,
      debug: () => {},
      // Both regimes: a retry that finds a round still buffered (slow
      // throttle) and one that never does.
      syncIntervalMs: seed % 2 ? 5 : 60,
    });
    try {
      // Every client starts current.
      for (const c of clients) {
        c.ws.send(`{"v":2,"t":"state","d":${JSON.stringify(state)}}`);
      }
      for (const c of clients) {
        c.meta.lastFullJson = JSON.stringify(state);
        c.meta.lastFullJsonStale = false;
      }
      for (let step = 0; step < 120; step++) {
        const k = r();
        if (k < 0.15) {
          clients[Math.floor(r() * clients.length)]!.setBacklogged(r() < 0.5);
        } else if (k < 0.22) {
          const m = clients[Math.floor(r() * clients.length)]!.meta;
          m.bpMultiplier = r() < 0.5 ? 1 : 4;
        } else {
          // A state change and its patch, committed together (as onDone does).
          const i = state.c.items.length;
          const v = Math.floor(r() * 1000);
          const throws = r() < 0.08;
          state = {
            c: { n: state.c.n + 1, items: [...state.c.items, v], pad: PAD },
          };
          broadcaster.broadcast([{
            cell: "c",
            ops: [
              { op: "replace", path: ["n"], value: state.c.n },
              // A value the wire cannot carry — the whole round throws.
              { op: "add", path: ["items", i], value: throws ? BigInt(v) : v },
            ],
          }] as unknown as PatchEntry[]);
        }
        if (r() < 0.3) await wait(Math.floor(r() * 40));
      }
      // Idle from here; everyone drains and leaves backpressure.
      for (const c of clients) {
        c.setBacklogged(false);
        c.meta.bpMultiplier = 1;
      }
      const t0 = Date.now();
      while (
        clients.some((c) => c.meta.needsFull) && Date.now() - t0 < 5000
      ) await wait(20);
      await wait(30);
      for (const c of clients) {
        assertEquals(
          c.broken(),
          false,
          `client ${c.meta.id} got a patch on a gap`,
        );
        assertEquals(c.held(), state, `client ${c.meta.id} diverged`);
      }
    } finally {
      broadcaster.shutdown();
      _resetDegraded();
    }
  });
}

// The retry and the coalescer's trailing edge are armed in the same round with
// the same delay — and the retry is armed FIRST, so it fires first. A round
// buffered in that window must go out before the whole state the retry pays
// (then the round itself pays the debt, in order); a whole state sent ahead of
// it would have the buffered patch applied on top of a state that already
// holds it — an array `add` inserted twice.
Deno.test("ws broadcast debt: the retry drains a buffered round before it pays", async () => {
  let state: S = { c: { n: 0, items: [], pad: PAD } };
  const a = client("a");
  const connections = new Map<WebSocket, ClientMeta>([[a.ws, a.meta]]);
  const broadcaster = createBroadcaster({
    connections,
    payloadStats: new Map(),
    getUIState: () => state,
    debug: () => {},
    syncIntervalMs: 150,
  });
  const push = (v: number) => {
    const i = state.c.items.length;
    state = {
      c: { n: state.c.n + 1, items: [...state.c.items, v], pad: PAD },
    };
    broadcaster.broadcast([{
      cell: "c",
      ops: [
        { op: "replace", path: ["n"], value: state.c.n },
        { op: "add", path: ["items", i], value: v },
      ],
    }] as PatchEntry[]);
  };
  try {
    a.ws.send(`{"v":2,"t":"state","d":${JSON.stringify(state)}}`);
    a.meta.lastFullJson = JSON.stringify(state);
    a.meta.lastFullJsonStale = false;
    a.setBacklogged(true);
    push(1); // leading edge: skipped for `a`, owed; retry + trailing armed
    await wait(20);
    a.setBacklogged(false);
    push(2); // buffered in the throttle window
    await wait(400);
    assertEquals(a.broken(), false);
    assertEquals(a.held(), state, "the buffered round was applied twice");
    assertEquals(a.meta.needsFull, false);
  } finally {
    broadcaster.shutdown();
  }
});
