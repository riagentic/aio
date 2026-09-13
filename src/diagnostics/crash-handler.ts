// src/diagnostics/crash-handler.ts — Last-words logger for unhandled errors
// Server-runtime only: file write guarded by typeof Deno check

/** Dependencies injected into the crash handler for logging and emergency checkpoints */
export type CrashHandlerDeps = {
  log: { error: (msg: string, data?: Record<string, unknown>) => void };
  getHealthData: () => {
    cells: Record<string, { errors: number; enabled: boolean }>;
  };
  writeEmergencyCheckpoint: () => void;
  /** Supervised mode (AioConfig.guardDispatches): after logging + emergency
   *  checkpoint, PREVENT an unhandled promise rejection from killing the process
   *  — a fire-and-forget cell dispatch that rejects becomes a loud log line, not
   *  a crash. Scoped to rejections only: a synchronous
   *  uncaught error is a genuine hard fault and still terminates. Never silent —
   *  the error is always logged first. */
  guardRejections?: boolean;
  /** Has the app finished booting? The guard only applies AFTER boot: a
   *  rejection DURING boot is the app refusing to start (a throwing
   *  onMigrate, a failed bind), and swallowing it leaves a zombie — alive,
   *  serving nothing, holding the lock — where the contract is a non-zero
   *  exit. Found the hard way: flipping the guard's default hung the
   *  framework's own boot-refusal test for over an hour. Defaults to
   *  "booted" so unit callers keep the plain behaviour. */
  isBootComplete?: () => boolean;
};

/** The one rejection the guard must NOT survive: the script's own top level.
 *
 *  Deno reports a rejected top-level `await` as an `unhandledrejection` of the
 *  main module's evaluation — the same event as a stray fire-and-forget. The
 *  guard prevented it like any other, so the script's remaining statements
 *  (its assertions, its `app.close()`) never ran, and the server it had booted
 *  kept the event loop alive: a CI script whose top level threw logged one
 *  line and then HUNG until the job's timeout, instead of exiting non-zero the
 *  way the same script does with `guardDispatches: false`.
 *
 *  Told apart exactly, not by guessing from the stack: `import()` of the main
 *  module settles with the module's own evaluation result, so it rejects with
 *  THIS reason only when the top level is what failed. A stray — before,
 *  during or after the top level runs — finds the module fine, and the guard
 *  keeps doing its job. Exits 1 after the crash line is already logged, which
 *  is what Deno does without the guard. */
function exitIfMainModuleFailed(reason: unknown): void {
  if (typeof Deno === "undefined" || !Deno.mainModule) return;
  let evaluated: Promise<unknown>;
  try {
    evaluated = import(Deno.mainModule);
  } catch {
    return; // aio-ok: no module graph to ask (an embedder) — the guard stands
  }
  evaluated.then(() => {}, (err: unknown) => {
    if (err !== reason) return; // aio-ok: a different failure — not the top level
    console.error(
      `[crash-handler] the main module's top level threw ` +
        `(${Deno.mainModule}) — exiting 1. guardDispatches keeps the app ` +
        `alive through a stray rejection at runtime, never through the ` +
        `script itself failing: nothing after that \`await\` will run, so ` +
        `staying up would only hang. Cause: ${
          reason instanceof Error ? reason.message : String(reason)
        }`,
    );
    Deno.exit(1);
  });
}

/** Install global unhandledrejection + error handlers. Returns uninstall function. */
export function installCrashHandler(deps: CrashHandlerDeps): () => void {
  const {
    log,
    getHealthData,
    writeEmergencyCheckpoint,
    guardRejections,
    isBootComplete,
  } = deps;

  let _handling = false;

  function handle(label: string, error: unknown): void {
    if (_handling) return;
    _handling = true;
    try {
      const msg = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      let health: ReturnType<typeof getHealthData> | undefined;
      try {
        health = getHealthData();
      } catch { /* health unavailable */ }
      try {
        log.error(`[crash-handler] ${label}: ${msg}`, {
          stack: stack ?? "no stack",
          cells: health?.cells as unknown as Record<string, unknown>,
        });
      } catch (logErr) {
        // The last-words logger just became the thing that lost the last
        // words: swallowing here meant a crash whose ONLY record was the one
        // the broken logger did not write. console is the sink that cannot
        // itself be misconfigured — the crash first, then why it was not
        // logged properly.
        console.error(
          `[crash-handler] ${label}: ${msg}\n${stack ?? "no stack"}`,
        );
        console.error(
          `[crash-handler] the logger ALSO failed while reporting that ` +
            `crash: ${logErr}. Cause: the injected log sink threw. Fix: check ` +
            `the log directory's permissions and free space — this crash is ` +
            `in the console only.`,
        );
      }
      if (typeof Deno !== "undefined" && "writeTextFileSync" in Deno) {
        try {
          writeEmergencyCheckpoint();
        } catch { /* checkpoint failed */ }
      }
    } finally {
      _handling = false;
    }
  }

  const onRejection = (e: PromiseRejectionEvent) => {
    handle("unhandledrejection", e.reason);
    // Supervised: log-then-survive. Always AFTER handle() logs, so the failure
    // is never hidden — the process just doesn't die from a stray rejection.
    // Boot rejections stay fatal (see isBootComplete): supervision is for
    // RUNTIME strays, never for "the app refused to start".
    if (guardRejections && (isBootComplete?.() ?? true)) {
      e.preventDefault();
      exitIfMainModuleFailed(e.reason);
    }
  };
  const onError = (e: ErrorEvent) => {
    handle("uncaughtException", e.error ?? e.message);
  };

  globalThis.addEventListener("unhandledrejection", onRejection);
  globalThis.addEventListener("error", onError);

  return () => {
    globalThis.removeEventListener("unhandledrejection", onRejection);
    globalThis.removeEventListener("error", onError);
  };
}
