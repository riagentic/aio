import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  _accessedPaths,
  _getState,
  _injectState,
  _preserveArrayRefs,
  _reset,
  _resetArrayRefStats,
  _shallowEqual,
  cancelSubsTimer,
  type CellRef,
  collapsePaths,
  createSendProxy,
  flushOfflineQueue,
  getCellSignal,
  getConnectedSignal,
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

// ── Full state injection ────────────────────────────────────────────

Deno.test("state-core: _injectState sets full state and cell signals", () => {
  setup();
  try {
    _injectState({ counter: { count: 5 }, timer: { elapsed: 10 } });

    const state = _getState();
    assertEquals(state.counter, { count: 5 });
    assertEquals(state.timer, { elapsed: 10 });

    const counterSig = getCellSignal("counter");
    assertEquals(counterSig.peek(), { count: 5 });

    const timerSig = getCellSignal("timer");
    assertEquals(timerSig.peek(), { elapsed: 10 });

    assertEquals(getStateSignal().peek(), {
      counter: { count: 5 },
      timer: { elapsed: 10 },
    });
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
    const frame = JSON.parse(sent[0]!);
    assertEquals(frame.t, "action");
    assertEquals(frame.d.type, "counter:increment");
    assertEquals(frame.d.payload, { amount: 1 });
    assertEquals(frame.d._source, "UI");
  } finally {
    _reset();
  }
});

Deno.test("state-core: offline queue when no transport", () => {
  setup();
  try {
    send({ type: "counter:increment" });
    send({ type: "counter:decrement" });

    const sent: string[] = [];
    setTransport({ send: (d: string) => sent.push(d), close: () => {} });
    flushOfflineQueue();

    assertEquals(sent.length, 2);
    assertEquals(JSON.parse(sent[0]!).d.type, "counter:increment");
    assertEquals(JSON.parse(sent[1]!).d.type, "counter:decrement");
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
    assertEquals(getCellSignal("counter").peek(), { count: 0 });
  } finally {
    _reset();
  }
});

Deno.test("state-core: handleMessage — subsequent Immer $patches delta", () => {
  setup();
  try {
    handleMessage({ counter: { count: 0 } }); // full state
    handleMessage({
      $patches: [{ op: "replace", path: ["counter", "count"], value: 42 }],
    });

    assertEquals(_getState().counter.count, 42);
    assertEquals(getCellSignal("counter").peek().count, 42);
  } finally {
    _reset();
  }
});

// ── createSendProxy ─────────────────────────────────────────────────

Deno.test("state-core: createSendProxy creates typed methods", () => {
  setup();
  try {
    const sent: string[] = [];
    setTransport({ send: (d: string) => sent.push(d), close: () => {} });

    const ref: CellRef = {
      __aio: { id: "counter", actionKeys: ["increment", "decrement"] },
    };
    const proxy = createSendProxy("counter", ref);

    proxy.increment!(5);
    proxy.decrement!(1);

    assertEquals(sent.length, 2);
    const msg1 = JSON.parse(sent[0]!).d;
    assertEquals(msg1.type, "counter:increment");
    assertEquals(msg1.payload, { args: [5] });

    const msg2 = JSON.parse(sent[1]!).d;
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

    const ref: CellRef = {
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
    const msg1 = JSON.parse(sent[0]!).d;
    assertEquals(msg1.type, "counter:increment");
    assertEquals(msg1.payload, { amount: 5 });

    const msg2 = JSON.parse(sent[1]!).d;
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
  assertEquals(_shallowEqual(null, null), true);
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
  const newArr = [{ id: "a", x: 1 }, { id: "b", x: 2 }];

  const result = _preserveArrayRefs(newArr, oldArr);
  assertStrictEquals(result, oldArr);
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
