import { assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { composeCellsWiring } from "../src/server/aio-composition.ts";

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
  visible: "none",
  methods: {
    add(s, t: string) {
      s.items.push(t);
    },
  },
});

const trading = cell("trading", {
  state: { orders: [] as unknown[], positions: [] as unknown[], cache: {} },
  visible: { include: ["orders", "positions"] },
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
    {
      cell: "counter",
      ui: "all",
      persist: "all",
      access: undefined,
      // No `ui` on the cell and no cellDefaults → the read side was never
      // decided. The row still REPORTS "all" (that is what ships); uiDecided
      // is what tells the two apart.
      uiDecided: false,
      fields: ["count"],
      syncs: false,
    },
    {
      cell: "notes",
      ui: "none",
      persist: "all",
      access: undefined,
      uiDecided: true,
      fields: ["items"],
      syncs: false,
    },
    {
      cell: "trading",
      ui: { include: ["orders", "positions"] },
      persist: { exclude: ["cache"] },
      access: undefined,
      uiDecided: true,
      fields: ["orders", "positions", "cache"],
      syncs: false,
    },
  ]);
});

Deno.test("1.3: visibilityReport — cellDefaults propagate when cell has none", () => {
  const report = reportOf([counter], { visible: "none", persist: "none" });
  assertEquals(report, [
    {
      cell: "counter",
      ui: "none",
      persist: "none",
      access: undefined,
      // A cellDefaults `ui` IS a decision — the author made it for every cell
      // at once. Reporting it as undecided would nag them for having answered.
      uiDecided: true,
      fields: ["count"],
      syncs: false,
    },
  ]);
});

Deno.test("1.3: visibilityReport — explicit cell filter wins over cellDefaults", () => {
  const report = reportOf([counter, trading], {
    visible: "none",
    persist: "none",
  });
  assertEquals(report, [
    {
      cell: "counter",
      ui: "none",
      persist: "none",
      access: undefined,
      uiDecided: true,
      fields: ["count"],
      syncs: false,
    },
    {
      cell: "trading",
      ui: { include: ["orders", "positions"] },
      persist: { exclude: ["cache"] },
      access: undefined,
      uiDecided: true,
      fields: ["orders", "positions", "cache"],
      syncs: false,
    },
  ]);
});
