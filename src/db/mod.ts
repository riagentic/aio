/** Async SQLite database module — worker-backed DB with WAL mode and optional read replicas. */

export { createDB, type DBOpts, DEFAULT_PRAGMAS } from "./async-db.ts";
export { initSchema, loadTables, syncTables } from "./state-sync.ts";
export type { DB, QueryResult, Tx } from "./types.ts";
// WorkerRequest/WorkerResponse are the worker wire format — internal, import
// from ./types.ts (A1 audit).
