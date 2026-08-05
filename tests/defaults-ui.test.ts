import { assertEquals, assertThrows } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { composeCellsWiring } from "../src/server/aio-composition.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";

// Tests for 1.2: ui default is "all" — zero-config exposes everything,
// adding ui config to ONE cell does not make other cells vanish.

function wiringOf(
  cellEntries: Parameters<typeof composeCellsWiring>[0]["cellEntries"],
  cellDefaults?: Parameters<typeof composeCellsWiring>[0]["cellDefaults"],
) {
  return composeCellsWiring({
    cellEntries,
    ...(cellDefaults !== undefined ? { cellDefaults } : {}),
  });
}

const counter = cell("counter", {
  state: { count: 0, label: "" },
  methods: {
    increment(s, by = 1) {
      s.count += by;
    },
  },
});

const flags = cell("flags", {
  state: { active: false, mode: "x" },
  methods: {
    activate(s) {
      s.active = true;
    },
  },
});

const sampleState = {
  counter: { count: 5, label: "y" },
  flags: { active: true, mode: "z" },
};

Deno.test("1.2 A: no ui config — getUIState returns full state, every cell 'raw'", () => {
  const wiring = wiringOf([counter, flags]);
  assertEquals(wiring.autoGetUIState !== undefined, true);
  const ui = wiring.autoGetUIState!(sampleState);
  assertEquals(ui, sampleState);
  assertEquals(wiring.cellPatchStrategies.get("counter"), "raw");
  assertEquals(wiring.cellPatchStrategies.get("flags"), "raw");
});

Deno.test(
  "1.2 B: one cell sets ui — OTHER cell stays visible and 'raw' (no mode cliff)",
  () => {
    const counterWithUi = cell("counter", {
      state: { count: 0, label: "" },
      ui: { include: ["count"] },
      methods: {
        increment(s, by = 1) {
          s.count += by;
        },
      },
    });
    const wiring = wiringOf([counterWithUi, flags]);
    const ui = wiring.autoGetUIState!(sampleState) as Record<
      string,
      Record<string, unknown>
    >;
    // counter is filtered to { count } only
    assertEquals(ui.counter, { count: 5 });
    // flags is unaffected — full slice, no cliff
    assertEquals(ui.flags, { active: true, mode: "z" });
    assertEquals(wiring.cellPatchStrategies.get("counter"), "filter");
    assertEquals(wiring.cellPatchStrategies.get("flags"), "raw");
  },
);

Deno.test("1.2 C: ui: 'none' on a cell — absent from UI state, strategy 'skip'", () => {
  const hiddenCounter = cell("counter", {
    state: { count: 0, label: "" },
    ui: "none",
    methods: {
      increment(s, by = 1) {
        s.count += by;
      },
    },
  });
  const wiring = wiringOf([hiddenCounter, flags]);
  const ui = wiring.autoGetUIState!(sampleState) as Record<
    string,
    Record<string, unknown>
  >;
  assertEquals("counter" in ui, false);
  assertEquals(ui.flags, { active: true, mode: "z" });
  assertEquals(wiring.cellPatchStrategies.get("counter"), "skip");
  assertEquals(wiring.cellPatchStrategies.get("flags"), "raw");
});

Deno.test(
  "1.2 D: cellDefaults.ui = 'none' + one cell ui = 'all' — only that cell visible",
  () => {
    const wiring = wiringOf([counter, flags], { ui: "none" });
    // No explicit cell ui → cellDefaults "none" applies, both hidden
    assertEquals(wiring.autoGetUIState!(sampleState), {});
    assertEquals(wiring.cellPatchStrategies.get("counter"), "skip");
    assertEquals(wiring.cellPatchStrategies.get("flags"), "skip");
  },
);

Deno.test(
  "1.2 D′: cellDefaults.ui = 'none' + one cell ui = 'all' overrides the default",
  () => {
    const visibleCounter = cell("counter", {
      state: { count: 0, label: "" },
      ui: "all",
      methods: {
        increment(s, by = 1) {
          s.count += by;
        },
      },
    });
    const wiring = wiringOf([visibleCounter, flags], { ui: "none" });
    const ui = wiring.autoGetUIState!(sampleState) as Record<
      string,
      Record<string, unknown>
    >;
    assertEquals(ui.counter, { count: 5, label: "y" });
    assertEquals("flags" in ui, false);
    assertEquals(wiring.cellPatchStrategies.get("counter"), "raw");
    assertEquals(wiring.cellPatchStrategies.get("flags"), "skip");
  },
);

// ── forUser ⇒ never a patch strategy that bypasses it ─────────────────────
//
// A field report (dm #1, "highest severity — a privacy hole with no symptom at
// the call site"): `ui: { forUser }` with no include/exclude classified as
// `raw`, so clients received Immer patches computed from UNFILTERED server
// state. The per-user filter guarded the full-state frame and nothing else.
//
// It corrupts as well as leaks: raw ops carry raw ARRAY INDICES, and the
// client's array was shortened by forUser, so rows land at the wrong index.
// The reporter's workaround was to name all nine state fields in `include`
// purely to make the cell classify as `full`.
//
// This is the PROPERTY, not the instance: whatever ui shape is added later,
// a cell with a per-user filter must never be broadcast through a strategy
// that cannot apply it.
Deno.test("forUser: a per-user filter is never bypassed by the patch strategy", () => {
  const shapes = [
    { label: "forUser alone", ui: { forUser: (s: never) => s } },
    {
      label: "forUser + include",
      ui: { include: ["count"], forUser: (s: never) => s },
    },
    {
      label: "forUser + exclude",
      ui: { exclude: ["label"], forUser: (s: never) => s },
    },
  ];
  for (const { label, ui } of shapes) {
    const c = cell("counter", {
      state: { count: 0, label: "" },
      // deno-lint-ignore no-explicit-any
      ui: ui as any,
      methods: {
        increment(s, by = 1) {
          s.count += by;
        },
      },
    });
    const strategy = wiringOf([c]).cellPatchStrategies.get("counter");
    assertEquals(
      strategy,
      "full",
      `${label}: a forUser cell must broadcast full per-client state, got "${strategy}"`,
    );
  }
});

Deno.test("forUser: ui 'none' still wins — an invisible cell stays invisible", () => {
  const hidden = cell("counter", {
    state: { count: 0, label: "" },
    // deno-lint-ignore no-explicit-any
    ui: "none" as any,
    methods: {
      increment(s, by = 1) {
        s.count += by;
      },
    },
  });
  // deno-lint-ignore no-explicit-any
  (hidden as any).__aio.uiForUser = (s: unknown) => s;
  const wiring = wiringOf([hidden]);
  assertEquals(wiring.cellPatchStrategies.get("counter"), "skip");
  // …and the visibility report must not claim a filter is doing work on a
  // wire that carries nothing.
  const row = wiring.visibilityReport?.find((r) => r.cell === "counter");
  if (row) assertEquals(row.ui, "none");
});

// ── The property, over the whole ui shape space ───────────────────────────
//
// Three holes shipped because a `ui` shape reached a channel that could not
// honour it: `forUser` alone classified as `raw` (patches from unfiltered
// state), a throwing `forUser` fell back to the unfiltered slice, and a
// filtered cell could be CRDT-replicated to every peer. Enumerating the shapes
// is what makes the CLASS unshippable — a new shape added later either lands in
// one of these buckets or fails here.
//
// For every shape: does it hide anything from a client? If yes, it must never
// be broadcast through `raw`, and it must never be combined with `sync`.
const UI_SHAPES: { label: string; ui: unknown; hides: boolean }[] = [
  { label: "absent", ui: undefined, hides: false },
  { label: '"all"', ui: "all", hides: false },
  { label: '"none"', ui: "none", hides: true },
  { label: "include", ui: { include: ["count"] }, hides: true },
  { label: "exclude", ui: { exclude: ["label"] }, hides: true },
  { label: "forUser", ui: { forUser: (s: never) => s }, hides: true },
  {
    label: "forUser+include",
    ui: { include: ["count"], forUser: (s: never) => s },
    hides: true,
  },
  {
    label: "forUser+exclude",
    ui: { exclude: ["label"], forUser: (s: never) => s },
    hides: true,
  },
  {
    label: "publicFields (an acknowledgement, not a filter)",
    ui: { publicFields: ["label"] },
    hides: false,
  },
];

function cellWith(id: string, ui: unknown, sync?: boolean) {
  return cell(id, {
    state: { count: 0, label: "" },
    // deno-lint-ignore no-explicit-any
    ...(ui !== undefined ? { ui: ui as any } : {}),
    ...(sync ? { sync: true } : {}),
    methods: {
      increment(s: { count: number }, by = 1) {
        s.count += by;
      },
    },
  });
}

Deno.test("ui property: a shape that hides state is never broadcast through 'raw'", () => {
  let n = 0;
  for (const { label, ui, hides } of UI_SHAPES) {
    _resetAioRuntime();
    const id = `ui-shape-${n++}`;
    const strategy = wiringOf(
      // deno-lint-ignore no-explicit-any
      [cellWith(id, ui)] as any,
    ).cellPatchStrategies.get(id);
    if (hides) {
      assertEquals(
        strategy === "raw",
        false,
        `${label}: hides state but classified as "raw" — patches would be computed from UNFILTERED state`,
      );
    } else {
      assertEquals(
        strategy,
        "raw",
        `${label}: hides nothing, so the cheap path must stay available`,
      );
    }
  }
  _resetAioRuntime();
});

Deno.test("ui property: a shape that hides state can never be a sync cell", () => {
  let n = 0;
  for (const { label, ui, hides } of UI_SHAPES) {
    _resetAioRuntime();
    const id = `ui-sync-shape-${n++}`;
    // deno-lint-ignore no-explicit-any
    const compose = () => wiringOf([cellWith(id, ui, true)] as any);
    if (hides) {
      // CRDT replication hands every peer the same ops and snapshots: a filter
      // on a replicated cell is a promise the transport cannot keep, so it is
      // refused by name instead of silently leaking.
      const err = assertThrows(compose, Error, undefined, label);
      assertEquals(
        err.message.includes(id),
        true,
        `${label}: the refusal must name the cell — got: ${err.message}`,
      );
    } else {
      compose(); // hides nothing → replication is honest
    }
  }
  _resetAioRuntime();
});
