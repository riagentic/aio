// src/sync/mod.ts — Public API for sync module (A1 audit).
//
// Stable surface: config-facing types users write in `aio.run({ sync })`.
// Everything else (engine, HLC, op buffer, wire messages, server store) is
// exported for custom-integration authors but tagged @experimental — excluded
// from the 1.0 stability guarantee.

// ── Stable (config-facing) ───────────────────────────────────────────

export type {
  MergeStrategy,
  SyncConfig,
  SyncConflict,
  SyncOp,
  SyncStats,
  SyncStatus,
} from "./types.ts";
export { SYNC_DEFAULTS } from "./types.ts";
export { type SyncReducer } from "./rebase.ts";

// ── Engine internals (@experimental) ─────────────────────────────────

/** @experimental Wire/clock internals — excluded from the 1.0 stability guarantee. */
export type {
  AckMessage,
  HLC,
  OpMessage,
  SyncRequest,
  SyncResponse,
} from "./types.ts";
/** @experimental Excluded from the 1.0 stability guarantee. */
export { normalizeSyncConfig } from "./types.ts";

/** @experimental Excluded from the 1.0 stability guarantee. */
export { compareHLC, createHLC, type HLClock } from "./hlc.ts";

/** @experimental Excluded from the 1.0 stability guarantee. */
export { mergeField, type MergeResult } from "./merge.ts";

/** @experimental Excluded from the 1.0 stability guarantee. */
export {
  createOpBuffer,
  type OpBuffer,
  type OpBufferOptions,
  type OpBufferStorage,
} from "./op-buffer.ts";

/** @experimental Excluded from the 1.0 stability guarantee. */
export { rebase, type RebaseResult } from "./rebase.ts";

/** @experimental Excluded from the 1.0 stability guarantee. */
export { type CompactDeps, compactSyncOps, SYNC_SCHEMA } from "./compact.ts";

/** @experimental Excluded from the 1.0 stability guarantee. */
export {
  createSyncEngine,
  type SyncEngine,
  type SyncEngineDeps,
} from "./sync-engine.ts";

/** @experimental Excluded from the 1.0 stability guarantee. */
export {
  createServerSyncHandler,
  isValidSyncOp,
  type ServerSyncHandler,
  type SyncHandlerDeps,
} from "./server-handler.ts";

/** @experimental Excluded from the 1.0 stability guarantee. */
export { getLowWater, loadOpsSince, persistOp } from "./server-store.ts";
