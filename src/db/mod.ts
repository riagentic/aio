/** Async SQLite database module — TYPES + pure helpers (alpha52 entry diet).
 *
 *  The RUNTIME values (`createDB`, `DEFAULT_PRAGMAS`, `initSchema`,
 *  `loadTables`, `syncTables`, `reactiveDB`) live on `aio/server`: they pull
 *  in a Worker/SQLite, so a static import from an isomorphic module poisons
 *  the client graph and blank-screens the app at boot. Types are erased at
 *  build time and stay here. */

export type { DBOpts } from "./async-db.ts";
export type { DB, QueryResult, Tx } from "./types.ts";
// Reactive SQL view types: reactiveDB(db).select(sql) is a live query.
export type { ReactiveDB, ReactiveQuery } from "./reactive.ts";

// ── DEPRECATED value re-exports (alpha52 → removed at beta) ─────────────────
// These keep pre-alpha52 imports working through beta; the actual graph split
// (this module dropping its runtime edges entirely) lands with the removal at
// beta-end. `aiol` reports them and `--safe-fix` rewrites the imports to
// `aio/server` today.
/** @deprecated alpha52 — import from `aio/server` (server-only value). */
export { createDB, DEFAULT_PRAGMAS } from "./async-db.ts";
/** @deprecated alpha52 — import from `aio/server` (server-only values). */
export { initSchema, loadTables, syncTables } from "./state-sync.ts";
/** @deprecated alpha52 — import from `aio/server` (server-only value). */
export { reactiveDB } from "./reactive.ts";
// WorkerRequest/WorkerResponse are the worker wire format — internal, import
// from ./types.ts (A1 audit).
