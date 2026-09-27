// The crash handler is the "last words" logger: whatever the rejection
// reason is, it must LOG it (and, supervised, keep the process alive). A
// rejection whose reason is a null-prototype object (a JSON-ish error body,
// a dictionary built with Object.create(null)) made `String(error)` throw
// inside handle() — before log.error ran and before preventDefault() — so
// the crash went unlogged, the emergency checkpoint was never written, and
// guardRejections did not guard.
import { assert, assertEquals } from "@std/assert";
import { installCrashHandler } from "../src/diagnostics/crash-handler.ts";

Deno.test("crash handler: a null-prototype rejection reason is logged and guarded", () => {
  const logged: string[] = [];
  let checkpoints = 0;
  // Absorb any exception a listener throws during dispatchEvent, so a
  // failing handler shows up as an assertion, not a dead test process.
  const absorbed: unknown[] = [];
  const absorb = (e: ErrorEvent) => {
    absorbed.push(e.error);
    e.preventDefault();
  };
  globalThis.addEventListener("error", absorb);
  const uninstall = installCrashHandler({
    log: { error: (msg) => logged.push(msg) },
    getHealthData: () => ({ cells: {} }),
    writeEmergencyCheckpoint: () => {
      checkpoints++;
    },
    guardRejections: true,
    isBootComplete: () => true,
  });
  try {
    const reason = Object.create(null) as Record<string, unknown>;
    reason.code = "E_UPSTREAM";
    const promise = Promise.reject(reason);
    promise.catch(() => {}); // the test itself must not leak a real rejection
    const ev = new PromiseRejectionEvent("unhandledrejection", {
      promise,
      reason,
      cancelable: true,
    });
    globalThis.dispatchEvent(ev);

    assert(
      logged.some((m) => m.includes("unhandledrejection")),
      `the rejection was never logged; logged=${JSON.stringify(logged)} ` +
        `listener threw=${absorbed.map(String).join(" | ")}`,
    );
    assert(
      ev.defaultPrevented,
      "guardRejections: true must keep the process alive (preventDefault)",
    );
    assertEquals(checkpoints, 1, "the emergency checkpoint must be written");
  } finally {
    uninstall();
    globalThis.removeEventListener("error", absorb);
  }
});
