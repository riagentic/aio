// There are TWO offline queues and ONE implementation + drop policy.
//
// Cell-method dispatch queues in `browser/browser-air-transport.ts` (cap
// 1000); `useCell().send` / `useAio().send` queue in the isomorphic core
// (`state/state-transport.ts`, cap 100). Two INSTANCES is structural — the
// boundary matrix forbids `state` importing `browser` — but they used to be
// two implementations with OPPOSITE drop policies: the core refused the
// NEWEST action (stale intent won) and settled no acks, the browser dropped
// the oldest and rejected its ack. Since alpha52 both instantiate
// `state/offline-queue.ts`, whose one policy this file pins on BOTH paths:
//
//   • at cap the OLDEST queued action is dropped — newest data wins;
//   • the dropped action's pending ack (if any) rejects IMMEDIATELY
//     ("action dropped — offline queue full"), instead of its caller waiting
//     out the 15s ceiling for a frame discarded locally;
//   • the drop reaches the diagnostic bus (dev overlay, `am`), not just the
//     console;
//   • `isConnectionDegraded()` answers for both queues.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  _resetTransport,
  flushOfflineQueue,
  send,
  setTransport,
} from "../src/state/state-transport.ts";
import { offlineQueue } from "../src/state/offline-queue.ts";
import { isConnectionDegraded } from "../src/air.ts";
import {
  _pendingAckCount,
  _registerAck,
  _rejectAllPending,
} from "../src/browser/browser-ack.ts";
import { client } from "../src/browser/browser-protocol.ts";
import {
  diagSubscribe,
  initDiagnosticBus,
} from "../src/diagnostics/diagnostic-bus.ts";

/** The pinned caps — changing either is a deliberate, test-visible decision. */
const CORE_CAP = 100;
const BROWSER_CAP = 1000;

/** Fill the core offline queue by sending with no transport attached. */
function fillCoreQueue(n: number, prefix = "q:act"): boolean[] {
  const out: boolean[] = [];
  for (let i = 0; i < n; i++) out.push(send({ type: `${prefix}${i}` }));
  return out;
}

// ── the factory: ONE policy ─────────────────────────────────────────

Deno.test("offlineQueue: drops OLDEST at cap — newest data wins", () => {
  const dropped: string[] = [];
  const q = offlineQueue(3, (a) => dropped.push(a.type));
  for (let i = 0; i < 5; i++) q.push({ type: `a${i}` });
  assertEquals(
    dropped,
    ["a0", "a1"],
    "past cap the queue must evict oldest-first — refusing the NEW action " +
      "keeps stale intent and drops fresh, the exact inversion of what a " +
      "user means by their latest click",
  );
  assertEquals(q.length, 3, "cap holds");
  assertEquals(
    q.drain().map((a) => a.type),
    ["a2", "a3", "a4"],
    "drain returns survivors in arrival order",
  );
  assertEquals(q.length, 0, "drain empties");
});

Deno.test("offlineQueue: fullness is length/cap (feeds isConnectionDegraded)", () => {
  const q = offlineQueue(10);
  for (let i = 0; i < 9; i++) q.push({ type: "x" });
  assertEquals(q.fullness(), 0.9);
  assertEquals(q.cap, 10);
});

Deno.test("offlineQueue: a dropped action's pending ack rejects NOW", async () => {
  _rejectAllPending(new Error("reset"));
  const q = offlineQueue(1);
  const p = _registerAck("oq-drop-cid", { deferTimer: true });
  q.push({ type: "m:one", cid: "oq-drop-cid" });
  q.push({ type: "m:two" }); // evicts m:one
  await assertRejects(
    () => p,
    Error,
    "action dropped — offline queue full",
    "the evicted call's caller must hear 'dropped' immediately — a deferred " +
      "clock never armed is otherwise a promise that hangs forever",
  );
  _rejectAllPending(new Error("cleanup"));
});

// ── core path (state-transport, cap 100) ────────────────────────────

Deno.test("core queue: cap 100, drop-oldest, newest survives the flush", () => {
  _resetTransport();
  try {
    const results = fillCoreQueue(CORE_CAP + 1); // 101 sends, no transport
    assertEquals(
      results.every((r) => r === true),
      true,
      "send() accepts the NEW action even at cap — the oldest gives way",
    );
    const sent: string[] = [];
    setTransport({ send: (d: string) => sent.push(d), close: () => {} });
    flushOfflineQueue();
    assertEquals(sent.length, CORE_CAP, "exactly cap actions survive");
    assert(
      !sent.some((d) => d.includes('"q:act0"')),
      "q:act0 (the OLDEST) was dropped — it must not be flushed",
    );
    assertStringIncludes(
      sent[sent.length - 1]!,
      "q:act100",
      "the newest action survives — that is the whole point of the policy",
    );
  } finally {
    _resetTransport();
  }
});

Deno.test("core queue: a dropped send() rejects its ack and emits a diagnostic", async () => {
  initDiagnosticBus(true);
  _resetTransport();
  _rejectAllPending(new Error("reset"));
  const seen: string[] = [];
  const unsub = diagSubscribe((e) => seen.push(e.type));
  try {
    const p = _registerAck("core-drop-cid", { deferTimer: true });
    // Oldest in → first out: this is the action the overflow will evict.
    send(
      { type: "core:first", cid: "core-drop-cid" } as {
        type: string;
        payload?: unknown;
      },
    );
    fillCoreQueue(CORE_CAP); // overflow by exactly one
    await assertRejects(
      () => p,
      Error,
      "action dropped — offline queue full",
      "the core path settles acks on drop exactly like the browser path — " +
        "one policy, both queues",
    );
    assert(
      seen.includes("state-transport:offline-queue-full"),
      `a dropped action must reach the diagnostic bus — a console line is ` +
        `invisible to the dev overlay and to \`am\`. Saw: ${
          JSON.stringify([...new Set(seen)])
        }`,
    );
  } finally {
    unsub();
    _rejectAllPending(new Error("cleanup"));
    _resetTransport();
  }
});

Deno.test("isConnectionDegraded reflects the CORE queue too", () => {
  _resetTransport();
  try {
    assertEquals(
      isConnectionDegraded(),
      false,
      "a fresh client is not degraded",
    );
    // Below the 80% mark of the core queue (cap 100): still healthy.
    fillCoreQueue(50);
    assertEquals(
      isConnectionDegraded(),
      false,
      "half a queue is not degraded",
    );
    // Past 80%: the indicator must fire. It used to stay false forever here,
    // because only the cell-method queue was consulted.
    fillCoreQueue(40); // 90 total
    assertEquals(
      isConnectionDegraded(),
      true,
      "past 80% of the core offline queue the connection IS degraded — an " +
        "indicator that cannot see this queue lies to every send() caller",
    );
  } finally {
    _resetTransport();
  }
});

Deno.test("isConnectionDegraded clears when the core queue drains", () => {
  _resetTransport();
  try {
    fillCoreQueue(90);
    assertEquals(isConnectionDegraded(), true);
    _resetTransport(); // drops the queue, as a teardown would
    assertEquals(
      isConnectionDegraded(),
      false,
      "the indicator must clear once the queue is gone — a stuck-on warning " +
        "is as useless as one that never fires",
    );
  } finally {
    _resetTransport();
  }
});

// ── browser path (browser-air-transport, cap 1000) ──────────────────
// LAST in this file on purpose: the browser queue is module state with no
// public drain, so this test leaves it populated (its process ends here).

Deno.test("browser queue: cap 1000, drop-oldest, and the evicted ack rejects", async () => {
  initDiagnosticBus(true);
  _rejectAllPending(new Error("reset"));
  const seen: string[] = [];
  const unsub = diagSubscribe((e) => seen.push(e.type));
  try {
    // No WS, no IPC: client.send → the transport's _send → the offline queue.
    const first = _registerAck("bq-first", { deferTimer: true });
    const second = _registerAck("bq-second", { deferTimer: true });
    second.catch(() => {}); // rejected only by cleanup below
    client.send(
      { type: "bq:first", cid: "bq-first" } as {
        type: string;
        payload?: unknown;
      },
    );
    client.send(
      { type: "bq:second", cid: "bq-second" } as {
        type: string;
        payload?: unknown;
      },
    );
    // Fill to one past cap: exactly ONE eviction, and it must be bq:first.
    for (let i = 0; i < BROWSER_CAP - 1; i++) {
      client.send({ type: `bq:fill${i}` });
    }
    await assertRejects(
      () => first,
      Error,
      "action dropped — offline queue full",
      "the OLDEST queued cell call is the one evicted at cap, and its caller " +
        "hears about it now — not after a 15s timeout for a frame that was " +
        "thrown away locally",
    );
    assertEquals(
      _pendingAckCount(),
      1,
      "exactly one eviction at cap+1 — bq-second (the next-oldest) survives, " +
        "pinning both the 1000 cap and the single-drop policy",
    );
    assert(
      seen.includes("browser-air-transport:queue-drop"),
      `the browser drop emits its diagnostic. Saw: ${
        JSON.stringify([...new Set(seen)])
      }`,
    );
  } finally {
    unsub();
    _rejectAllPending(new Error("cleanup"));
  }
});
