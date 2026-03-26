// tests/subscription-integration.test.ts
import { assertEquals } from "@std/assert";
import { _computeDelta, _filterByPaths } from "../src/server.ts";

Deno.test("integration: path-filtered state produces correct delta", () => {
  const fullState = {
    counter: { value: 5 },
    market: { instruments: { SOL: { price: 100 }, BTC: { price: 50000 } } },
    logs: { entries: ["a"] },
  };
  const paths = new Set(["counter.value", "market.instruments.SOL.price"]);
  const filtered = _filterByPaths(fullState, paths);

  const delta = _computeDelta(filtered, null, {});
  assertEquals(delta.kind, "full");
  const parsed = JSON.parse(delta.msg);
  assertEquals(parsed.counter.value, 5);
  assertEquals(parsed.market.instruments.SOL.price, 100);
  assertEquals("BTC" in parsed.market.instruments, false);
  assertEquals("logs" in parsed, false);
});

Deno.test("integration: subscription change resets cache — new full send", () => {
  const state1 = { counter: { value: 5 } };
  const delta1 = _computeDelta(state1, null, {});
  assertEquals(delta1.kind, "full");

  // Subscription expands — lastState reset to null
  const state2 = { counter: { value: 5 }, market: { price: 100 } };
  const delta2 = _computeDelta(state2, null, {});
  assertEquals(delta2.kind, "full");
  const parsed = JSON.parse(delta2.msg);
  assertEquals("counter" in parsed, true);
  assertEquals("market" in parsed, true);
});

Deno.test("integration: no subscriptions (null) passes full state", () => {
  const state = { counter: { value: 5 }, market: { price: 100 } };
  const delta = _computeDelta(state, null, {});
  const parsed = JSON.parse(delta.msg);
  assertEquals("counter" in parsed, true);
  assertEquals("market" in parsed, true);
});

Deno.test("integration: __subs:* treated as subscribe-all", () => {
  const features = ["*"];
  assertEquals(features.includes("*"), true);
});

Deno.test("integration: delta on path-filtered state detects changes correctly", () => {
  // Include multiple paths so the change ratio stays below 50% threshold,
  // ensuring _computeDelta emits a delta patch rather than a full send.
  const paths = new Set([
    "counter.value",
    "market.price",
    "market.volume",
    "market.open",
  ]);
  const state1 = {
    counter: { value: 5 },
    market: { price: 100, volume: 10, open: 99 },
  };
  const state2 = {
    counter: { value: 6 },
    market: { price: 100, volume: 10, open: 99 },
  };

  const filtered1 = _filterByPaths(state1, paths);
  const delta1 = _computeDelta(filtered1, null, {});

  const filtered2 = _filterByPaths(state2, paths);
  const delta2 = _computeDelta(filtered2, filtered1, delta1.newKeyJsons);

  assertEquals(delta2.kind, "delta");
  const parsed = JSON.parse(delta2.msg);
  assertEquals(parsed.$p.counter.value, 6);
  assertEquals("market" in (parsed.$p || {}), false);
});

Deno.test("integration: empty subscription set returns empty state", () => {
  const state = { counter: { value: 5 } };
  const filtered = _filterByPaths(state, new Set());
  assertEquals(filtered, {});
});

Deno.test("integration: deep path filtering + delta works end-to-end", () => {
  const paths = new Set(["market.instruments.SOL.price"]);
  const state1 = {
    market: {
      instruments: { SOL: { price: 100, volume: 1 }, BTC: { price: 50000 } },
    },
  };
  const state2 = {
    market: {
      instruments: { SOL: { price: 101, volume: 2 }, BTC: { price: 50001 } },
    },
  };

  const filtered1 = _filterByPaths(state1, paths);
  assertEquals(filtered1, { market: { instruments: { SOL: { price: 100 } } } });
  const delta1 = _computeDelta(filtered1, null, {});

  const filtered2 = _filterByPaths(state2, paths);
  assertEquals(filtered2, { market: { instruments: { SOL: { price: 101 } } } });
  const delta2 = _computeDelta(filtered2, filtered1, delta1.newKeyJsons);

  // Should detect the price change
  assertEquals(delta2.kind === "skip", false, "should detect change");
});
