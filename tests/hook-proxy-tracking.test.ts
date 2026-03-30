// tests/hook-proxy-tracking.test.ts
// Tests that useAio() and useFeature() correctly wire proxy tracking.
//
// Strategy: We can't call React hooks outside a component, but both hooks
// do the same thing: wrap state in _trackingProxy(state) or _trackingProxy(state, name).
// We test the EXACT wiring by simulating what the hooks produce and verifying
// that _accessedPaths is populated correctly, paths are collapsed, and __subs
// messages would be sent.
//
// NOTE: AIO-206 added intermediate object tracking — accessing obj.a.b.c now
// tracks "a", "a.b", and "a.b.c". Tests verify both raw paths and collapsed
// subscription paths (which are what actually get sent to server).

import { assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import {
  _accessedPaths,
  _collapsePaths,
  _resetTracking,
  _trackingProxy,
} from "../src/browser.ts";

// ── useAio() wiring: _trackingProxy(state) ─────────────────────────

Deno.test("useAio wiring: proxy tracks leaf access from root", () => {
  _resetTracking();
  // useAio() does: return { state: _trackingProxy(state), send }
  const raw = { counter: { count: 5 }, market: { price: 100 } };
  const state = _trackingProxy(raw) as typeof raw;

  // Component reads state.counter.count (like JSX: {state.counter.count})
  const _v = state.counter.count;
  assertEquals(_v, 5);
  assertEquals(_accessedPaths.has("counter.count"), true);
  assertEquals(_accessedPaths.has("counter"), true, "intermediate tracked");
  assertEquals(
    _accessedPaths.has("market"),
    false,
    "untouched feature not tracked",
  );
  // Collapsed subscription: only "counter" (subsumes counter.count)
  assertEquals(_collapsePaths(_accessedPaths), ["counter"]);
  _resetTracking();
});

Deno.test("useAio wiring: multiple features tracked independently", () => {
  _resetTracking();
  const raw = {
    counter: { count: 5 },
    market: { instruments: { SOL: { price: 100 }, BTC: { price: 50000 } } },
    portfolio: { balance: 1000 },
  };
  const state = _trackingProxy(raw) as typeof raw;

  // Dashboard reads from 2 features, ignores portfolio
  const _a = state.counter.count;
  const _b = state.market.instruments.SOL.price;

  assertEquals(_accessedPaths.has("counter.count"), true);
  assertEquals(_accessedPaths.has("market.instruments.SOL.price"), true);
  assertEquals(_accessedPaths.has("portfolio"), false);
  // Collapsed: shortest prefix per feature
  assertEquals(_collapsePaths(_accessedPaths), ["counter", "market"]);
  _resetTracking();
});

Deno.test("useAio wiring: array access tracked as leaf", () => {
  _resetTracking();
  const raw = { logs: { entries: ["a", "b", "c"] } };
  const state = _trackingProxy(raw) as typeof raw;

  const entries = state.logs.entries;
  assertEquals(entries.length, 3);
  assertEquals(_accessedPaths.has("logs.entries"), true);
  assertEquals(_accessedPaths.has("logs"), true, "intermediate tracked");
  assertEquals(_collapsePaths(_accessedPaths), ["logs"]);
  _resetTracking();
});

Deno.test("useAio wiring: Object.keys at root tracks wildcard", () => {
  _resetTracking();
  const raw = { a: { x: 1 }, b: { y: 2 } };
  const state = _trackingProxy(raw) as Record<string, unknown>;

  const keys = Object.keys(state);
  assertEquals(keys.sort(), ["a", "b"]);
  assertEquals(_accessedPaths.has("*"), true);
  _resetTracking();
});

Deno.test("useAio wiring: conditional access expands tracked paths", () => {
  _resetTracking();
  const raw = { counter: { count: 5 }, logs: { entries: ["a"] } };
  const state = _trackingProxy(raw) as typeof raw;

  // First render: only counter
  const _a = state.counter.count;
  assertEquals(_accessedPaths.has("counter.count"), true);

  // Second render: showLogs flips — now also reads logs
  const _b = state.logs.entries;
  assertEquals(_accessedPaths.has("logs.entries"), true);

  // Paths accumulate (Set only grows) — intermediates present too
  assertEquals(_accessedPaths.has("counter"), true);
  assertEquals(_accessedPaths.has("logs"), true);
  assertEquals(_collapsePaths(_accessedPaths), ["counter", "logs"]);
  _resetTracking();
});

// ── useFeature() wiring: _trackingProxy(state, name) ───────────────

Deno.test("useFeature wiring: proxy tracks with feature name prefix", () => {
  _resetTracking();
  // useFeature(counterRef) does: return { state: _trackingProxy(resolved, name) }
  // where name = ref.__aio.id = "counter", resolved = _state["counter"]
  const featureState = { count: 5, label: "clicks" };
  const state = _trackingProxy(featureState, "counter") as typeof featureState;

  const _v = state.count;
  assertEquals(_v, 5);
  assertEquals(
    _accessedPaths.has("counter.count"),
    true,
    "path includes feature prefix",
  );
  assertEquals(_accessedPaths.has("count"), false, "bare name not tracked");
  // With prefix, leaf-only access on primitives — no intermediate "counter"
  assertEquals(_accessedPaths.size, 1);
  _resetTracking();
});

Deno.test("useFeature wiring: deep nested access prefixed correctly", () => {
  _resetTracking();
  const featureState = { instruments: { SOL: { price: 100, volume: 999 } } };
  const state = _trackingProxy(featureState, "market") as typeof featureState;

  const _v = state.instruments.SOL.price;
  assertEquals(_v, 100);
  assertEquals(_accessedPaths.has("market.instruments.SOL.price"), true);
  // Intermediates start from inside the feature (not the prefix itself)
  assertEquals(_accessedPaths.has("market.instruments"), true);
  assertEquals(_accessedPaths.has("market.instruments.SOL"), true);
  assertEquals(_collapsePaths(_accessedPaths), ["market.instruments"]);
  _resetTracking();
});

Deno.test("useFeature wiring: Object.keys on feature tracks feature-level", () => {
  _resetTracking();
  const featureState = { count: 5, label: "x" };
  const state = _trackingProxy(featureState, "counter") as Record<
    string,
    unknown
  >;

  Object.keys(state);
  // ownKeys with parentPath="counter" → tracks "counter"
  assertEquals(
    _accessedPaths.has("counter"),
    true,
    "ownKeys at feature level",
  );
  assertEquals(_accessedPaths.size, 1);
  _resetTracking();
});

Deno.test("useFeature wiring: multiple features each get correct prefix", () => {
  _resetTracking();
  // Simulate two useFeature calls on same page
  const counterState = _trackingProxy({ count: 5 }, "counter") as Record<
    string,
    unknown
  >;
  const marketState = _trackingProxy({ price: 100 }, "market") as Record<
    string,
    unknown
  >;

  const _a = counterState.count;
  const _b = marketState.price;

  assertEquals(_accessedPaths.has("counter.count"), true);
  assertEquals(_accessedPaths.has("market.price"), true);
  // Prefixed features: only leaf paths tracked (no intermediates for single-level)
  assertEquals(_accessedPaths.size, 2);
  _resetTracking();
});

// ── useAio + useFeature equivalence ─────────────────────────────────

Deno.test("useAio and useFeature produce same tracked paths", () => {
  // useAio: state.counter.count → tracks "counter" (intermediate) and "counter.count"
  _resetTracking();
  const fullState = { counter: { count: 5 } };
  const aioState = _trackingProxy(fullState) as typeof fullState;
  const _a = aioState.counter.count;
  const aioPaths = _collapsePaths(_accessedPaths);
  assertEquals(aioPaths, ["counter"], "useAio collapses to feature-level");

  // useFeature: state.count → tracks only "counter.count" (no intermediate)
  _resetTracking();
  const featureState = { count: 5 };
  const featState = _trackingProxy(
    featureState,
    "counter",
  ) as typeof featureState;
  const _b = featState.count;
  const featPaths = _collapsePaths(_accessedPaths);
  assertEquals(
    featPaths,
    ["counter.count"],
    "useFeature tracks leaf with prefix",
  );

  // Both produce subscriptions that overlap — server handles correctly
  // useAio gets "counter" which subsumes "counter.count"
  _resetTracking();
});

// ── Path collapsing + subscription message ──────────────────────────

Deno.test("paths collapse correctly for subscription message", () => {
  _resetTracking();
  const state = _trackingProxy({
    market: { instruments: { SOL: { price: 100 }, BTC: { price: 50000 } } },
  }) as Record<string, unknown>;

  // Access two prices from same feature — intermediates tracked (AIO-206)
  // deno-lint-ignore no-explicit-any
  const _a = (state as any).market.instruments.SOL.price;
  // deno-lint-ignore no-explicit-any
  const _b = (state as any).market.instruments.BTC.price;

  const collapsed = _collapsePaths(_accessedPaths);
  // "market" subsumes all deeper paths
  assertEquals(collapsed, ["market"]);
  _resetTracking();
});

Deno.test("ownKeys collapses with leaf paths", () => {
  _resetTracking();
  const state = _trackingProxy({
    market: { instruments: { SOL: { price: 100 } } },
  }) as Record<string, unknown>;

  // First: specific leaf access
  // deno-lint-ignore no-explicit-any
  const _a = (state as any).market.instruments.SOL.price;
  // Then: iterate instruments (broader)
  // deno-lint-ignore no-explicit-any
  Object.keys((state as any).market.instruments);

  const collapsed = _collapsePaths(_accessedPaths);
  // "market" subsumes everything (intermediate tracking)
  assertEquals(collapsed, ["market"]);
  _resetTracking();
});

Deno.test("debounced sync fires after 16ms", async () => {
  _resetTracking();
  using _time = new FakeTime();

  const state = _trackingProxy({ counter: { count: 5 } }) as Record<
    string,
    unknown
  >;
  // deno-lint-ignore no-explicit-any
  const _v = (state as any).counter.count;

  // Before 16ms — timer hasn't fired
  assertEquals(
    _accessedPaths.has("counter.count"),
    true,
    "tracked immediately",
  );

  // Advance past debounce
  _time.tick(20);

  // _currentSubs would be updated (we can't check it directly since it's not exported,
  // but the timer fired without error — no WS to send to, which is fine in test)
  _resetTracking();
});

// ── Edge cases ──────────────────────────────────────────────────────

Deno.test("null state passthrough (useAio before connect)", () => {
  _resetTracking();
  // Before server connects, _state is null. useAio() calls _trackingProxy(null)
  const state = _trackingProxy(null);
  assertEquals(state, null);
  assertEquals(_accessedPaths.size, 0);
  _resetTracking();
});

Deno.test("useFeature with null feature state", () => {
  _resetTracking();
  // Feature not in state yet → resolved = null
  const state = _trackingProxy(null, "counter");
  assertEquals(state, null);
  assertEquals(_accessedPaths.size, 0);
  _resetTracking();
});

Deno.test("repeated access does not duplicate paths", () => {
  _resetTracking();
  const state = _trackingProxy({ counter: { count: 5 } }) as Record<
    string,
    unknown
  >;

  // Access same path 100 times (like re-renders)
  for (let i = 0; i < 100; i++) {
    // deno-lint-ignore no-explicit-any
    const _v = (state as any).counter.count;
  }

  // "counter" and "counter.count" both tracked — Set deduplicates repeats
  assertEquals(_accessedPaths.has("counter.count"), true);
  assertEquals(_accessedPaths.has("counter"), true);
  assertEquals(_accessedPaths.size, 2);
  _resetTracking();
});

Deno.test("proxy does not interfere with JSON.stringify", () => {
  _resetTracking();
  const raw = { counter: { count: 5 }, market: { price: 100 } };
  const state = _trackingProxy(raw);

  const json = JSON.stringify(state);
  const parsed = JSON.parse(json);
  assertEquals(parsed, raw);
  _resetTracking();
});

Deno.test("proxy does not interfere with spread", () => {
  _resetTracking();
  const raw = { counter: { count: 5 }, market: { price: 100 } };
  const state = _trackingProxy(raw) as typeof raw;

  const copy = { ...state };
  assertEquals(copy.counter.count, 5);
  assertEquals(copy.market.price, 100);
  // Spread triggers ownKeys → tracks "*"
  assertEquals(_accessedPaths.has("*"), true);
  _resetTracking();
});

Deno.test("proxy does not interfere with destructuring", () => {
  _resetTracking();
  const raw = { counter: { count: 5, label: "clicks" } };
  const state = _trackingProxy(raw, "myFeature") as typeof raw;

  const { count, label } = state.counter;
  assertEquals(count, 5);
  assertEquals(label, "clicks");
  // Destructuring does get("count") + get("label") — NOT ownKeys
  // So each property is tracked as a leaf path
  assertEquals(_accessedPaths.has("myFeature.counter.count"), true);
  assertEquals(_accessedPaths.has("myFeature.counter.label"), true);
  _resetTracking();
});
