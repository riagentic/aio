// src/sync/mod.ts — Public API for sync module (A1 audit).
//
// Config-facing types (what users write in `aio.run({ sync })`) plus the
// full engine surface (engine, HLC, op buffer, wire messages, server store)
// for custom-integration authors. All of it is tested and supported — see
// tests/sync/ (unit + property + integration) and tests/browser-sync.test.ts.

// ── Config-facing ────────────────────────────────────────────────────

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

// ── Engine surface ───────────────────────────────────────────────────

export type {
  AckMessage,
  HLC,
  OpMessage,
  SyncRequest,
  SyncResponse,
} from "./types.ts";
export { normalizeSyncConfig } from "./types.ts";

export { compareHLC, createHLC, type HLClock } from "./hlc.ts";

export { mergeField, type MergeResult } from "./merge.ts";

export {
  createOpBuffer,
  type OpBuffer,
  type OpBufferOptions,
  type OpBufferStorage,
} from "./op-buffer.ts";

export { rebase, type RebaseResult } from "./rebase.ts";

export { type CompactDeps, compactSyncOps, SYNC_SCHEMA } from "./compact.ts";

export {
  createSyncEngine,
  type SyncEngine,
  type SyncEngineDeps,
} from "./sync-engine.ts";

export {
  createServerSyncHandler,
  isValidSyncOp,
  type ServerSyncHandler,
  type SyncHandlerDeps,
} from "./server-handler.ts";

export { getLowWater, loadOpsSince, persistOp } from "./server-store.ts";
