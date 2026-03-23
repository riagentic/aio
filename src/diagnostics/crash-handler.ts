// src/diagnostics/crash-handler.ts — Last-words logger for unhandled errors
// Server-runtime only: file write guarded by typeof Deno check

export type CrashHandlerDeps = {
  log: { error: (msg: string, data?: Record<string, unknown>) => void };
  getHealthData: () => {
    features: Record<string, { errors: number; enabled: boolean }>;
  };
  writeEmergencyCheckpoint: () => void;
};

/** Install global unhandledrejection + error handlers. Returns uninstall function. */
export function installCrashHandler(deps: CrashHandlerDeps): () => void {
  const { log, getHealthData, writeEmergencyCheckpoint } = deps;

  function handle(label: string, error: unknown): void {
    const msg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    const health = getHealthData();
    log.error(`[crash-handler] ${label}: ${msg}`, {
      stack: stack ?? "no stack",
      features: health.features as unknown as Record<string, unknown>,
    });
    if (typeof Deno !== "undefined" && "writeTextFileSync" in Deno) {
      writeEmergencyCheckpoint();
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
