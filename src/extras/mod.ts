/**
 * @module
 * aio/extras — the periphery (perfect-aio D5/B4c).
 *
 * Everything here is fully supported, just not core: escape hatches, niche
 * runtime helpers, and deep diagnostic detail types that no small app needs
 * on day one. The main `aio` entry stays the ~measured-core surface people
 * actually reach for; this entry keeps the rest one import away.
 *
 * ```ts
 * import { deepFreeze, instances, parseCli } from "aio/extras";
 * ```
 */

/** Validate cell defs without booting — `lint(cells)` returns findings. */
export { lint, parseCli } from "../server/aio.ts";
export type { CliFlags, Lint } from "../server/aio.ts";

// (`connectCliUDS` moved to `aio/server` and `DEFAULT_PRAGMAS` to `aio/db` in
// alpha41 — see docs/upgrade/from-alpha40-to-alpha41.md. Their doc comments
// were left behind here, describing exports this entry no longer has.)

/** Single-instance lock introspection — list running apps, normalize IDs.
 *  `readLock(appId)` reads one app's live lock (pid, port, socketPath,
 *  status): what a service's own `--status`/`--stop` flags are built on — a
 *  field report deep-imported it from `src/` for exactly that. */
export {
  instances,
  readLock,
  resolveAppId,
} from "../server/single-instance-lock.ts";
export type {
  InstanceInfo,
  LockData,
  SingletonMode,
} from "../server/single-instance-lock.ts";

/** Mark a method as async when minification strips constructor names. */
export { markAsync } from "../state/cell-impl.ts";

/** Deep freeze — dev-mode immutability checking on arbitrary objects. */
export { deepFreeze } from "../state/dispatch.ts";

/** Memoized selector scoped to one cell slice. */
export { createSliceSelector } from "../selector.ts";

/** Deep diagnostic detail types — the shapes vitals/diagnostics emit.
 *  (The CONFIG types stay on the main entry with `aio.run()`.) */
export type { AioErrorContext, AioErrorSource } from "../diagnostics/error.ts";
export type {
  CellStateSize,
  MemoryReport,
} from "../diagnostics/memory-monitor.ts";
export type { ReduceBreakdown } from "../diagnostics/time-travel.ts";
export type { CheckpointData } from "../diagnostics/types.ts";
export type {
  DiagEvent,
  DiagEventDetail,
  LayerThreshold,
  RenderBudget,
  VitalAlert,
  VitalHint,
  VitalLayer,
  VitalStatus,
  VitalThresholds,
} from "../vitals/types.ts";
export type { PerfCheck } from "../server/aio.ts";

/** Low-level action/reduce plumbing types — what composeCells speaks
 *  internally. App code uses methods; these exist for advanced tooling. */
export type {
  ActionSource,
  ActionUnion,
  CellExecuteFn,
  CellReduceFn,
  Creators,
} from "../state/cell.ts";
