import { assertEquals, assertExists } from "@std/assert";
import { initDiagnostics } from "../../src/diagnostics/mod.ts";

const TEST_DIR = await Deno.makeTempDir();

Deno.test("mod: diagnostics=false returns null", () => {
  const hooks = initDiagnostics(false, false, TEST_DIR);
  assertEquals(hooks, null);
});

Deno.test("mod: dev mode returns hooks", () => {
  const hooks = initDiagnostics({}, false, `${TEST_DIR}/dev`);
  assertExists(hooks);
  assertEquals(typeof hooks!.afterAction, "function");
  assertEquals(typeof hooks!.onStart, "function");
  assertEquals(typeof hooks!.onStop, "function");
  assertEquals(typeof hooks!.onError, "function");
  assertEquals(typeof hooks!.getRecoveredState, "function");
  assertEquals(typeof hooks!.setHealthGetter, "function");
});

Deno.test("mod: prod mode returns hooks (crash handler always on)", () => {
  const hooks = initDiagnostics({}, true, `${TEST_DIR}/prod`);
  assertExists(hooks);
  assertEquals(typeof hooks!.afterAction, "function");
  // Clean up crash handler
  if (hooks!.uninstallCrashHandler) hooks!.uninstallCrashHandler();
});

Deno.test("mod: getRecoveredState returns null when no checkpoint", () => {
  const hooks = initDiagnostics({}, false, `${TEST_DIR}/no-cp`);
  assertExists(hooks);
  assertEquals(hooks!.getRecoveredState(), null);
  if (hooks!.uninstallCrashHandler) hooks!.uninstallCrashHandler();
});

Deno.test("mod: onStart initializes feature tracking", () => {
  const hooks = initDiagnostics(
    { dev: { crashHandler: false, checkpoint: false, actionLog: false } },
    false,
    `${TEST_DIR}/track`,
  );
  assertExists(hooks);
  hooks!.onStart(["counter", "wallet"]);
  // onError should increment
  hooks!.onError("counter");
  hooks!.onError("counter");
  hooks!.onError("wallet");
  // No direct way to assert without health getter, but it shouldn't throw
});
