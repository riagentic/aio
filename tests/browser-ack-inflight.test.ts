// The browser half of the exactly-once contract, plus the capability that
// makes it work.
//
// Two shipped defects live here:
//
//  1. `_rejectAllPending` on a disconnect settled calls whose frames were
//     still in the transport's in-memory queue — a queue that survives the
//     close and flushes on the next open. The caller was told "connection
//     lost", and the action was then sent and applied. Disconnect now rejects
//     only what is ON THE WIRE (`_rejectInFlight`); a discard (teardown,
//     protocol gap) still rejects everything, because then the rejection is
//     true.
//
//  2. `ensureConnected` wrapped the client send in a bare arrow to route
//     sync-cell actions. `ARMS_ACK_TIMER` is a symbol on the function OBJECT,
//     so the wrapper answered "I do not arm ack clocks" and the binding armed
//     the 15s clock at DISPATCH time — every browser action dispatched while
//     offline failed its caller after 15s and then landed. The wrapper now
//     goes through `wrapTransport`, which carries the transport's capabilities
//     across.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import {
  _armAckTimer,
  _isAckWritten,
  _pendingAckCount,
  _registerAck,
  _rejectAllPending,
  _rejectInFlight,
  _resolveAck,
  _setAckTimeoutMs,
  ARMS_ACK_TIMER,
  armsAckTimer,
} from "../src/browser/browser-ack.ts";
import { _makeSendWrapper } from "../src/browser/browser-protocol.ts";
import {
  _resetCellRegistry,
  bindCellReactive,
} from "../src/state/cell-reactive.ts";
import { _resetSignals } from "../src/state/state-signals.ts";

function reset() {
  _resetCellRegistry();
  _resetSignals();
  _rejectAllPending(new Error("test reset"));
  _setAckTimeoutMs(15_000);
}

const settled = <T>(p: Promise<T>) => {
  const st = { done: false, ok: false, err: null as unknown };
  p.then(() => (st.done = st.ok = true), (e) => {
    st.done = true;
    st.err = e;
  });
  return st;
};

Deno.test("ack: rejectInFlight settles only the calls whose frames were written", async () => {
  reset();
  _setAckTimeoutMs(0);
  const queued = settled(_registerAck("q1", { deferTimer: true }));
  const written = settled(_registerAck("w1", { deferTimer: true }));
  _armAckTimer("w1"); // the transport wrote this one

  assertEquals(_isAckWritten("q1"), false);
  assertEquals(_isAckWritten("w1"), true);

  const n = _rejectInFlight(new Error("connection lost"));
  await Promise.resolve();
  assertEquals(n, 1, "only the in-flight call is settled by a disconnect");
  assert(written.done && !written.ok);
  assertEquals(
    queued.done,
    false,
    "a queued call keeps its promise — the queue survives the disconnect " +
      "and will send it",
  );
  assertEquals(_pendingAckCount(), 1);

  // It settles for real when its frame finally goes out and is acked.
  _armAckTimer("q1");
  _resolveAck("q1", 5);
  await Promise.resolve();
  assert(queued.done && queued.ok);
  reset();
});

Deno.test("ack: rejectAll still settles queued calls (their frames are discarded)", async () => {
  reset();
  _setAckTimeoutMs(0);
  const queued = settled(_registerAck("q2", { deferTimer: true }));
  const n = _rejectAllPending(new Error("client torn down"));
  await Promise.resolve();
  assertEquals(n, 1);
  assert(
    queued.done && !queued.ok,
    "a discarded frame owes its caller an error",
  );
  reset();
});

Deno.test("ack: a registration that does NOT defer counts as in flight", async () => {
  reset();
  _setAckTimeoutMs(0);
  const legacy = settled(_registerAck("l1"));
  assertEquals(_isAckWritten("l1"), true);
  assertEquals(_rejectInFlight(new Error("connection lost")), 1);
  await Promise.resolve();
  assert(legacy.done && !legacy.ok);
  reset();
});

Deno.test("ack: the AIR transport rejects in-flight on close, all on discard", async () => {
  // The live browser transport owns module-level singletons (one page, one
  // socket), so which rejection each path uses is pinned structurally. The
  // MEANING of the two is behaviour-tested above.
  const src = await Deno.readTextFile(
    "src/browser/browser-air-transport.ts",
  );
  const at = (marker: string) => {
    const i = src.indexOf(marker);
    assert(i > 0, `${marker} not found — update this guard`);
    return i;
  };
  const closeHandlers = [
    src.slice(at("_ipc.onClose("), at("_ipc.onClose(") + 1000),
    src.slice(at("ws.onclose = "), at("ws.onerror = ")),
  ];
  for (const h of closeHandlers) {
    assert(h.length > 0, "close handler not found — update this guard");
    assert(
      h.includes("_rejectInFlight("),
      "a disconnect must settle only in-flight calls: the offline queue " +
        "survives it and flushes on reconnect",
    );
    assert(
      !h.includes("_rejectAllPending("),
      "a disconnect must NOT reject queued calls — they are about to be sent",
    );
  }
  // The paths that DISCARD the queue must reject everything, and must empty
  // the queue in the same breath.
  for (const marker of ["function _protoMismatch(", "_setTeardownFn("]) {
    const at = src.indexOf(marker);
    assert(at > 0, `${marker} not found — update this guard`);
    const block = src.slice(at, at + 1200);
    assert(
      block.includes("_dropQueue(") && block.includes("_rejectAllPending("),
      `${marker} discards the queue, so it must reject those callers too`,
    );
  }
});

// ── the capability must survive wrapping ─────────────────────────────

Deno.test("transport capability: the ensureConnected wrapper still arms ack timers", () => {
  const inner = (_a: { type: string; payload?: unknown }) => {};
  (inner as unknown as Record<symbol, boolean>)[ARMS_ACK_TIMER] = true;
  assertEquals(armsAckTimer(inner), true);
  assertEquals(
    armsAckTimer(_makeSendWrapper(inner)),
    true,
    "a wrapper that loses ARMS_ACK_TIMER re-arms the clock at dispatch time, " +
      "which times out actions that are still queued offline",
  );
  // A transport that does NOT arm keeps saying so through the wrapper.
  const plain = (_a: { type: string; payload?: unknown }) => {};
  assertEquals(armsAckTimer(_makeSendWrapper(plain)), false);
});

Deno.test("transport capability: an offline dispatch does not time out while queued", async () => {
  reset();
  // A 60ms ceiling and a transport that queues everything (never arms).
  _setAckTimeoutMs(60);
  const sentCids: string[] = [];
  const transport = (
    action: { type: string; payload?: unknown; cid?: string },
  ) => {
    if (action.cid) sentCids.push(action.cid); // "queued", not written
  };
  (transport as unknown as Record<symbol, boolean>)[ARMS_ACK_TIMER] = true;

  const c = cell("offq", {
    state: { n: 0 },
    methods: {
      bump(s: { n: number }) {
        s.n++;
      },
    },
  });
  bindCellReactive(c, _makeSendWrapper(transport));

  const call = settled(
    (c as unknown as { bump: () => Promise<unknown> }).bump(),
  );
  await new Promise((r) => setTimeout(r, 200)); // 3× the ceiling
  assertEquals(
    call.done,
    false,
    "the queued call was rejected by a clock that must not have been running",
  );
  // The frame goes out now; the clock starts here and the ack settles it.
  assertEquals(sentCids.length, 1);
  _armAckTimer(sentCids[0]!);
  _resolveAck(sentCids[0]!, 1);
  await Promise.resolve();
  assert(call.done && call.ok);
  reset();
});
