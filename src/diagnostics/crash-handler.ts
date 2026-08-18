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
      } catch { /* logger failed during crash */ }
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
    if (guardRejections && (isBootComplete?.() ?? true)) e.preventDefault();
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
