// Shutdown budget — the TWO numbers a graceful stop may cost, in one place.
//
// `shutdown.ts` spends them (Phase 1 drains for DRAIN_TIMEOUT_MS, Phases 2–7
// share TEARDOWN_TIMEOUT_MS). Everything that WAITS for an app to stop — `am
// stop`/`am start` on a "stopping" lock, a `--kill-existing` takeover — has to
// wait at least their sum before it may SIGKILL, or it cuts a legitimate final
// flush short. `am` used to retype its own 3 s and 5 s next to a runtime that
// promised 8 s; an app doing a 4 s `onStop` was killed mid-write by the tool
// that exists to stop it politely. One decider, imported by both sides.
//
// Kept free of heavy imports on purpose: the lock module and `am` import it,
// and neither wants the worker pool `shutdown.ts` pulls in.
import { DRAIN_TIMEOUT_MS } from "../state/method-cancel.ts";

export { DRAIN_TIMEOUT_MS };

/** How long everything AFTER the drain gets, IN TOTAL — persist, diagnostics,
 *  the user's `onStop`, the lock, the server and the databases share this one
 *  budget, exactly as the two waits in Phase 1 share theirs. 5 s, because that
 *  is the ceiling the SQLite writer's own close path already uses for each of
 *  its waits (`db/async-db.ts`). */
export const TEARDOWN_TIMEOUT_MS = 5000;

/** The whole graceful stop, worst case: drain + teardown. Anything that waits
 *  for an aio app to exit before escalating to SIGKILL waits at least this. */
export const SHUTDOWN_BUDGET_MS = DRAIN_TIMEOUT_MS + TEARDOWN_TIMEOUT_MS;

/** Slack over `SHUTDOWN_BUDGET_MS` before an aio process ends ITSELF.
 *
 *  Every shutdown PHASE is bounded (`shutdown.ts`'s `phase`), but until
 *  alpha72 the EXIT was not: each process-wide exit path reads
 *  `shutdownAllRuntimes().then(() => Deno.exit(0))`, so one resource nobody
 *  unref'd — an open TLS connection, a worker that never posted its close, a
 *  `setInterval` a subsystem forgot — keeps the event loop alive after Phase 7
 *  and the `Deno.exit` never runs. The budget was an intention, not a
 *  guarantee, and the caller waiting on it escalated to SIGKILL: an app that
 *  "did not stop when asked" is an app that did not finish writing.
 *
 *  `stopProcess()` arms a watchdog for this long and ends the process anyway,
 *  saying which apps were still stopping. 2 s of slack over the budget so a
 *  legitimately slow-but-bounded teardown is never cut short. */
export const EXIT_WATCHDOG_MS = SHUTDOWN_BUDGET_MS + 2000;

/** How long anything that waits for an aio app to exit must wait before it may
 *  SIGKILL: the app's own self-kill, plus a second for the exit to land. */
export const EXIT_WAIT_MS = EXIT_WATCHDOG_MS + 1000;
