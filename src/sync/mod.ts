// src/sync/mod.ts — Public API for sync module (A1 audit; alpha52 sweep).
//
// PUBLIC = the config/observation surface: what users write in cell
// `sync:` / `aio.run({ sync })` and what they read back (status, stats,
// conflicts, HLC ordering). The ENGINE surface (engine, op buffer, wire
// messages, rebase, server store) is framework wiring — still exported for
// the framework's own runtimes and tests, but `@internal` since alpha52:
// stripped from the api snapshot, free to move inside the alpha window.
// All of it is tested — see tests/sync/ and tests/browser-sync.test.ts.

// ── Config-facing + observation (public) ─────────────────────────────

export type {
  MergeStrategy,
  SyncConfig,
  SyncConflict,
  SyncStats,
  SyncStatus,
} from "./types.ts";
export { SYNC_DEFAULTS } from "./types.ts";
export { compareHLC } from "./hlc.ts";
export type { HLC } from "./types.ts";

// ── Engine surface (framework wiring) ────────────────────────────────

/** @internal Engine wiring — not public API, stripped from the snapshot. */
export type { SyncOp } from "./types.ts";
/** @internal Engine wiring — not public API, stripped from the snapshot. */
export { type SyncReducer } from "./rebase.ts";
/** @internal Engine wiring — not public API, stripped from the snapshot. */
export type {
  AckMessage,
  OpMessage,
  SyncRequest,
  SyncResponse,
} from "./types.ts";
/** @internal Engine wiring — not public API, stripped from the snapshot. */
export { normalizeSyncConfig } from "./types.ts";
/** @internal Engine wiring — not public API, stripped from the snapshot. */
export { createHLC, type HLClock } from "./hlc.ts";
/** @internal Engine wiring — not public API, stripped from the snapshot. */
export { mergeField, type MergeResult } from "./merge.ts";
/** @internal Engine wiring — not public API, stripped from the snapshot. */
export {
  createOpBuffer,
  type OpBuffer,
  type OpBufferOptions,
  type OpBufferStorage,
} from "./op-buffer.ts";
/** @internal Engine wiring — not public API, stripped from the snapshot. */
export { rebase, type RebaseResult } from "./rebase.ts";
/** @internal Engine wiring — not public API, stripped from the snapshot. */
export { type CompactDeps, compactSyncOps, SYNC_SCHEMA } from "./compact.ts";
/** @internal Engine wiring — not public API, stripped from the snapshot. */
export {
  createSyncEngine,
  type SyncEngine,
  type SyncEngineDeps,
} from "./sync-engine.ts";
/** @internal Engine wiring — not public API, stripped from the snapshot. */
export {
  createServerSyncHandler,
  isValidSyncOp,
  type ServerSyncHandler,
  type SyncHandlerDeps,
} from "./server-handler.ts";
/** @internal Engine wiring — not public API, stripped from the snapshot. */
export { getLowWater, loadOpsSince, persistOp } from "./server-store.ts";
