import { assertEquals } from "@std/assert";
import { cell } from "../src/cell-create.ts";
import { composeCellsWiring } from "../src/aio-composition.ts";

// Tests for 1.3: composeCellsWiring exposes a visibilityReport
// reflecting the resolved ui/persist filter per cell.

function reportOf(
  cellEntries: Parameters<typeof composeCellsWiring>[0]["cellEntries"],
  cellDefaults?: Parameters<typeof composeCellsWiring>[0]["cellDefaults"],
) {
  return composeCellsWiring({
    cellEntries,
    ...(cellDefaults !== undefined ? { cellDefaults } : {}),
  }).visibilityReport;
}

const counter = cell("counter", {
  state: { count: 0 },
  methods: {
    increment(s, by = 1) {
      s.count += by;
    },
  },
});

const notes = cell("notes", {
  state: { items: [] as string[] },
  ui: "none",
  methods: {
    add(s, t: string) {
      s.items.push(t);
    },
  },
});

const trading = cell("trading", {
  state: { orders: [] as unknown[], positions: [] as unknown[], cache: {} },
  ui: { include: ["orders", "positions"] },
  persist: { exclude: ["cache"] },
  methods: {
    place(s, o: unknown) {
      s.orders.push(o);
    },
  },
});

Deno.test("1.3: visibilityReport — 3-cell mix (all/none/include), resolved values", () => {
  const report = reportOf([counter, notes, trading]);
  assertEquals(report, [
    { cell: "counter", ui: "all", persist: "all" },
    { cell: "notes", ui: "none", persist: "all" },
    {
      cell: "trading",
      ui: { include: ["orders", "positions"] },
      persist: { exclude: ["cache"] },
    },
  ]);
});

Deno.test("1.3: visibilityReport — cellDefaults propagate when cell has none", () => {
  const report = reportOf([counter], { ui: "none", persist: "none" });
  assertEquals(report, [
    { cell: "counter", ui: "none", persist: "none" },
  ]);
});

Deno.test("1.3: visibilityReport — explicit cell filter wins over cellDefaults", () => {
  const report = reportOf([counter, trading], {
    ui: "none",
    persist: "none",
  });
  assertEquals(report, [
    { cell: "counter", ui: "none", persist: "none" },
    {
      cell: "trading",
      ui: { include: ["orders", "positions"] },
      persist: { exclude: ["cache"] },
    },
  ]);
});
