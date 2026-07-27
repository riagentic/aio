// aio/server — the explicit SERVER-ONLY import surface (risoto #1 boundary).
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

export { createDB, DEFAULT_PRAGMAS } from "./db/mod.ts";
export type { DB, DBOpts, QueryResult, Tx } from "./db/mod.ts";
export { connectCli, connectCliUDS } from "./server/cli-client.ts";
// Signed release artifacts (`aio ship`) + least-privilege capability scanning.
export {
  buildShipManifest,
  generateSigningKey,
  sha256Hex,
  shipApp,
  type ShipManifest,
  verifyShipManifest,
} from "./build/ship.ts";

// Where this app keeps its files (docs/persistence/where-files-live.md). An app
// that writes its own files needs `appDirs(appId).files` to land inside the one
// directory a user backs up — otherwise it invents a fifth location, which is
// the problem the layout exists to end. Server-only: it reads $HOME and the
// process environment.
export { type AppDirs, appDirs, type AppMeta } from "./server/app-dirs.ts";
