// src/diagnostics/crash-handler.ts — Last-words logger for unhandled errors
// Server-runtime only: file write guarded by typeof Deno check

/** Dependencies injected into the crash handler for logging and emergency checkpoints */
export type CrashHandlerDeps = {
  log: { error: (msg: string, data?: Record<string, unknown>) => void };
  getHealthData: () => {
    cells: Record<string, { errors: number; enabled: boolean }>;
  };
  writeEmergencyCheckpoint: () => void;
};

/** Install global unhandledrejection + error handlers. Returns uninstall function. */
export function installCrashHandler(deps: CrashHandlerDeps): () => void {
  const { log, getHealthData, writeEmergencyCheckpoint } = deps;

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
