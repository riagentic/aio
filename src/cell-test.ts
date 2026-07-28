// Public entry — implementation lives in testing/cell-test.ts
export * from "./testing/cell-test.ts";
// One state, many surfaces — aio's central claim, made testable (llama-master
// #16). Real server, real WebSocket clients, real broadcast.
export {
  type TestClient,
  type TestMultiClient,
  testMultiClient,
} from "./testing/multi-client-test.ts";

// Transport cassettes (risoto #6): record a real device/network session once,
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
// (llama.md #6 — its server tests installed a fixture under `appDirs().files`
// and, with no way to redirect, wrote into the developer's real install.)
export {
  _resetAppDirs,
  type AppDirs,
  appDirs,
  ensureAppDirs,
  registerAppDirs,
} from "./server/app-dirs.ts";
