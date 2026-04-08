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
  type ActionSource,
  type ActionUnion,
  type Catalog,
  type CellAio,
  type CellDef,
  type CellEntry,
  type CellExecuteFn,
  type CellReduceFn,
  type Creators,
  type DirectCalling,
  type ExtractState,
  type FlatActions,
  type MachineConfig,
  type Msg,
  type ScopedApp,
  type SendOf,
  tagSource,
} from "./cell-types.ts";

export { bindCell } from "./cell-catalog.ts";

export {
  type ActionsCellConfig,
  cell,
  type ExecuteHandlers,
  type MethodsCellConfig,
  type ReduceHandlers,
} from "./cell-create.ts";

export {
  type CellStatus,
  type CircuitBreakerConfig,
  composeCells,
  type ComposedCells,
} from "./cell-compose.ts";

export { testBridge, testCell, type TestContext } from "./cell-test.ts";
