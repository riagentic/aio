/** Async SQLite database module — worker-backed DB with WAL mode and optional read replicas. */

export { createDB, type DBOpts, DEFAULT_PRAGMAS } from "./async-db.ts";
export { initSchema, loadTables, syncTables } from "./state-sync.ts";
export type { DB, QueryResult, Tx } from "./types.ts";
// Reactive SQL views (risoto #8): reactiveDB(db).select(sql) is a live query.
export { type ReactiveDB, reactiveDB, type ReactiveQuery } from "./reactive.ts";
// WorkerRequest/WorkerResponse are the worker wire format — internal, import
// from ./types.ts (A1 audit).
