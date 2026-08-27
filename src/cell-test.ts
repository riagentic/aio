// Public entry — implementation lives in testing/cell-test.ts
export * from "./testing/cell-test.ts";
// One state, many surfaces — aio's central claim, made testable. Real server, real WebSocket clients, real broadcast.
export {
  type TestClient,
  type TestMultiClient,
  testMultiClient,
} from "./testing/multi-client-test.ts";

// `testServer()`'s own config type — an `aio.run()` config plus the harness's
// knobs (`workers: "real"` + `workerEntry`, which reproduce a worker cell's
// ISOLATION and not just its serialization boundary). Named here so a test can
// declare the object it passes; see docs/testing/prod-parity.md.
export type {
  TestServerConfig,
  TestWorkerMode,
} from "./testing/server-test.ts";

// Boot smoke: a real boot that fetches every eagerly-linked client module —
// the check that catches a static `*.server.ts` import blank-screening the app
// while `deno check`, lint and the unit suite stay green (field report §5.1).
export { smoke, type SmokeResult } from "./testing/smoke-test.ts";

// The OTHER architecture shape: a service plus rich clients, where the client
// is itself an app. Its properties (identity/lock/store isolation, cell-bind
// exclusivity, a client of app A living inside app B) only exist with more than
// one app booted, so one-app harnesses cannot express them.
export { type TestApps, testApps } from "./testing/apps-test.ts";

// Transport cassettes: record a real device/network session once,
// replay it in CI forever. Record in prod against the real device; replay in tests.
export {
  type Cassette,
  type CassetteFrame,
  type CassetteMode,
  createCassette,
  openCassette,
} from "./state/cassette.ts";

// Where an app's files go, for a test that needs a FIXTURE there. Every harness
// already redirects app directories into a temp sandbox (see _armTestStrict), so
// nothing can reach the user's real `~/.<appId>` by accident; these let a test
// pin a directory it controls and assert against it:
//
//   const dirs = appDirs("my-app", await Deno.makeTempDir());
//   registerAppDirs("my-app", dirs);          // app code now resolves here
//   await Deno.writeTextFile(join(dirs.files, "bin"), "…");
//   … run the test …
//   _resetAppDirs();                          // release the registration
//
// (a field report #6 — its server tests installed a fixture under `appDirs().files`
// and, with no way to redirect, wrote into the developer's real install.)
export {
  _resetAppDirs,
  type AppDirs,
  appDirs,
  ensureAppDirs,
  registerAppDirs,
} from "./server/app-dirs.ts";

// The COMPONENT harness, next to the cell one. It was exported from
// `browser-air.ts` and reachable through no specifier in the export map at
// all — `aio/testing` is cells, `aio/air` deliberately does not re-export it —
// so an app could only get at it by a relative path into `dep/aio/src/…` or a
// private alias. "Symmetric with testCell" is not symmetric if only one of the
// two can be imported, and the asymmetry showed: a field app had DOM coverage
// of zero components until a positional bug shipped, because the cell tests
// were easy to write and the component tests looked unsupported (R-11).
//
// One testing entry point: `testCell`, `testUI` and `testComponent` together.
export {
  setDocument,
  testComponent,
  type TestComponentHandle,
  type TestComponentOptions,
} from "./testing/test-component.ts";

// TOTP code generator — HERE, not in `aio`: an integration test of a
// `totp: true` login must SUBMIT a valid second factor, and this is the only
// way to make one (a field report imported it through the framework's
// internals). Kept out of the app-facing surface so it cannot be mistaken
// for an enrollment primitive (`generateTotpSecret`/`totpUri`/`verifyTotp`
// in `aio` are that).
export { totpCode } from "./server/auth-totp.ts";

// The `updates` cell's platform half, for a test of an update banner. The
// server installs the real runtime at boot; a test installs a stub that
// answers `check()` with the offer it wants to see, then drives the UI:
//
//   installUpdatesRuntime({ kind: "manifest", channel: "prod", current: "1.0.0",
//     exposed: false, check: async () => ({ kind: "offer", update: { … } }),
//     apply: async () => {}, setChannel: async () => {} });
//
// `update` is an `AvailableUpdate` — version, reason, notes, size, releasedAt,
// migrates, signed, keyFingerprint, warnings. `apply(opts)` receives
// `{ acceptDataLoss }` when the caller opened that door.
//
// Pass `null` to take it back out. A field report (a desktop app) reached it
// through `dep/aio/src/state/…` — a seam a test needs is a seam we export.
export {
  type ApplyOptions,
  type CheckOptions,
  type CheckResult,
  installUpdatesRuntime,
  type UpdatesRuntime,
} from "./state/updates-cell.ts";
