// src/sync/mod.ts — Public API for sync module

export type {
  AckMessage,
  HLC,
  MergeStrategy,
  OpMessage,
  SyncConfig,
  SyncConflict,
  SyncOp,
  SyncRequest,
  SyncResponse,
  SyncStats,
  SyncStatus,
} from "./types.ts";
export { normalizeSyncConfig, SYNC_DEFAULTS } from "./types.ts";

export { compareHLC, createHLC, type HLClock } from "./hlc.ts";

export { mergeField, type MergeResult } from "./merge.ts";

export {
  createOpBuffer,
  type OpBuffer,
  type OpBufferOptions,
  type OpBufferStorage,
} from "./op-buffer.ts";

export { rebase, type RebaseResult, type SyncReducer } from "./rebase.ts";

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
