import {
  assertEquals,
  assertNotStrictEquals,
  assertStrictEquals,
} from "@std/assert";
import {
  _accessedPaths,
  _applyArrPatch,
  _applyPatch,
  _deepMergeFiltered,
  _getState,
  _injectDelta,
  _injectState,
  _preserveArrayRefs,
  _rebuildIdMaps,
  _reset,
  _resetArrayRefStats,
  _shallowEqual,
  cancelSubsTimer,
  collapsePaths,
  createSendProxy,
  type FeatureRef,
  flushOfflineQueue,
  getConnectedSignal,
  getFeatureSignal,
  getStateSignal,
  handleMessage,
  isInitialStateReceived,
  ready,
  send,
  setConnected,
  setTransport,
  trackPath,
  type Transport,
} from "../src/state-core.ts";

// ── Helpers ─────────────────────────────────────────────────────────

function setup() {
  _reset();
  _resetArrayRefStats();
}

// ── Delta tests ─────────────────────────────────────────────────────

Deno.test("state-core: _injectState sets full state and feature signals", () => {
  setup();
  try {
    _injectState({ counter: { count: 5 }, timer: { elapsed: 10 } });

    const state = _getState();
    assertEquals(state.counter, { count: 5 });
    assertEquals(state.timer, { elapsed: 10 });

    // Feature signals should be populated
    const counterSig = getFeatureSignal("counter");
    assertEquals(counterSig.peek(), { count: 5 });

    const timerSig = getFeatureSignal("timer");
    assertEquals(timerSig.peek(), { elapsed: 10 });

    // Full state signal
    assertEquals(getStateSignal().peek(), {
      counter: { count: 5 },
      timer: { elapsed: 10 },
    });
  } finally {
    _reset();
  }
});

Deno.test("state-core: _injectDelta applies $p patch", () => {
  setup();
  try {
    _injectState({ counter: { count: 5, label: "hello" } });
    _injectDelta({ $p: { counter: { count: 10 } } });

    const state = _getState();
    assertEquals(state.counter.count, 10);
    assertEquals(state.counter.label, "hello"); // preserved

    // Feature signal updated
    assertEquals(getFeatureSignal("counter").peek().count, 10);
  } finally {
    _reset();
  }
});

Deno.test("state-core: _injectDelta applies $d deletion", () => {
  setup();
  try {
    _injectState({
      counter: { count: 5, label: "hello" },
      timer: { elapsed: 10 },
    });
    _injectDelta({ $p: {}, $d: ["timer"] });

    const state = _getState();
    assertEquals(state.timer, undefined);
    assertEquals(state.counter.count, 5); // untouched
  } finally {
    _reset();
  }
});

Deno.test("state-core: identity array patch ($arr)", () => {
  setup();
  try {
    _injectState({
      todos: {
        items: [
          { id: "a", text: "one" },
          { id: "b", text: "two" },
        ],
      },
    });
    _injectDelta({
      $p: {
        todos: {
          items: {
            $arr: true,
            "$id:a": { id: "a", text: "ONE" },
            "$id:c": { id: "c", text: "three" },
          },
        },
      },
    });

    const state = _getState();
    const items = state.todos.items;
    assertEquals(items.length, 3);
    assertEquals(items[0], { id: "a", text: "ONE" });
    assertEquals(items[1], { id: "b", text: "two" });
    assertEquals(items[2], { id: "c", text: "three" });
  } finally {
    _reset();
  }
});

Deno.test("state-core: identity array patch with $rm", () => {
  setup();
  try {
    _injectState({
      todos: {
        items: [
          { id: "a", text: "one" },
          { id: "b", text: "two" },
          { id: "c", text: "three" },
        ],
      },
    });
    _injectDelta({
      $p: {
        todos: {
          items: {
            $arr: true,
            $rm: ["b"],
          },
        },
      },
    });

    const state = _getState();
    assertEquals(state.todos.items.length, 2);
    assertEquals(state.todos.items[0], { id: "a", text: "one" });
    assertEquals(state.todos.items[1], { id: "c", text: "three" });
  } finally {
    _reset();
  }
});

Deno.test("state-core: filtered state merge ($f)", () => {
  setup();
  try {
    _injectState({
      ratelimit: { stats: { total: 10, average: 5 }, enabled: true },
    });
    _injectDelta({
      $f: 1,
      $p: { ratelimit: { stats: { total: 20 } } },
    });

    const state = _getState();
    assertEquals(state.ratelimit.stats.total, 20);
    assertEquals(state.ratelimit.stats.average, 5); // preserved via deep merge
    assertEquals(state.ratelimit.enabled, true); // preserved
  } finally {
    _reset();
  }
});

Deno.test("state-core: blocked keys rejected", () => {
  setup();
  try {
    _injectState({ safe: { value: 1 } });
    // Use _applyPatch directly to test blocked keys
    const result = _applyPatch(
      { safe: { value: 1 } },
      { $p: { __proto__: { evil: true }, safe: { value: 2 } } },
    );
    assertEquals(result.__proto__, undefined); // blocked
    assertEquals((result.safe as Record<string, unknown>).value, 2); // safe key applied
  } finally {
    _reset();
  }
});

Deno.test("state-core: blocked keys in nested patches rejected", () => {
  setup();
  try {
    const result = _applyPatch(
      { feat: { ok: 1 } },
      { $p: { feat: { constructor: "bad", ok: 2 } } },
    );
    const feat = result.feat as Record<string, unknown>;
    // "constructor" is blocked — should not appear as own property
    assertEquals(
      Object.prototype.hasOwnProperty.call(feat, "constructor"),
      false,
    );
    assertEquals(feat.ok, 2);
  } finally {
    _reset();
  }
});

Deno.test("state-core: _reset clears all state", () => {
  setup();
  try {
    _injectState({ counter: { count: 5 } });
    assertEquals(_getState().counter.count, 5);

    _reset();
    assertEquals(_getState(), {});
    assertEquals(getConnectedSignal().peek(), false);
    assertEquals(isInitialStateReceived(), false);
  } finally {
    _reset();
  }
});

// ── Transport and send ──────────────────────────────────────────────

Deno.test("state-core: send via transport", () => {
  setup();
  try {
    const sent: string[] = [];
    const transport: Transport = {
      send: (data: string) => sent.push(data),
      close: () => {},
    };
    setTransport(transport);
    send({ type: "counter:increment", payload: { amount: 1 } });

    assertEquals(sent.length, 1);
    const parsed = JSON.parse(sent[0]!);
    assertEquals(parsed.type, "counter:increment");
    assertEquals(parsed.payload, { amount: 1 });
    assertEquals(parsed._source, "UI");
  } finally {
    _reset();
  }
});

Deno.test("state-core: offline queue when no transport", () => {
  setup();
  try {
    // No transport set — actions should be queued
    send({ type: "counter:increment" });
    send({ type: "counter:decrement" });

    // Now set transport and flush
    const sent: string[] = [];
    setTransport({ send: (d: string) => sent.push(d), close: () => {} });
    flushOfflineQueue();

    assertEquals(sent.length, 2);
    assertEquals(JSON.parse(sent[0]!).type, "counter:increment");
    assertEquals(JSON.parse(sent[1]!).type, "counter:decrement");
  } finally {
    _reset();
  }
});

Deno.test("state-core: flushOfflineQueue sends queued actions", () => {
  setup();
  try {
    send({ type: "a" });
    send({ type: "b" });
    send({ type: "c" });

    const sent: string[] = [];
    setTransport({ send: (d: string) => sent.push(d), close: () => {} });
    flushOfflineQueue();

    assertEquals(sent.length, 3);

    // Flush again — should be empty now
    const sent2: string[] = [];
    setTransport({ send: (d: string) => sent2.push(d), close: () => {} });
    flushOfflineQueue();
    assertEquals(sent2.length, 0);
  } finally {
    _reset();
  }
});

// ── Subscription tracking ───────────────────────────────────────────

Deno.test("state-core: trackPath adds to _accessedPaths", () => {
  setup();
  try {
    trackPath("counter.count");
    trackPath("timer.elapsed");
    trackPath("counter.count"); // duplicate — should not add twice

    assertEquals(_accessedPaths.size, 2);
    assertEquals(_accessedPaths.has("counter.count"), true);
    assertEquals(_accessedPaths.has("timer.elapsed"), true);
  } finally {
    cancelSubsTimer();
    _reset();
  }
});

Deno.test("state-core: collapsePaths removes redundant paths", () => {
  setup();
  try {
    const collapsed = collapsePaths(
      new Set(["a.b", "a.b.c.d", "a.b.e", "x.y"]),
    );
    assertEquals(collapsed, ["a.b", "x.y"]);

    // Wildcard collapses everything
    const collapsed2 = collapsePaths(["*", "a.b", "c.d"]);
    assertEquals(collapsed2, ["*"]);
  } finally {
    _reset();
  }
});

// ── handleMessage ───────────────────────────────────────────────────

Deno.test("state-core: handleMessage — first message is full state", () => {
  setup();
  try {
    assertEquals(isInitialStateReceived(), false);

    handleMessage({ counter: { count: 0 }, timer: { elapsed: 0 } });

    assertEquals(isInitialStateReceived(), true);
    assertEquals(_getState().counter.count, 0);
    assertEquals(_getState().timer.elapsed, 0);
    assertEquals(getFeatureSignal("counter").peek(), { count: 0 });
  } finally {
    _reset();
  }
});

Deno.test("state-core: handleMessage — subsequent delta", () => {
  setup();
  try {
    handleMessage({ counter: { count: 0 } }); // full state
    handleMessage({ $p: { counter: { count: 42 } } }); // delta

    assertEquals(_getState().counter.count, 42);
    assertEquals(getFeatureSignal("counter").peek().count, 42);
  } finally {
    _reset();
  }
});

// Browser signal filtering removed from state-core (Issue #5).
// Caller (browser.ts) is now responsible for filtering __reload, __css, __boot
// before calling handleMessage(). No test needed here.

// ── createSendProxy ─────────────────────────────────────────────────

Deno.test("state-core: createSendProxy creates typed methods", () => {
  setup();
  try {
    const sent: string[] = [];
    setTransport({ send: (d: string) => sent.push(d), close: () => {} });

    const ref: FeatureRef = {
      __aio: { id: "counter", actionKeys: ["increment", "decrement"] },
    };
    const proxy = createSendProxy("counter", ref);

    proxy.increment!(5);
    proxy.decrement!(1);

    assertEquals(sent.length, 2);
    const msg1 = JSON.parse(sent[0]!);
    assertEquals(msg1.type, "counter:increment");
    assertEquals(msg1.payload, { args: [5] });

    const msg2 = JSON.parse(sent[1]!);
    assertEquals(msg2.type, "counter:decrement");
    assertEquals(msg2.payload, { args: [1] });
  } finally {
    _reset();
  }
});

Deno.test("state-core: createSendProxy uses action creators when available", () => {
  setup();
  try {
    const sent: string[] = [];
    setTransport({ send: (d: string) => sent.push(d), close: () => {} });

    const ref: FeatureRef = {
      __aio: {
        id: "counter",
        actionKeys: ["increment", "reset"],
        actions: {
          increment: (amount: number) => ({
            type: "counter:increment",
            payload: { amount },
          }),
          reset: () => ({ type: "counter:reset", payload: {} }),
        },
      },
    };
    const proxy = createSendProxy("counter", ref);

    proxy.increment!(5);
    proxy.reset!();

    assertEquals(sent.length, 2);
    const msg1 = JSON.parse(sent[0]!);
    assertEquals(msg1.type, "counter:increment");
    assertEquals(msg1.payload, { amount: 5 }); // structured payload, not { args }

    const msg2 = JSON.parse(sent[1]!);
    assertEquals(msg2.type, "counter:reset");
    assertEquals(msg2.payload, {});
  } finally {
    _reset();
  }
});

// ── ready() ─────────────────────────────────────────────────────────

Deno.test("state-core: ready() resolves on first state", async () => {
  setup();
  try {
    const p = ready();
    // Send first message
    handleMessage({ counter: { count: 99 } });
    const result = await p;
    assertEquals(result, { counter: { count: 99 } });
  } finally {
    _reset();
  }
});

// ── _shallowEqual ───────────────────────────────────────────────────

Deno.test("state-core: _shallowEqual basics", () => {
  assertEquals(_shallowEqual({ a: 1, b: 2 }, { a: 1, b: 2 }), true);
  assertEquals(_shallowEqual({ a: 1 }, { a: 2 }), false);
  assertEquals(_shallowEqual({ a: 1 }, { a: 1, b: 2 }), false);
  assertEquals(_shallowEqual(null, null), true); // a === b
  assertEquals(_shallowEqual(null, { a: 1 }), false);
  assertEquals(_shallowEqual(1, 1), true);
  assertEquals(_shallowEqual(1, 2), false);
});

// ── _preserveArrayRefs ──────────────────────────────────────────────

Deno.test("state-core: _preserveArrayRefs preserves unchanged refs", () => {
  _resetArrayRefStats();
  const obj1 = { id: "a", x: 1 };
  const obj2 = { id: "b", x: 2 };
  const oldArr = [obj1, obj2];
  const newArr = [{ id: "a", x: 1 }, { id: "b", x: 2 }]; // same content, new refs

  const result = _preserveArrayRefs(newArr, oldArr);
  assertStrictEquals(result, oldArr); // all same → return old ref
  assertStrictEquals(result[0], obj1);
  assertStrictEquals(result[1], obj2);
});

Deno.test("state-core: _preserveArrayRefs returns new when lengths differ", () => {
  _resetArrayRefStats();
  const oldArr = [1, 2];
  const newArr = [1, 2, 3];
  const result = _preserveArrayRefs(newArr, oldArr);
  assertStrictEquals(result, newArr);
});

// ── setConnected ────────────────────────────────────────────────────

Deno.test("state-core: setConnected updates connected signal", () => {
  setup();
  try {
    assertEquals(getConnectedSignal().peek(), false);
    setConnected(true);
    assertEquals(getConnectedSignal().peek(), true);
    setConnected(false);
    assertEquals(getConnectedSignal().peek(), false);
  } finally {
    _reset();
  }
});

// ── Nested deletion in delta ────────────────────────────────────────

Deno.test("state-core: nested $d deletion within feature patch", () => {
  setup();
  try {
    _injectState({ feat: { a: 1, b: 2, c: 3 } });
    // _applyPatch with nested $d
    const result = _applyPatch(
      { feat: { a: 1, b: 2, c: 3 } },
      { $p: { feat: { a: 10, $d: ["b"] } } },
    );
    const feat = result.feat as Record<string, unknown>;
    assertEquals(feat.a, 10);
    assertEquals(feat.b, undefined); // deleted
    assertEquals(feat.c, 3); // preserved
  } finally {
    _reset();
  }
});

// ── Deep merge filtered preserves nested keys ───────────────────────

Deno.test("state-core: _deepMergeFiltered preserves sub-sub-keys (AIO-31)", () => {
  const prev = {
    stats: { total: 10, average: 5, details: { x: 1, y: 2 } },
    enabled: true,
  };
  const incoming = {
    stats: { total: 20, details: { x: 99 } },
  };
  const result = _deepMergeFiltered(prev, incoming);
  assertEquals(result.enabled, true); // untouched top-level
  assertEquals((result.stats as Record<string, unknown>).total, 20); // updated
  assertEquals((result.stats as Record<string, unknown>).average, 5); // preserved
  const details = (result.stats as Record<string, unknown>).details as Record<
    string,
    unknown
  >;
  assertEquals(details.x, 99); // updated
  assertEquals(details.y, 2); // preserved deep
});
