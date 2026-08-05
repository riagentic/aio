// Shutdown orchestrator — multi-phase graceful shutdown (AIO-52 Phase 2)
// Extracted from aio.ts. Order is critical: persist → diag → vitals → hooks → services → DB.

import type { Log } from "../diagnostics/logger.ts";
import { blocking } from "../state/blocking.ts";
import {
  abortAllInflight,
  DRAIN_TIMEOUT_MS,
  endShutdownAbort,
  settlePending,
} from "../state/method-cancel.ts";

/** How long everything AFTER the drain gets, IN TOTAL — persist, diagnostics,
 *  the user's `onStop`, the lock, the server and the databases share this one
 *  budget, exactly as the two waits in Phase 1 share theirs.
 *
 *  It exists because the drain's documented bound was decorative without it:
 *  one `onStop` hook that never resolves, or one open streaming HTTP response
 *  that `httpServer.shutdown()` waits on, and the app is a process that will
 *  not die — Ctrl-C twice does nothing either, because the second SIGINT gets
 *  the same memoised promise as the first.
 *
 *  5s, because that is the ceiling the SQLite writer's own close path already
 *  uses for each of its waits (`db/async-db.ts`): a healthy teardown finishes
 *  in milliseconds, and a sick one is never cut before the subsystem that IS
 *  bounded has had its own full wait. Total shutdown is therefore bounded by
 *  DRAIN + TEARDOWN, and every phase that runs out says so in the log. */
const TEARDOWN_TIMEOUT_MS = 5000;

/** Distinguishes "the phase timed out" from any value it could return. */
const TIMED_OUT = Symbol("shutdown-phase-timeout");

/** Run ONE shutdown phase.
 *
 *  THE single decider for what a misbehaving phase may cost. A phase can throw
 *  and a phase can hang, and neither may stop the phases after it: releasing
 *  the single-instance lock, closing the databases and marking the app stopped
 *  all live at the END of the list, and their absence is invisible now and
 *  fatal on the NEXT launch (a stale lock file makes the app refuse to start).
 *  Both failures are reported — never swallowed, never silent. */
async function phase(
  log: Log,
  name: string,
  left: () => number,
  fn: () => unknown,
): Promise<void> {
  let r: unknown;
  try {
    r = fn();
  } catch (e) {
    log.error(`shutdown: ${name} — ${e}`);
    return;
  }
  if (!r || typeof (r as Promise<unknown>).then !== "function") return;
  const p = r as Promise<unknown>;
  // If the timer wins the race the rejection below has no other handler —
  // attach one now so a late failure is never an unhandled rejection.
  p.catch(() => {});
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    const out = await Promise.race([
      p.then(() => undefined),
      new Promise<typeof TIMED_OUT>((res) =>
        t = setTimeout(() => res(TIMED_OUT), left())
      ),
    ]);
    if (out === TIMED_OUT) {
      log.warn(
        `shutdown: ${name} did not finish inside the ${TEARDOWN_TIMEOUT_MS}ms ` +
          `teardown budget — continuing without it (whatever it still had to ` +
          `write or release is lost)`,
      );
    }
  } catch (e) {
    log.error(`shutdown: ${name} — ${e}`);
  } finally {
    if (t !== undefined) clearTimeout(t);
  }
}

// ── Whose shutdown a process-wide exit has to wait for ──────────────────
//
// Two apps in ONE process is a supported shape (D2 — an app plus an admin
// panel, an app plus a worker service; this file's own Phase 1 is scoped for
// it), and every path that ends the process used to be written per-app:
//
//   Deno.addSignalListener(sig, () => shutdown().then(() => Deno.exit(0)))
//
// registered once by EACH app. On Ctrl-C both handlers start, and the FIRST
// app to finish calls `Deno.exit(0)` — through the other app's Phase 2, while
// it is still writing its final snapshot. The app that loses is the one with
// more state to write, which is the one with more to lose: measured, a
// second app with an 8 MB snapshot came back with NO stored state at all
// after a plain SIGTERM, and the only trace was its "stopped" line never
// being printed.
//
// Ending the process is a decision about the PROCESS. It belongs here, once,
// and it waits for every app.

/** Every runtime in this process. libraryMode apps register too: they install
 *  no handler of their own, but if some other app in the process exits, they
 *  are going down with it — flushing them first can only save data. */
const _runtimes = new Set<() => Promise<void>>();

/** Register an app's shutdown with the process. Returns the unregister fn. */
export function registerRuntime(shutdown: () => Promise<void>): () => void {
  _runtimes.add(shutdown);
  return () => {
    _runtimes.delete(shutdown);
  };
}

/** Stop EVERY app in this process, then resolve. THE thing to await before
 *  `Deno.exit` on any process-wide exit path (signal, `am stop`, the Electron
 *  window closing). Each app's own `shutdown` is memoised and bounded, so
 *  calling this from N signal listeners is one shutdown per app. */
export function shutdownAllRuntimes(): Promise<void> {
  return Promise.allSettled([..._runtimes].map((f) => f())).then(() => {});
}

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
  dispatch: { close: () => void; drain: (timeoutMs?: number) => Promise<void> };
  /** THIS app's cell names — late-bound, the cells bridge fills them in after
   *  compose. Shutdown aborts and waits for its OWN cells only: a second app
   *  in the same process (D2, and every `testServer()` pair) keeps running. */
  getCellNames: () => string[];
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
    // Both gate steps are synchronous, so the budget below is never consulted —
    // they go through `phase` for its OTHER guarantee: a throw here used to
    // abandon the whole rest of the shutdown, lock and databases included.
    const gate = () => DRAIN_TIMEOUT_MS;
    await phase(log, "mark shutting down", gate, () => refs.setShuttingDown());
    await phase(log, "close dispatch", gate, () => refs.dispatch.close());
    // Abort BEFORE draining. A streaming method (an SSE reply, a subprocess
    // pipe) has no reason of its own to stop, so an un-aborted drain either
    // waits minutes or — before dispatch let effect commits through — killed
    // the method at its next write and lost what it had. Aborting sends each
    // one down its own `s.$signal.aborted` path, and the writes it makes on
    // the way out are exactly what the persist below should capture.
    const ourCells = new Set(refs.getCellNames());
    const aborted = abortAllInflight(ourCells);
    if (aborted > 0) {
      log.debug(`shutdown: aborted ${aborted} in-flight call(s)`);
    }
    try {
      // ONE deadline for the whole phase, shared by both waits — two
      // independent 3s budgets would make the documented bound a 6s hang, and
      // the number people feel is the time the window takes to disappear.
      const deadline = Date.now() + DRAIN_TIMEOUT_MS;
      const left = () => Math.max(1, deadline - Date.now());
      // Async cell methods first: a cell's `execute` runs the method and
      // returns nothing, so the dispatch loop has never known they exist and
      // `drain()` alone sails straight past a streaming reply.
      const stuck = await settlePending(left(), ourCells);
      if (stuck > 0) {
        log.warn(
          `shutdown: ${stuck} call(s) still running at the ` +
            `${DRAIN_TIMEOUT_MS}ms deadline (slow write, or an ignored ` +
            `abort signal) — their remaining writes are lost`,
        );
      }
      await refs.dispatch.drain(left());
    } catch (e) {
      log.error(`shutdown: drain effects — ${e}`);
    } finally {
      // The drain is over — stop pre-aborting new calls for these cell names.
      // A later app in this process (every sequential test) may reuse them.
      endShutdownAbort(ourCells);
    }

    // Phases 2-7 share ONE deadline, for the same reason Phase 1's two waits
    // do: N independent budgets multiply into a bound nobody would accept, and
    // the number that matters is how long the whole thing takes.
    const tDeadline = Date.now() + TEARDOWN_TIMEOUT_MS;
    const tLeft = () => Math.max(1, tDeadline - Date.now());

    // Phase 2: Persist — the final snapshot reflects all pre-shutdown actions.
    await phase(log, "persist", tLeft, () => refs.flushPersist());

    // Phase 3: Diagnostics — flush action log, write final checkpoint
    if (refs.diagHooks) {
      await phase(log, "diagnostics", tLeft, () => refs.diagHooks!.onStop());
      if (refs.diagHooks.uninstallCrashHandler) {
        await phase(
          log,
          "crash handler",
          tLeft,
          () => refs.diagHooks!.uninstallCrashHandler!(),
        );
      }
    }

    // Phase 4: Vitals cleanup
    await phase(log, "vitals", tLeft, () => {
      const vTimer = refs.getVitalsCheckTimer();
      if (vTimer) clearInterval(vTimer);
      refs.getVitalsSystem()?.destroy();
    });

    // Phase 5: User hooks — await so logger.flush() (wired inside bridge onStop)
    // completes before we move on to releasing locks and closing subsystems (F-3).
    // Arbitrary app code, so the budget is doing real work here: a hook that
    // awaits something that never arrives used to be a process that never died.
    if (refs.onStop) {
      await phase(log, "hook onStop", tLeft, () => refs.onStop!());
    }

    // Phase 6: Release single-instance lock
    if (refs.appLock) {
      await phase(log, "lock", tLeft, () => {
        refs.appLock!.release();
        log.debug(`lock: released (PID ${Deno.pid})`);
      });
    }

    // Phase 7: Subsystem cleanup
    await phase(
      log,
      "schedules",
      tLeft,
      () => refs.scheduleManager.cancelAll(),
    );
    await phase(
      log,
      "own processes",
      tLeft,
      () => refs.ownManager.disposeAll(),
    );
    // `schedule.blocking`'s worker pool is part of the scheduler surface and
    // was the one piece nothing ever tore down: its idle threads outlived the
    // app in libraryMode, `testServer()` and any multi-app host. Idle-only,
    // because the pool is process-global (see blocking.disposeIdle).
    await phase(log, "blocking pool", tLeft, () => blocking.disposeIdle());
    try {
      refs.getDiscoveryStop?.()?.();
    } catch { /* responder already gone */ }

    const ep = refs.getElectronProc();
    if (ep) {
      await phase(log, "electron", tLeft, () => {
        ep.kill();
        refs.clearElectronProc();
      });
    }

    await phase(log, "uds dispose", tLeft, () => refs.disposeUds());
    const udsH = refs.getUdsHandle();
    if (udsH) await phase(log, "uds", tLeft, () => udsH.shutdown());

    // Phase 7: Server + DB
    await phase(log, "server", tLeft, () => refs.getServer().shutdown());
    await phase(log, "sqlite", tLeft, () => refs.asyncDb?.close());
    await phase(log, "kv", tLeft, () => refs.kvDb?.close());
    await phase(log, "sessions", tLeft, () => refs.sessionStore?.close());
    await phase(log, "users", tLeft, () => refs.userStore?.close());

    await phase(log, "mark stopped", tLeft, () => refs.setRunning(false));
  }

  function shutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = _doShutdown();
    return shutdownPromise;
  }

  return { shutdown };
}
