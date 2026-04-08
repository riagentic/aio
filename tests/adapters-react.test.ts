import { assertEquals, assertExists } from "@std/assert";
import {
  _accessedPaths,
  _injectDelta,
  _injectState,
  _reset,
  _resetArrayRefStats,
  _resolveWithFallback,
  _trackingProxy,
  cancelSubsTimer,
  type CellRef,
  createSendProxy,
  getCellSignal,
  getConnectedSignal,
  getStateSignal,
  setConnected,
  setTransport,
  trackPath,
} from "../src/state-core.ts";

// Verify the adapter module exports the expected hooks
import * as reactAdapter from "../src/adapters/react.ts";

function setup() {
  _reset();
  _resetArrayRefStats();
  _accessedPaths.clear();
}

// ── Adapter exports ─────────────────────────────────────────────────

Deno.test("react adapter: exports useCell", () => {
  assertExists(reactAdapter.useCell);
  assertEquals(typeof reactAdapter.useCell, "function");
});

Deno.test("react adapter: exports useAio", () => {
  assertExists(reactAdapter.useAio);
  assertEquals(typeof reactAdapter.useAio, "function");
});

Deno.test("react adapter: exports useLocal", () => {
  assertExists(reactAdapter.useLocal);
  assertEquals(typeof reactAdapter.useLocal, "function");
});

Deno.test("react adapter: exports useConnected", () => {
  assertExists(reactAdapter.useConnected);
  assertEquals(typeof reactAdapter.useConnected, "function");
});

// ── Signal subscription (powers the React hooks) ────────────────────

Deno.test("react adapter: cell signal fires on state injection", () => {
  setup();
  try {
    const sig = getCellSignal("counter", { count: 0 });
    let fired = 0;
    const unsub = sig.subscribe(() => {
      fired++;
    });

    _injectState({ counter: { count: 42 } });
    assertEquals(fired > 0, true);
    assertEquals(sig.peek().count, 42);

    unsub();
  } finally {
    _reset();
  }
});

Deno.test("react adapter: cell signal fires on delta", () => {
  setup();
  try {
    _injectState({ counter: { count: 0 } });
    const sig = getCellSignal("counter");
    let fired = 0;
    const unsub = sig.subscribe(() => {
      fired++;
    });

    _injectDelta({ $p: { counter: { count: 10 } } });
    assertEquals(fired > 0, true);
    assertEquals(sig.peek().count, 10);

    unsub();
  } finally {
    _reset();
  }
});

Deno.test("react adapter: state signal fires on any change", () => {
  setup();
  try {
    _injectState({ counter: { count: 0 } });
    const sig = getStateSignal();
    let fired = 0;
    const unsub = sig.subscribe(() => {
      fired++;
    });

    _injectDelta({ $p: { counter: { count: 5 } } });
    assertEquals(fired > 0, true);
    assertEquals(
      (sig.peek() as Record<string, Record<string, number>>).counter!.count,
      5,
    );

    unsub();
  } finally {
    _reset();
  }
});

Deno.test("react adapter: connected signal fires on setConnected", () => {
  setup();
  try {
    const sig = getConnectedSignal();
    assertEquals(sig.peek(), false);
    let fired = 0;
    const unsub = sig.subscribe(() => {
      fired++;
    });

    setConnected(true);
    assertEquals(fired > 0, true);
    assertEquals(sig.peek(), true);

    unsub();
  } finally {
    _reset();
  }
});

// ── Shared utilities used by the adapter ────────────────────────────

Deno.test("react adapter: _trackingProxy records leaf paths", () => {
  setup();
  try {
    _injectState({ counter: { count: 5, label: "hi" } });
    const state = _injectState as unknown; // just need an object
    const obj = { count: 5, label: "hi" };
    const proxy = _trackingProxy(obj, "counter");

    // Access leaves
    assertEquals((proxy as Record<string, unknown>).count, 5);
    assertEquals((proxy as Record<string, unknown>).label, "hi");

    assertEquals(_accessedPaths.has("counter.count"), true);
    assertEquals(_accessedPaths.has("counter.label"), true);
  } finally {
    cancelSubsTimer();
    _reset();
  }
});

Deno.test("react adapter: _trackingProxy ownKeys tracks parent or wildcard", () => {
  setup();
  try {
    const obj = { a: 1, b: 2 };
    const proxy = _trackingProxy(obj, "feat");
    Object.keys(proxy as Record<string, unknown>);
    assertEquals(_accessedPaths.has("feat"), true);

    _accessedPaths.clear();
    const rootProxy = _trackingProxy(obj);
    Object.keys(rootProxy as Record<string, unknown>);
    assertEquals(_accessedPaths.has("*"), true);
  } finally {
    cancelSubsTimer();
    _reset();
  }
});

Deno.test("react adapter: _resolveWithFallback merges defaults", () => {
  // null state → returns defaults
  assertEquals(_resolveWithFallback(null, { count: 0 }), { count: 0 });

  // partial state → merges with defaults
  assertEquals(
    _resolveWithFallback({ count: 5 }, { count: 0, label: "hi" }),
    { count: 5, label: "hi" },
  );

  // full state → returns as-is
  assertEquals(
    _resolveWithFallback({ count: 5, label: "world" }, {
      count: 0,
      label: "hi",
    }),
    { count: 5, label: "world" },
  );

  // no defaults → returns state as-is
  assertEquals(_resolveWithFallback({ count: 5 }, undefined), { count: 5 });

  // null state, no defaults → returns null
  assertEquals(_resolveWithFallback(null, undefined), null);
});

// CellRef interface requires __aio — this is the public type shape for client-side cell references
Deno.test("react adapter: createSendProxy with action creators", () => {
  setup();
  try {
    const sent: string[] = [];
    setTransport({ send: (d: string) => sent.push(d), close: () => {} });

    const ref: CellRef = {
      __aio: {
        id: "counter",
        actionKeys: ["increment"],
        actions: {
          increment: (n: number) => ({
            type: "counter:increment",
            payload: { amount: n },
          }),
        },
      },
    };
    const proxy = createSendProxy("counter", ref);
    proxy.increment!(7);

    assertEquals(sent.length, 1);
    const msg = JSON.parse(sent[0]!);
    assertEquals(msg.type, "counter:increment");
    assertEquals(msg.payload, { amount: 7 });
  } finally {
    _reset();
  }
});

Deno.test("react adapter: createSendProxy fallback without creators", () => {
  setup();
  try {
    const sent: string[] = [];
    setTransport({ send: (d: string) => sent.push(d), close: () => {} });

    const ref: CellRef = {
      __aio: { id: "counter", actionKeys: ["increment"] },
    };
    const proxy = createSendProxy("counter", ref);
    proxy.increment!(7);

    assertEquals(sent.length, 1);
    const msg = JSON.parse(sent[0]!);
    assertEquals(msg.type, "counter:increment");
    assertEquals(msg.payload, { args: [7] });
  } finally {
    _reset();
  }
});
