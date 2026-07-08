import { assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { composeCellsWiring } from "../src/server/aio-composition.ts";

// Tests for 1.1: persist default is "all" — zero-config persists everything.

// Helper: compose cells via the same wiring aio.run() uses and read autoGetDBState.
function dbStateOf(
  cellEntries: Parameters<typeof composeCellsWiring>[0]["cellEntries"],
  cellDefaults?: Parameters<typeof composeCellsWiring>[0]["cellDefaults"],
  state: Record<string, unknown> = {},
) {
  const wiring = composeCellsWiring({
    cellEntries,
    ...(cellDefaults !== undefined ? { cellDefaults } : {}),
  });
  return wiring.autoGetDBState(state);
}

const counter = cell("counter", {
  state: { count: 0, label: "x" },
  methods: {
    increment(s, by = 1) {
      s.count += by;
    },
  },
});

const cache = cell("cache", {
  state: { hits: 0, lastKey: "" },
  methods: {
    bump(s) {
      s.hits += 1;
    },
  },
});

Deno.test("1.1 A: zero-config — DB getter returns full slice for every cell", () => {
  const result = dbStateOf([counter], undefined, {
    counter: { count: 5, label: "y" },
  }) as Record<string, unknown>;
  assertEquals(result, { counter: { count: 5, label: "y" } });
});

Deno.test("1.1 B: persist: 'none' on a cell omits that cell from DB state", () => {
  const noneCounter = cell("counter", {
    state: { count: 0 },
    persist: "none",
    methods: {
      increment(s, by = 1) {
        s.count += by;
      },
    },
  });
  const result = dbStateOf([noneCounter], undefined, {
    counter: { count: 5 },
  });
  assertEquals(result, {});
});

Deno.test(
  "1.1 C: exclude on one cell — other cells still get full slice (no mode cliff)",
  () => {
    const cacheWithExclude = cell("cache", {
      state: { hits: 0, lastKey: "", kept: true },
      persist: { exclude: ["hits"] },
      methods: {
        bump(s) {
          s.hits += 1;
        },
      },
    });
    const result = dbStateOf(
      [counter, cacheWithExclude],
      undefined,
      {
        counter: { count: 3, label: "z" },
        cache: { hits: 9, lastKey: "k", kept: true },
      },
    ) as Record<string, Record<string, unknown>>;
    const cacheSlice = result.cache as Record<string, unknown>;
    assertEquals(result.counter, { count: 3, label: "z" });
    assertEquals(cacheSlice, { lastKey: "k", kept: true });
    assertEquals("hits" in cacheSlice, false);
  },
);

Deno.test("1.1 D: cellDefaults.persist = 'none' is applied when cell has none", () => {
  const result = dbStateOf(
    [counter],
    { persist: "none" },
    { counter: { count: 1, label: "a" } },
  );
  assertEquals(result, {});
});

Deno.test("1.1 E: cellDefaults.persist = 'none' is overridden by explicit cell persist", () => {
  const explicitCounter = cell("counter", {
    state: { count: 0, label: "" },
    persist: "all",
    methods: {
      increment(s, by = 1) {
        s.count += by;
      },
    },
  });
  const result = dbStateOf(
    [explicitCounter],
    { persist: "none" },
    { counter: { count: 1, label: "a" } },
  ) as Record<string, Record<string, unknown>>;
  assertEquals(result.counter, { count: 1, label: "a" });
});
