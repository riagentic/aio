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

// The other direction: "let the user CHOOSE a path". The most-requested
// missing API in the field reports (three apps wrote the same zenity wrapper,
// two of them shipped the same bug — a missing dialog binary reported as a
// user cancelling). Cancel is `null`; a dialog that is missing, headless or
// broken THROWS, naming the fix.
export {
  pickDirectory,
  pickFile,
  type PickFilter,
  type PickOptions,
} from "./server/pick-path.ts";

// A child process an app can stream, pause, resume and CANCEL — with the whole
// tree. Two field reports wrote this by hand; one of them shipped a
// kill-the-tree that had never worked (procps `kill -STOP -<pid>` exits 0 and
// signals nothing) and orphaned GPU workers until reboot.
export {
  spawn,
  type SpawnHandle,
  type SpawnOptions,
  type SpawnStatus,
} from "./server/spawn.ts";

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

/** What the server this client talks to announced in its hello — its aio
 *  version and its app's derived build (`peerHello().app`), so a CLI client can
 *  say which build it is connected to. */
export { peerHello } from "./protocol/protocol-version.ts";

/** THE version this app is running — `major.minor.build`, resolved exactly as
 *  the build resolves it (docs/build/versioning.md): a compiled binary reports
 *  the stamp its build embedded, a source run derives it from the app's own
 *  repository, and a dirty tree carries `-dirty.<hash8>`. `"unknown (…)"` when
 *  it genuinely cannot be told, never a confident `0.0.0`.
 *
 *  Already what `--version`, the boot line, `/__aio/health` and the update
 *  check report. Exported so an app can SHOW its own version — a status bar,
 *  an About box, a bug report — without a second, hand-stamped constant to
 *  keep in step with deno.json. Server-side (it reads the app's deno.json and
 *  build stamp): call it in the entry or a cell method and put the string in
 *  cell state, the way any other server fact reaches the browser. */
export { _appVersion as appVersion } from "./server/aio.ts";
