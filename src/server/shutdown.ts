// Shutdown orchestrator — multi-phase graceful shutdown (AIO-52 Phase 2)
// Extracted from aio.ts. Order is critical: persist → diag → vitals → hooks → services → DB.

import type { Log } from "../diagnostics/logger.ts";

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
  onStop: (() => void | Promise<void>) | undefined;
  appLock: { release: () => void } | null;
  scheduleManager: { cancelAll: () => void };
  ownManager: { disposeAll: () => void };
  dispatch: { close: () => void; drain: () => Promise<void> };
  getElectronProc: () => { kill: () => void } | null;
  clearElectronProc: () => void;
  disposeUds: () => void;
  getUdsHandle: () => { shutdown: () => void } | null;
  getServer: () => { shutdown: () => Promise<void> };
  /** Late-bound LAN-discovery responder stopper (null when not exposed). */
  getDiscoveryStop?: () => (() => void) | null;
  asyncDb: { close: () => Promise<void> } | null;
  kvDb: { close: () => void } | null;
  /** AUTH-1 session store — closed with the other databases. */
  sessionStore?: { close: () => void } | null;
  /** AUTH-2 password-user store — closed with the other databases. */
  userStore?: { close: () => void } | null;
  setRunning: (v: boolean) => void;
  log: Log;
}

/** Shutdown orchestrator API — idempotent multi-phase graceful shutdown. */
export interface ShutdownOrchestrator {
  shutdown: () => Promise<void>;
}

/** Create a shutdown orchestrator that runs persist, diag, vitals, hooks, and DB cleanup in order. */
export function createShutdownOrchestrator(
  refs: ShutdownRefs,
): ShutdownOrchestrator {
  let shutdownPromise: Promise<void> | null = null;

  async function _doShutdown(): Promise<void> {
    const { log } = refs;

    // Phase 1: Stop accepting new dispatches and drain in-flight async effects
    // BEFORE persisting. Previously dispatch.close() ran in Phase 6 (after
    // persist), so connected clients could still dispatch actions between the
    // final persist and the server close — those changes modified state that
    // persistence had already written and would never re-persist (shuttingDown
    // flag), silently losing them. Closing dispatch up front + draining ensures
    // the final persist captures the true final state.
    refs.setShuttingDown();
    refs.dispatch.close();
    try {
      await refs.dispatch.drain();
    } catch (e) {
      log.error(`shutdown: drain effects — ${e}`);
    }

    // Phase 2: Persist — the final snapshot reflects all pre-shutdown actions.
    try {
      await refs.flushPersist();
    } catch (e) {
      log.error(`shutdown: persist — ${e}`);
    }

    // Phase 3: Diagnostics — flush action log, write final checkpoint
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

    // Phase 4: Vitals cleanup
    const vTimer = refs.getVitalsCheckTimer();
    if (vTimer) clearInterval(vTimer);
    const vSys = refs.getVitalsSystem();
    if (vSys) vSys.destroy();

    // Phase 5: User hooks — await so logger.flush() (wired inside bridge onStop)
    // completes before we move on to releasing locks and closing subsystems (F-3).
    if (refs.onStop) {
      try {
        await refs.onStop();
      } catch (e) {
        log.error(`hook onStop: ${e}`);
      }
    }

    // Phase 6: Release single-instance lock
    if (refs.appLock) {
      refs.appLock.release();
      log.debug(`lock: released (PID ${Deno.pid})`);
    }

    // Phase 7: Subsystem cleanup
    refs.scheduleManager.cancelAll();
    refs.ownManager.disposeAll();
    try {
      refs.getDiscoveryStop?.()?.();
    } catch { /* responder already gone */ }

    const ep = refs.getElectronProc();
    if (ep) {
      try {
        ep.kill();
        refs.clearElectronProc();
      } catch (e) {
        log.error(`shutdown: electron — ${e}`);
      }
    }

    refs.disposeUds();
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
    try {
      refs.sessionStore?.close();
    } catch (e) {
      log.error(`shutdown: sessions — ${e}`);
    }
    try {
      refs.userStore?.close();
    } catch (e) {
      log.error(`shutdown: users — ${e}`);
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
