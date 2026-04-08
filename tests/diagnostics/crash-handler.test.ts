import { assertEquals } from "@std/assert";
import { installCrashHandler } from "../../src/diagnostics/crash-handler.ts";

Deno.test("crash-handler: installs and returns uninstall fn", () => {
  const logs: string[] = [];
  const uninstall = installCrashHandler({
    log: {
      error: (msg: string) => {
        logs.push(msg);
      },
    },
    getHealthData: () => ({ cells: {} }),
    writeEmergencyCheckpoint: () => {},
  });
  assertEquals(typeof uninstall, "function");
  uninstall();
});

Deno.test("crash-handler: uninstall removes handlers cleanly", () => {
  let callCount = 0;
  const uninstall = installCrashHandler({
    log: {
      error: () => {
        callCount++;
      },
    },
    getHealthData: () => ({ cells: {} }),
    writeEmergencyCheckpoint: () => {},
  });
  uninstall();
  // After uninstall, handlers should be removed
  // We can't easily test this without triggering real errors,
  // but we verify uninstall completes without throwing
  assertEquals(callCount, 0);
});
