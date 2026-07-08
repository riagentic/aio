import { assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import {
  _pendingAckCount,
  _registerAck,
  _rejectAck,
  _rejectAllPending,
  _resolveAck,
  _setAckTimeoutMs,
} from "../src/protocol/browser-ack.ts";
import {
  _resetCellRegistry,
  bindCellReactive,
} from "../src/state/cell-reactive.ts";
import { _resetSignals } from "../src/state/state-signals.ts";

// Tests for 2.2: browser-side method calls return a Promise that resolves
// when the server has acked the dispatch. The ack path is exercised via the
// _resolveAck / _rejectAck / _rejectAllPending helpers — the actual server
// transport is integration-tested elsewhere.

function reset() {
  _resetCellRegistry();
  _resetSignals();
  _rejectAllPending(new Error("test reset"));
}

Deno.test(
  "2.2: bindCellReactive returns a Promise that resolves on _resolveAck",
  async () => {
    reset();
    _setAckTimeoutMs(0);

    const c = cell("counter", {
      state: { count: 0 },
      methods: {
        increment(s) {
          s.count++;
        },
      },
    });

    const sentCids: string[] = [];
    bindCellReactive(c, (action) => {
      if (action.cid) sentCids.push(action.cid);
    });

    const result = c.increment();
    // Wait one microtask for the wrapper to actually call sendFn.
    await Promise.resolve();
    assertEquals(sentCids.length, 1);

    // Simulate server ack
    _resolveAck(sentCids[0]!);
    await result;
    assertEquals(_pendingAckCount(), 0);

    reset();
  },
);

Deno.test(
  "2.2: ack rejection surfaces as a rejected promise to the awaiter",
  async () => {
    reset();
    _setAckTimeoutMs(0);

    const c = cell("counter2", {
      state: { count: 0 },
      methods: {
        increment(s) {
          s.count++;
        },
      },
    });

    let sentCid: string | undefined;
    bindCellReactive(c, (action) => {
      sentCid = action.cid;
    });

    const result = c.increment();
    await Promise.resolve();
    assertEquals(sentCid !== undefined, true);

    // Simulate server rejection
    _rejectAck(sentCid!, new Error("server rejected action"));
    let caught: Error | null = null;
    try {
      await result;
    } catch (e) {
      caught = e as Error;
    }
    assertEquals(caught instanceof Error, true);
    assertEquals(
      (caught as unknown as Error).message,
      "server rejected action",
    );

    reset();
  },
);

Deno.test("2.2: timeout rejects the promise with a clear message", async () => {
  reset();
  _setAckTimeoutMs(50);

  const c = cell("counter3", {
    state: { count: 0 },
    methods: {
      increment(s) {
        s.count++;
      },
    },
  });

  bindCellReactive(c, (_action) => {/* no ack */});

  const result = c.increment();
  let caught: Error | null = null;
  try {
    await result;
  } catch (e) {
    caught = e as Error;
  }
  assertEquals(caught instanceof Error, true);
  assertEquals(
    (caught as unknown as Error).message.includes("not acknowledged in 50ms"),
    true,
  );

  reset();
});

Deno.test("2.2: _rejectAllPending rejects all in-flight acks", async () => {
  reset();
  _setAckTimeoutMs(0);

  const promises: Promise<void>[] = [];
  promises.push(_registerAck("a"));
  promises.push(_registerAck("b"));
  promises.push(_registerAck("c"));
  assertEquals(_pendingAckCount(), 3);

  _rejectAllPending(new Error("connection lost"));

  for (const p of promises) {
    let caught: Error | null = null;
    try {
      await p;
    } catch (e) {
      caught = e as Error;
    }
    assertEquals(
      (caught as unknown as Error).message,
      "connection lost",
    );
  }
  assertEquals(_pendingAckCount(), 0);

  reset();
});

Deno.test(
  "2.2: fire-and-forget — wrapper silences unhandled rejection",
  async () => {
    reset();
    _setAckTimeoutMs(50);

    const c = cell("counter4", {
      state: { count: 0 },
      methods: {
        increment(s) {
          s.count++;
        },
      },
    });

    let sentCid: string | undefined;
    bindCellReactive(c, (action) => {
      sentCid = action.cid;
    });

    // Do NOT await — fire-and-forget
    const p = c.increment();
    await Promise.resolve();
    // Reject the pending ack — the wrapper's no-op .catch() should swallow
    // the unhandled rejection. We still observe the rejection if we await.
    _rejectAck(sentCid!, new Error("server rejected action"));
    await new Promise((r) => setTimeout(r, 0));
    let caught: Error | null = null;
    try {
      await p;
    } catch (e) {
      caught = e as Error;
    }
    assertEquals(
      (caught as unknown as Error).message,
      "server rejected action",
    );

    reset();
  },
);
