// Public entry — implementation lives in testing/cell-test.ts
export * from "./testing/cell-test.ts";
// One state, many surfaces — aio's central claim, made testable. Real server, real WebSocket clients, real broadcast.
export {
  type TestClient,
  type TestMultiClient,
  testMultiClient,
} from "./testing/multi-client-test.ts";

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

// TOTP code generator — HERE, not in `aio`: an integration test of a
// `totp: true` login must SUBMIT a valid second factor, and this is the only
// way to make one (a field report imported it through the framework's
// internals). Kept out of the app-facing surface so it cannot be mistaken
// for an enrollment primitive (`generateTotpSecret`/`totpUri`/`verifyTotp`
// in `aio` are that).
export { totpCode } from "./server/auth-totp.ts";
