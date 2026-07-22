// crash-handler — last-words logger for unhandled errors/rejections. The
// install path had coverage but handle()/onError/onRejection were zero-hit;
// a broken crash handler fails exactly when you most need diagnostics.
import { assert, assertEquals } from "@std/assert";
import { installCrashHandler } from "../src/diagnostics/crash-handler.ts";

function makeDeps() {
  const logged: { msg: string; data?: Record<string, unknown> }[] = [];
  let checkpoints = 0;
  return {
    logged,
    checkpoints: () => checkpoints,
    deps: {
      log: {
        error: (msg: string, data?: Record<string, unknown>) =>
          logged.push({ msg, data }),
      },
      getHealthData: () => ({
        cells: { counter: { errors: 2, enabled: true } },
      }),
      writeEmergencyCheckpoint: () => {
        checkpoints++;
      },
    },
  };
}

Deno.test("crash-handler: logs an error event + writes an emergency checkpoint", () => {
  const { logged, checkpoints, deps } = makeDeps();
  const uninstall = installCrashHandler(deps);
  try {
    const evt = new ErrorEvent("error", {
      error: new Error("boom"),
      message: "boom",
    });
    // preventDefault so Deno's test runner doesn't treat it as a real crash.
    evt.preventDefault?.();
    globalThis.dispatchEvent(evt);
    assertEquals(logged.length, 1);
    assert(logged[0]!.msg.includes("uncaughtException"), logged[0]!.msg);
    assert(logged[0]!.msg.includes("boom"));
    assert(logged[0]!.data?.cells, "health snapshot attached");
    assertEquals(checkpoints(), 1, "emergency checkpoint written");
  } finally {
    uninstall();
  }
});

Deno.test("crash-handler: handles a rejection and survives a throwing health probe", () => {
  const { logged, deps } = makeDeps();
  // Health probe throws mid-crash — handler must not rethrow.
  deps.getHealthData = () => {
    throw new Error("health down");
  };
  const uninstall = installCrashHandler(deps);
  try {
    const evt = new PromiseRejectionEvent("unhandledrejection", {
      promise: Promise.reject("ignored").catch(() => {}) as Promise<never>,
      reason: "async boom",
    });
    evt.preventDefault?.();
    globalThis.dispatchEvent(evt);
    assertEquals(logged.length, 1);
    assert(logged[0]!.msg.includes("unhandledrejection"));
    assert(logged[0]!.msg.includes("async boom"));
  } finally {
    uninstall();
  }
});

Deno.test("crash-handler: uninstall detaches the listeners", () => {
  const { logged, deps } = makeDeps();
  const uninstall = installCrashHandler(deps);
  uninstall();
  const evt = new ErrorEvent("error", {
    error: new Error("after-uninstall"),
    message: "after-uninstall",
  });
  evt.preventDefault?.();
  globalThis.dispatchEvent(evt);
  assertEquals(logged.length, 0, "no logging after uninstall");
});
