// The exit watchdog — the budget in `shutdown-budget.ts` is a GUARANTEE.
//
// Every shutdown PHASE was bounded long before this file existed; the EXIT was
// not. Each process-wide exit path read
// `shutdownAllRuntimes().then(() => Deno.exit(0))`, so one resource nobody
// unref'd — an open TLS connection, a worker that never posted its close, a
// `setInterval` a subsystem forgot — kept the loop alive after Phase 7 and the
// `Deno.exit` behind it never ran. Measured in a full-suite run: an `--expose`
// app ignored SIGTERM for 15 s (nearly 2x its own declared 8 s budget) and had
// to be SIGKILLed. A SIGKILLed app is one that did not finish writing.
//
// So: a hung runtime must NOT be able to hold the process, the exit must be
// LOUD (never a silent 0), and a healthy shutdown must never trip the timer.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  _resetStopProcess,
  _setExitFn,
  _setWatchdogMs,
  registerRuntime,
  stopProcess,
} from "../src/server/shutdown.ts";
import {
  EXIT_WAIT_MS,
  EXIT_WATCHDOG_MS,
  SHUTDOWN_BUDGET_MS,
} from "../src/server/shutdown-budget.ts";
import { log } from "../src/diagnostics/logger-api.ts";

/** Run `fn` with the exit captured instead of taken, and the watchdog short. */
async function withCapturedExit(
  watchdogMs: number,
  fn: (seen: { code: number | null; logs: string[] }) => Promise<void>,
): Promise<{ code: number | null; logs: string[] }> {
  const seen: { code: number | null; logs: string[] } = {
    code: null,
    logs: [],
  };
  const restoreExit = _setExitFn((code: number) => {
    if (seen.code === null) seen.code = code;
    // Not a real exit: return a never-typed value so the caller's control flow
    // is identical to production, where nothing after this line runs.
    return undefined as never;
  });
  const restoreWatchdog = _setWatchdogMs(watchdogMs);
  const realError = log.error;
  log.error = (msg: string) => {
    seen.logs.push(String(msg));
  };
  try {
    await fn(seen);
  } finally {
    log.error = realError;
    restoreWatchdog();
    restoreExit();
    _resetStopProcess();
  }
  return seen;
}

Deno.test("watchdog: a runtime that never stops cannot hold the process", async () => {
  const unregister = registerRuntime(() => new Promise<void>(() => {}));
  try {
    const seen = await withCapturedExit(60, async () => {
      stopProcess(0);
      await new Promise((r) => setTimeout(r, 400));
    });
    assertEquals(
      seen.code,
      75,
      "a forced exit must NOT report success — 0 would tell a supervisor the " +
        "app stopped cleanly when it did not",
    );
    const said = seen.logs.join("\n");
    assertStringIncludes(said, "did not exit within");
    assertStringIncludes(
      said,
      "holding the event loop open",
      "the message must name the CLASS of cause, not just the symptom",
    );
  } finally {
    unregister();
  }
});

Deno.test("watchdog: a healthy shutdown exits 0 and never trips the timer", async () => {
  let stopped = 0;
  const unregister = registerRuntime(() => {
    stopped++;
    return Promise.resolve();
  });
  try {
    const seen = await withCapturedExit(60, async () => {
      stopProcess(0);
      await new Promise((r) => setTimeout(r, 300));
    });
    assertEquals(stopped, 1);
    assertEquals(seen.code, 0);
    assertEquals(seen.logs, [], "a clean stop says nothing at error level");
  } finally {
    unregister();
  }
});

Deno.test("watchdog: N signals are ONE exit", async () => {
  let stopped = 0;
  const unregister = registerRuntime(async () => {
    stopped++;
    await new Promise((r) => setTimeout(r, 20));
  });
  try {
    let exits = 0;
    await withCapturedExit(60, async () => {
      const restore = _setExitFn((_c: number) => {
        exits++;
        return undefined as never;
      });
      try {
        stopProcess(0);
        stopProcess(0);
        stopProcess(0);
        await new Promise((r) => setTimeout(r, 200));
      } finally {
        restore();
      }
    });
    assertEquals(stopped, 1, "the runtime is stopped once, not per signal");
    assertEquals(exits, 1, "and the process is ended once");
  } finally {
    unregister();
  }
});

Deno.test("watchdog: everything that waits for an app outlasts the app's own deadline", () => {
  // The invariant that makes the watchdog safe: whoever waits before SIGKILL
  // must wait longer than the app may take to end itself, or a takeover kills
  // an app one tick before it would have said WHY it was stuck.
  assert(
    EXIT_WATCHDOG_MS > SHUTDOWN_BUDGET_MS,
    "the watchdog must never cut a legitimately-bounded teardown short",
  );
  assert(
    EXIT_WAIT_MS > EXIT_WATCHDOG_MS,
    "a waiter that SIGKILLs before the app's own watchdog fires turns a " +
      "loud, diagnosable stop into a silent kill",
  );
});
