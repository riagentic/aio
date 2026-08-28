/** Async SQLite database module — TYPES ONLY (alpha52 entry diet; the
 *  deprecated value re-exports went out in alpha70 — src/state/removals.ts).
 *
 *  The RUNTIME values (`createDB`, `DEFAULT_PRAGMAS`, `initSchema`,
 *  `loadTables`, `syncTables`, `reactiveDB`) live on `aio/server`: they pull
 *  in a Worker/SQLite, so a static import from an isomorphic module poisons
 *  the client graph and blank-screens the app at boot. Types are erased at
 *  build time and stay here — this module has NO runtime edge any more, so a
 *  browser bundle that imports it pulls in nothing. `aiol --safe-fix` rewrites
 *  a value import to `aio/server`. */

export type { DBOpts } from "./async-db.ts";
export type { DB, QueryResult, Tx } from "./types.ts";
// Reactive SQL view types: reactiveDB(db).select(sql) is a live query.
export type { ReactiveDB, ReactiveQuery } from "./reactive.ts";

// WorkerRequest/WorkerResponse are the worker wire format — internal, import
// from ./types.ts (A1 audit).
