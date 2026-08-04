// Cell config must not be ORDER-DEPENDENT.
//
// Field report (llama-master #7): adding a migration with the fields in the
// order the docs list them —
//
//     cell("cfg", {
//       version: 2,
//       onMigrate(state: CfgState, from: number) { … },
//       state: { fitCtx: {} as Record<string, number>, … },
//       methods: { rememberFit(s) { s.fitCtx[model] = ctx } },  // ← TS18046
//     })
//
// — made TypeScript infer `S` from `onMigrate` (the first property mentioning
// the state type) instead of from `state`. Every method body then lost its
// typing, and the error surfaced ten lines away in the methods, saying nothing
// about ordering. The reporter suspected the migration API itself, and their
// first "fix" — widening the annotation to Record<string, unknown> — silently
// widened `S` for the entire cell.
//
// `state` is the SOLE inference site now (`NoInfer` on onMigrate/onInit/
// onDestroy), so key order cannot change what a cell's methods see. This test
// is a COMPILE-TIME assertion: if inference regresses, `deno check` fails on
// this file and the suite never gets to run it.
import { assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { testCell } from "../src/cell-test.ts";

type CfgState = { fitCtx: Record<string, number>; label: string };

// Hooks FIRST — the order that used to break inference.
const hooksFirst = cell("cfg-hooks-first", {
  version: 2,
  onMigrate(state: CfgState, _from: number) {
    return state;
  },
  onInit() {},
  state: { fitCtx: {} as Record<string, number>, label: "" },
  methods: {
    rememberFit(s, model: string, ctx: number) {
      // If `S` were inferred from onMigrate, these would be `unknown` and the
      // file would not type-check.
      s.fitCtx[model] = ctx;
      s.label = model;
    },
  },
});

// State FIRST — the order that always worked. Both must behave identically.
const stateFirst = cell("cfg-state-first", {
  state: { fitCtx: {} as Record<string, number>, label: "" },
  version: 2,
  onMigrate(state: CfgState, _from: number) {
    return state;
  },
  methods: {
    rememberFit(s, model: string, ctx: number) {
      s.fitCtx[model] = ctx;
      s.label = model;
    },
  },
});

testCell(
  hooksFirst,
  "hooks declared before state: methods stay typed",
  async (t) => {
    await t.send.rememberFit("llama-7b", 4096);
    assertEquals(t.getState().fitCtx["llama-7b"], 4096);
    assertEquals(t.getState().label, "llama-7b");
  },
);

testCell(stateFirst, "state declared first: identical behaviour", async (t) => {
  await t.send.rememberFit("llama-7b", 4096);
  assertEquals(t.getState().fitCtx["llama-7b"], 4096);
  assertEquals(t.getState().label, "llama-7b");
});
