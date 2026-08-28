// cell.ts — barrel re-export for the cell system
//
// Split into:
//   cell-types.ts    — shared types, tagSource, RESERVED_KEYS
//   cell-machine.ts  — machine validation
//   cell-catalog.ts  — catalog building, flattenOnto, bindCell
//   cell-create.ts   — cell() + createCellFromMethods/Actions
//   cell-compose.ts  — composeCells, resolveCells, registry
//   cell-test.ts     — testCell, TestContext
//
// Only re-exports symbols that were public in the original cell.ts.
// Internal helpers (buildCatalog, flattenOnto, validateMachine, RESERVED_KEYS)
// are imported directly by sibling files and NOT exposed here.

export {
  type Access,
  type AccessUser,
  type ActionSource,
  type Catalog,
  type CellAio,
  type CellDef,
  type CellEntry,
  type CellExecuteFn,
  type CellReduceFn,
  type Creators,
  type DirectCalling,
  type FlatActions,
  type MachineConfig,
  type Msg,
  type ScopedApp,
  type StateOf,
  tagSource,
} from "./cell-types.ts";

export { bindCell } from "./cell-catalog.ts";

export { cell, type MethodsCellConfig } from "./cell-create.ts";

export {
  type CellStatus,
  type CircuitBreakerConfig,
  composeCells,
  type ComposedCells,
} from "./cell-compose.ts";

// NOTE: `testCell` deliberately NOT re-exported here (it lives in
// src/cell-test.ts, published via `aio/testing` and mod.ts). Re-exporting it
// made state/ reach server/+testing/ through the root-file conduit —
// scripts/check-boundaries.ts now errors on exactly that laundering.

export {
  _resetCellRegistry,
  bindAllCellsReactive,
  bindCellReactive,
  getRegisteredCells,
} from "./cell-reactive.ts";
