// aio/server — the explicit SERVER-ONLY import surface.
//
// These symbols pull in SQLite (a Worker) or CLI/UDS transport and are NOT
// available in the browser bundle. Importing them from an isomorphic module
// (a cell, or a lib a cell pulls in) poisons the CLIENT module graph and
// blank-screens the app at boot. Import them from `aio/server` so the boundary
// is EXPLICIT and machine-checkable — aiol flags a server-only symbol reaching a
// cell-shared file, and a client build can map this entry to a stub.
//
// (Additive today: these are still re-exported from the main `aio` entry for
// back-compat. `aio/server` is the recommended path; a future major moves them
// behind it exclusively and stubs the wrong side in each build.)

// DB runtime values live HERE (alpha52 entry diet): `aio/db` is types +
// pure helpers only — its value re-exports are deprecated through beta.
export { createDB, DEFAULT_PRAGMAS } from "./db/async-db.ts";
export { initSchema, loadTables, syncTables } from "./db/state-sync.ts";
export { reactiveDB } from "./db/reactive.ts";
export type { DB, DBOpts, QueryResult, Tx } from "./db/mod.ts";
export type { ReactiveDB, ReactiveQuery } from "./db/reactive.ts";
export { connectCli, connectCliUDS } from "./server/cli-client.ts";
// Signed release artifacts (`aio ship`) live on `aio/build` — build-time
// tooling, not server runtime; the duplicate export here was surface bloat.

// Where this app keeps its files (docs/persistence/where-files-live.md). An app
// that writes its own files needs `appDirs(appId).files` to land inside the one
// directory a user backs up — otherwise it invents a fifth location, which is
// the problem the layout exists to end. Server-only: it reads $HOME and the
// process environment.
export { type AppDirs, appDirs, type AppMeta } from "./server/app-dirs.ts";

// "Reveal in file manager" / "open in browser" — the per-OS launcher every
// desktop app was re-deriving (three field reports). Fail-loud: rejects when
// the launcher is missing or refuses the target.
export { openExternal } from "./server/open-external.ts";

// The binary-tier primitive (tier ③, docs/persistence/big-data.md):
// content-addressed blobs under `appDirs(appId).files/blobs/`. `aio.run()`
// exposes the same store as `app.blobs`; this is the headless door (a CLI,
// a pipeline, a test seeding fixtures). Bytes never ride the state channel —
// they are served at `/__aio/blobs/<id>` (Range-capable, immutable).
export {
  type BlobInfo,
  type BlobStore,
  openBlobStore,
} from "./server/blobs.ts";
