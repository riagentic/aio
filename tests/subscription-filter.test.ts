// tests/subscription-filter.test.ts
import { assertEquals } from "@std/assert";
import { _filterByPaths } from "../src/server.ts";

Deno.test("filter: extracts single top-level feature", () => {
  const state = {
    counter: { value: 5 },
    market: { price: 100 },
    logs: { entries: [] },
  };
  const result = _filterByPaths(state, new Set(["counter"]));
  assertEquals(result, { counter: { value: 5 } });
});

Deno.test("filter: extracts nested path", () => {
  const state = {
    market: {
      instruments: { SOL: { price: 100 }, BTC: { price: 50000 } },
      meta: { ts: 1 },
    },
  };
  const result = _filterByPaths(state, new Set(["market.instruments.SOL"]));
  assertEquals(result, { market: { instruments: { SOL: { price: 100 } } } });
  assertEquals(
    "BTC" in (result.market as Record<string, unknown> as any).instruments,
    false,
  );
  assertEquals("meta" in (result.market as Record<string, unknown>), false);
});

Deno.test("filter: extracts deep leaf path", () => {
  const state = {
    market: { instruments: { SOL: { price: 100, volume: 999 } } },
  };
  const result = _filterByPaths(
    state,
    new Set(["market.instruments.SOL.price"]),
  );
  assertEquals(result, { market: { instruments: { SOL: { price: 100 } } } });
});

Deno.test("filter: multiple paths from different features", () => {
  const state = {
    counter: { value: 5 },
    portfolio: { balance: 1000, positions: {} },
  };
  const result = _filterByPaths(
    state,
    new Set(["counter.value", "portfolio.balance"]),
  );
  assertEquals(result, { counter: { value: 5 }, portfolio: { balance: 1000 } });
});

Deno.test("filter: star path returns full state", () => {
  const state = { a: 1, b: 2 };
  const result = _filterByPaths(state, new Set(["*"]));
  assertEquals(result, { a: 1, b: 2 });
});

Deno.test("filter: returns empty for null state", () => {
  assertEquals(_filterByPaths(null, new Set(["x"])), {});
});

Deno.test("filter: returns empty for array state", () => {
  assertEquals(_filterByPaths([1, 2], new Set(["x"])), {});
});

Deno.test("filter: returns empty when no paths match", () => {
  assertEquals(_filterByPaths({ a: 1 }, new Set(["nonexistent"])), {});
});

Deno.test("filter: missing intermediate path returns empty", () => {
  const state = { market: { instruments: {} } };
  const result = _filterByPaths(
    state,
    new Set(["market.instruments.SOL.price"]),
  );
  assertEquals(result, {});
});

Deno.test("filter: preserves object references (no deep copy)", () => {
  const solObj = { price: 100, volume: 999 };
  const state = { market: { instruments: { SOL: solObj } } };
  const result = _filterByPaths(state, new Set(["market.instruments.SOL"]));
  const sol = (result.market as any).instruments.SOL;
  assertEquals(sol === solObj, true, "should preserve original reference");
});

Deno.test("filter: empty path set returns empty", () => {
  assertEquals(_filterByPaths({ a: 1 }, new Set()), {});
});

Deno.test("filter: overlapping paths — shorter wins", () => {
  const state = {
    market: { instruments: { SOL: { price: 100 }, BTC: { price: 50000 } } },
  };
  const result = _filterByPaths(
    state,
    new Set(["market.instruments", "market.instruments.SOL.price"]),
  );
  assertEquals(result, {
    market: { instruments: { SOL: { price: 100 }, BTC: { price: 50000 } } },
  });
});

Deno.test("filter: null leaf value is preserved (not dropped)", () => {
  const state = { user: { avatar: null, name: "alice" } };
  const result = _filterByPaths(state, new Set(["user.avatar"]));
  assertEquals(result, { user: { avatar: null } });
});
