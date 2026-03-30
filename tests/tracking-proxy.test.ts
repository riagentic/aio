// tests/tracking-proxy.test.ts
import { assertEquals } from "@std/assert";
import {
  _accessedPaths,
  _collapsePaths,
  _resetTracking,
  _trackingProxy,
} from "../src/browser.ts";

// NOTE: Every test MUST call _resetTracking() at END to clear dangling timers
// from _scheduleSyncSubs, otherwise Deno's op sanitizer will fail.

Deno.test("proxy: leaf access records full path", () => {
  _resetTracking();
  const state = { counter: { value: 5 } };
  const proxy = _trackingProxy(state) as Record<string, any>;
  const _v = proxy.counter.value;
  assertEquals(_accessedPaths.has("counter.value"), true);
  // AIO-206: intermediate object accesses are also tracked
  assertEquals(_accessedPaths.has("counter"), true);
  _resetTracking();
});

Deno.test("proxy: deep nested leaf records full dot-path", () => {
  _resetTracking();
  const state = { market: { instruments: { SOL: { price: 100 } } } };
  const proxy = _trackingProxy(state) as Record<string, any>;
  const _v = proxy.market.instruments.SOL.price;
  assertEquals(_accessedPaths.has("market.instruments.SOL.price"), true);
  // AIO-206: all intermediate paths tracked too
  assertEquals(_accessedPaths.has("market"), true);
  assertEquals(_accessedPaths.has("market.instruments"), true);
  assertEquals(_accessedPaths.has("market.instruments.SOL"), true);
  // collapsePaths reduces to shortest prefix
  assertEquals(_collapsePaths(_accessedPaths), ["market"]);
  _resetTracking();
});

Deno.test("proxy: multiple leaf accesses from same feature", () => {
  _resetTracking();
  const state = {
    market: {
      instruments: { SOL: { price: 100 }, BTC: { price: 50000 } },
    },
  };
  const proxy = _trackingProxy(state) as Record<string, any>;
  const _a = proxy.market.instruments.SOL.price;
  const _b = proxy.market.instruments.BTC.price;
  assertEquals(_accessedPaths.has("market.instruments.SOL.price"), true);
  assertEquals(_accessedPaths.has("market.instruments.BTC.price"), true);
  // Intermediates also tracked — collapsed result is what matters for subscriptions
  assertEquals(_collapsePaths(_accessedPaths), ["market"]);
  _resetTracking();
});

Deno.test("proxy: ownKeys at root records '*'", () => {
  _resetTracking();
  const state = { a: 1, b: 2 };
  const proxy = _trackingProxy(state) as Record<string, any>;
  Object.keys(proxy);
  assertEquals(_accessedPaths.has("*"), true);
  _resetTracking();
});

Deno.test("proxy: ownKeys at nested level records parent path", () => {
  _resetTracking();
  const state = { market: { instruments: { SOL: {}, BTC: {} } } };
  const proxy = _trackingProxy(state) as Record<string, any>;
  Object.keys(proxy.market.instruments);
  assertEquals(_accessedPaths.has("market.instruments"), true);
  _resetTracking();
});

Deno.test("proxy: array leaf records path (arrays are atomic)", () => {
  _resetTracking();
  const state = { logs: { entries: ["a", "b", "c"] } };
  const proxy = _trackingProxy(state) as Record<string, any>;
  const _v = proxy.logs.entries;
  assertEquals(_accessedPaths.has("logs.entries"), true);
  _resetTracking();
});

Deno.test("proxy: ignores blocked keys (__proto__)", () => {
  _resetTracking();
  const state = { counter: 1 };
  const proxy = _trackingProxy(state) as Record<string, any>;
  const _v = proxy.__proto__;
  assertEquals(_accessedPaths.has("__proto__"), false);
  _resetTracking();
});

Deno.test("proxy: null/undefined/primitive passthrough", () => {
  _resetTracking();
  assertEquals(_trackingProxy(null), null);
  assertEquals(_trackingProxy(undefined), undefined);
  assertEquals(_trackingProxy(42), 42);
  assertEquals(_trackingProxy("hello"), "hello");
  _resetTracking();
});

Deno.test("proxy: array at root returns raw (no proxy)", () => {
  _resetTracking();
  const arr = [1, 2, 3];
  assertEquals(_trackingProxy(arr) === arr, true);
  _resetTracking();
});

// ── Path collapsing tests ────────────────────────────────────────────

Deno.test("collapse: removes redundant longer paths", () => {
  const paths = new Set([
    "market.instruments",
    "market.instruments.SOL.price",
  ]);
  assertEquals(_collapsePaths(paths), ["market.instruments"]);
});

Deno.test("collapse: keeps independent paths", () => {
  const paths = new Set(["counter.value", "market.instruments.SOL.price"]);
  assertEquals(_collapsePaths(paths), [
    "counter.value",
    "market.instruments.SOL.price",
  ]);
});

Deno.test("collapse: star subsumes everything", () => {
  const paths = new Set(["*", "counter.value", "market.instruments.SOL"]);
  assertEquals(_collapsePaths(paths), ["*"]);
});

Deno.test("collapse: empty set returns empty", () => {
  assertEquals(_collapsePaths(new Set()), []);
});

Deno.test("collapse: single path unchanged", () => {
  assertEquals(_collapsePaths(new Set(["a.b.c"])), ["a.b.c"]);
});

Deno.test("collapse: does not collapse non-prefix matches", () => {
  // "a.b" should NOT collapse "a.bc" (not a path prefix)
  const paths = new Set(["a.b", "a.bc"]);
  assertEquals(_collapsePaths(paths), ["a.b", "a.bc"]);
});
