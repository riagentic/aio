// Shutdown orchestrator — multi-phase graceful shutdown (AIO-52 Phase 2)
// Extracted from aio.ts. Order is critical: persist → diag → vitals → hooks → services → DB.

import type { Log } from "./logger.ts";

/** Cleanup handles collected from various subsystems — uses getters for late-bound refs */
export interface ShutdownRefs {
  flushPersist: () => Promise<void>;
  setShuttingDown: () => void;
  diagHooks: {
    onStop: () => Promise<void>;
    uninstallCrashHandler?: () => void;
  } | null;
  getVitalsCheckTimer: () => ReturnType<typeof setInterval> | undefined;
  getVitalsSystem: () => { destroy: () => void } | undefined;
  onStop: (() => void) | undefined;
  appLock: { release: () => void } | null;
  scheduleManager: { cancelAll: () => void };
  dispatch: { close: () => void };
  getElectronProc: () => { kill: () => void } | null;
  clearElectronProc: () => void;
  getUdsThrottle: () => ReturnType<typeof setTimeout> | null;
  clearUdsThrottle: () => void;
  getUdsHandle: () => { shutdown: () => void } | null;
  getServer: () => { shutdown: () => Promise<void> };
  asyncDb: { close: () => Promise<void> } | null;
  kvDb: { close: () => void } | null;
  setRunning: (v: boolean) => void;
  log: Log;
}

export interface ShutdownOrchestrator {
  shutdown: () => Promise<void>;
}

export function createShutdownOrchestrator(
  refs: ShutdownRefs,
): ShutdownOrchestrator {
  let shutdownPromise: Promise<void> | null = null;

  async function _doShutdown(): Promise<void> {
    const { log } = refs;

    // Phase 1: Persist — BEFORE onStop/destroyAll (destroyAll resets state)
    refs.setShuttingDown();
    try {
      await refs.flushPersist();
    } catch (e) {
      log.error(`shutdown: persist — ${e}`);
    }

    // Phase 2: Diagnostics — flush action log, write final checkpoint
    if (refs.diagHooks) {
      try {
        await refs.diagHooks.onStop();
      } catch (e) {
        log.error(`shutdown: diagnostics — ${e}`);
      }
      if (refs.diagHooks.uninstallCrashHandler) {
        refs.diagHooks.uninstallCrashHandler();
      }
    }

    // Phase 3: Vitals cleanup
    const vTimer = refs.getVitalsCheckTimer();
    if (vTimer) clearInterval(vTimer);
    const vSys = refs.getVitalsSystem();
    if (vSys) vSys.destroy();

    // Phase 4: User hooks
    if (refs.onStop) {
      try {
        refs.onStop();
      } catch (e) {
        log.error(`hook onStop: ${e}`);
      }
    }

    // Phase 5: Release single-instance lock
    if (refs.appLock) {
      refs.appLock.release();
      log.debug(`lock: released (PID ${Deno.pid})`);
    }

    // Phase 6: Subsystem cleanup
    refs.scheduleManager.cancelAll();
    refs.dispatch.close();

    const ep = refs.getElectronProc();
    if (ep) {
      try {
        ep.kill();
        refs.clearElectronProc();
      } catch (e) {
        log.error(`shutdown: electron — ${e}`);
      }
    }

    const udsT = refs.getUdsThrottle();
    if (udsT) {
      clearTimeout(udsT);
      refs.clearUdsThrottle();
    }
    const udsH = refs.getUdsHandle();
    if (udsH) {
      try {
        udsH.shutdown();
      } catch (e) {
        log.error(`shutdown: uds — ${e}`);
      }
    }

    // Phase 7: Server + DB
    try {
      await refs.getServer().shutdown();
    } catch (e) {
      log.error(`shutdown: server — ${e}`);
    }
    try {
      await refs.asyncDb?.close();
    } catch (e) {
      log.error(`shutdown: sqlite — ${e}`);
    }
    try {
      refs.kvDb?.close();
    } catch (e) {
      log.error(`shutdown: kv — ${e}`);
    }

    refs.setRunning(false);
  }

  function shutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = _doShutdown();
    return shutdownPromise;
  }

  return { shutdown };
}
