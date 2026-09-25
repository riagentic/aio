// Cells-to-legacy config bridge — converts CellsConfig → AioConfig for _run()
// Also wraps the returned AioApp with memory monitor, cells API, and bindCell.

import { physicalMemoryBytes } from "./heap-policy.ts";
import type { CellDef, ComposedCells } from "../state/cell.ts";
import type { Msg } from "../state/cell-types.ts";
import { _releaseCellBindings } from "../state/cell-reactive.ts";
import { _boundDispatchOf, _whileCellsBoot } from "../state/cell-catalog.ts";
import { _bindCallScope, mergeLongIntoPerfBudget } from "../state/cell-impl.ts";
import { bindCell } from "../state/cell.ts";
import {
  _countCellError,
  _noteCellAction,
  _setRemoteLifecycle,
} from "../state/cell-compose.ts";
import { createMemoryMonitor } from "../diagnostics/memory-monitor.ts";
import {
  createAioError,
  reportError as reportAioError,
  type ReportErrorOpts,
  teachableError,
} from "../diagnostics/error.ts";
import { nearestOf } from "../state/cell-helpers.ts";
import { parseRetention } from "../sync/op-buffer.ts";
import { resolveOptions } from "../diagnostics/types.ts";
import { isLockOwnerAlive, lockKey, readLock } from "./single-instance-lock.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { AioLogger, log } from "../diagnostics/logger.ts";
import { _setStartSocket } from "../diagnostics/logger-core.ts";
import {
  installAppLogger,
  markAppLoggerUp,
  releaseAppLogger,
  setLoggerScope,
} from "../diagnostics/logger-api.ts";
import {
  createStormDetector,
  type StormInfo,
} from "../diagnostics/dispatch-storm.ts";
import { WORKER_PATCH_ACTION } from "../state/cell-compose-reduce.ts";
import { _setDiagScope, diagEmit } from "../diagnostics/diagnostic-bus.ts";
import { makeRedactor } from "../diagnostics/redact.ts";
import { parseCli } from "./aio-cli.ts";
import { resolveAppId } from "./single-instance-lock.ts";
import { VALID_AIO_CONFIG_KEYS } from "./config.ts";
import { appDirs, registeredProfile } from "./app-dirs.ts";
import type { AioApp, AioConfig, AioUser, CellsConfig } from "./aio-types.ts";
import type { CellFieldFilter } from "../state/cell-types.ts";
import {
  persistFilterOf,
  persistingCellIds,
} from "../state/cell-persist-filter.ts";
import { setDiagnosticsOptOut } from "../diagnostics/diagnostics-optout.ts";
import { _serverFnsAppLive } from "./server-fns.ts";
import { closedWorkerCall } from "./cell-worker.ts";
import { _hostsWorkerThreads } from "./cell-worker-pool.ts";

/** Whose app is running this code — for the logger, the diagnostic bus and
 *  the `degraded()` registries.
 *
 *  Two apps in one process (library mode, `testApps`) each own a logger, and
 *  `log.*` is one module-level function. The scope used to be entered only
 *  around what the bridge hands the runtime — reduce, effects, the dispatch
 *  hooks, start and stop — so everything ELSE an app started fell back to
 *  whichever app booted last: a route handler, a timer armed in `onStart` or
 *  in a method, the app's own sockets. Now each `aio.run()` runs AS its app
 *  (`runAsApp`), and AsyncLocalStorage carries that into everything the boot
 *  creates. The scope exists before the logger does: until `initLogger` fills
 *  it in, the app is console-only — never the other app's files.
 *
 *  The wrappers below still enter the scope explicitly: a cell method called
 *  from outside any app (a test, a host) has to run as the app it is bound to. */
type AppScope = { logger: AioLogger | null; closed?: boolean };
const _appScope = new AsyncLocalStorage<AppScope>();
/** The running app's scope — never a CLOSED app's. Deno pins the process's
 *  ambient async context to wherever an npm module is first evaluated
 *  (`outside-app.ts`), and an app's method can `await import("npm:…")`, which
 *  nothing here can intercept: that app's scope then surrounds every later
 *  unwrapped callback in the process — the next `Deno.test`, another host's
 *  handler — long after `close()`. Once closed, a scope is no app's: the code
 *  it surrounds is "outside any app", which is what it is. */
function liveScope(): AppScope | undefined {
  const s = _appScope.getStore();
  return s && !s.closed ? s : undefined;
}
setLoggerScope(() => liveScope()?.logger);
_setDiagScope(liveScope);

/** Run `fn` — a whole `aio.run()` — as a new app. @internal */
export function runAsApp<T>(fn: () => T): T {
  return _appScope.run({ logger: null }, fn);
}

/** Each app's scope, by the config object it booted from (`initLogger`,
 *  `buildLegacyConfig` and `wrapAppWithCells` all receive the same `fc`). */
const _scopeOf = new WeakMap<CellsConfig, AppScope>();

/** The scope `fc`'s code runs in — its boot's, or (a bridge built outside
 *  `aio.run`, e.g. a test) one around its logger. */
function scopeOf(
  fc: CellsConfig,
  logger: AioLogger | null,
): AppScope | undefined {
  return _scopeOf.get(fc) ?? (logger ? { logger } : undefined);
}

/** Run `fn` as `scope`'s app. No scope → the caller's own. */
function inAppScope<T>(scope: AppScope | undefined, fn: () => T): T {
  return scope ? _appScope.run(scope, fn) : fn();
}

/** Whether a top-level state key survives a `persist`/`ui` field filter.
 *  Mirrors the runtime filter semantics ("all"/"none"/include/exclude; default
 *  = "all"). Powers the trojan `fields` route (amui State overview).
 *
 *  KEY-LEVEL ONLY, and that is all this answer may ever be used for. A dot
 *  path flattens to its head here (`exclude: ["seeds.encSeed"]` ⇒ the key
 *  `seeds` ships), which is the right answer for a badge saying "this key
 *  reaches the UI" and the WRONG one for anything that screens VALUES: a bug
 *  report built on this map kept every row's ciphertext. Screening a value
 *  takes the filter itself (`_cellVisible` / `_cellPersist`) through
 *  `applyCellFieldFilter` — the walker the wire, the patch path, the client
 *  read seam and the persistence read-back all share. */
function fieldIncluded(
  key: string,
  filter: CellFieldFilter | undefined,
): boolean {
  if (filter === undefined || filter === "all") return true;
  if (filter === "none") return false;
  if ("include" in filter) return filter.include.includes(key);
  if ("exclude" in filter) {
    // exclude entries may be dot-paths ("a.b"); a top-level key is excluded only
    // by an exact match (a nested exclude still persists/exposes the parent key).
    return !filter.exclude.includes(key);
  }
  return true;
}

/** Inputs for buildLegacyConfig — avoids 12-param function signature */
export type BuildLegacyConfigInput = {
  fc: CellsConfig;
  composed: ComposedCells;
  beforeReduce:
    | ((action: unknown, state: unknown, user?: AioUser) => unknown | null)
    | undefined;
  onRestore: ((state: unknown) => unknown) | undefined;
  autoGetUIState: ((s: unknown, user?: unknown) => unknown) | undefined;
  autoGetDBState: (s: unknown) => unknown;
  /** From `composeCellsWiring` — `persistingCellIds(composed)`, the restore
   *  half of the persist rule. Absent (a harness that bridges a bare
   *  composition), it is asked of the SAME decider — never re-derived here. */
  persistingCellIds?: Set<string>;
  cellPatchStrategies: Map<
    string,
    import("../state/state-filter.ts").CellPatchStrategy
  >;
  cellFilterFieldsMap: Map<
    string,
    import("../state/state-filter.ts").PatchFilterFields
  >;
  cellReportOpts: ReportErrorOpts;
  logger: AioLogger | null;
  appRef: { current: AioApp<Record<string, unknown>, unknown> | null };
};

/** One line per `listensTo` pair whose two cells disagree on `sync` — a
 *  listener reacting to a source's actions where exactly one of the two syncs.
 *
 *  SUPPORTED, so a warning and never a refusal: the reaction is journalled
 *  and resolved across both save clocks (journal.ts J6/J7). What the line
 *  states is what the app's user sees differently, read off the code:
 *  • sync listener, plain source — the reaction is no op in the listener's
 *    log: it is a server-origin write, durable once folded into the
 *    listener's snapshot (≤ 500 ms; at commit only under `journal: true`,
 *    aio.ts `_afterAction`) and pushed to its clients from there.
 *  • plain listener, sync source — a tab applies the source's call at once
 *    and queues it offline, but a tab folds an op through its OWN cell only
 *    (browser-sync.ts), so the listener changes only once the server has
 *    applied the op: it lags while the client is offline, and an op the
 *    server refuses triggers no reaction. The reaction is saved in the
 *    listener's store, not in the source's op-log.
 *
 *  Pure over the defs (after `applyLocalFirst`, which decides `sync`). A pair
 *  is said once however many of the source's actions the listener takes.
 *  Shared with the in-process harnesses (testing/boot-refusals.ts), so
 *  `aio.run`, `testServer`, `bootCells` and `testUI` say the same line.
 *  @internal */
export function syncListensMismatches(
  cells: readonly CellDef[],
): string[] {
  const byId = new Map(cells.map((c) => [c.__aio.id, c]));
  const said = new Set<string>();
  const out: string[] = [];
  for (const listener of cells) {
    const l = listener.__aio.id;
    for (const type of listener.__aio.foreignActions ?? []) {
      const ci = type.indexOf(":");
      if (ci <= 0) continue;
      const s = type.slice(0, ci);
      const source = byId.get(s);
      if (!source || s === l) continue;
      const lSync = !!listener.__aio.syncConfig;
      if (lSync === !!source.__aio.syncConfig || said.has(`${l}\0${s}`)) {
        continue;
      }
      said.add(`${l}\0${s}`);
      out.push(
        lSync
          ? `listensTo: "${l}" (sync: true) listens to "${s}" (not sync) — ` +
            `supported, but "${l}"'s reaction is no op in its op-log: it is a ` +
            `server write, durable once folded into "${l}"'s snapshot (within ` +
            `500 ms; at commit only with journal: true) and pushed to its ` +
            `clients from there (said once per pair)`
          : `listensTo: "${l}" (not sync) listens to "${s}" (sync: true) — ` +
            `supported, but a tab applies a "${s}" call at once (and queues ` +
            `it offline) while "${l}" reacts only on the server, once the op ` +
            `arrives there: "${l}" lags "${s}" while a client is offline, ` +
            `never reacts to an op the server refuses, and its reaction is ` +
            `saved in "${l}"'s store, not in "${s}"'s op-log (said once per ` +
            `pair)`,
      );
    }
  }
  return out;
}

/** Build an AioConfig from composed cells + CellsConfig (the v0.5 cells-based API) */
export function buildLegacyConfig(
  input: BuildLegacyConfigInput,
): AioConfig<Record<string, unknown>, unknown, unknown> {
  const {
    fc,
    composed,
    beforeReduce,
    onRestore,
    autoGetUIState,
    autoGetDBState,
    persistingCellIds: persisting = persistingCellIds(composed),
    cellPatchStrategies,
    cellFilterFieldsMap,
    cellReportOpts: _cellReportOpts,
    logger,
    appRef,
  } = input;
  const scope = scopeOf(fc, logger);
  // A `listensTo` pair across the sync line — supported, said once per boot.
  inAppScope(scope, () => {
    for (const line of syncListensMismatches(composed.cells)) log.warn(line);
  });
  // `cell({ diagnostics: false })` — this cell's actions stay out of the
  // on-disk dev diagnostics. Registered HERE, beside the other per-cell facts
  // pulled off `composed.cells`, rather than threaded through
  // `initDiagnostics`: the writer is built before the cells are, and widening
  // an exported signature for a process-global fact buys nothing. Replaced,
  // not accumulated, so a second app in the same process starts clean.
  setDiagnosticsOptOut(
    composed.cells
      .filter((c) => c.__aio.diagnostics === false)
      .map((c) => c.__aio.id),
  );
  // Dispatch-storm guard (watcher-loop field report #2) — every server dispatch
  // flows through beforeReduce, so frequency is measured (and optionally
  // circuit-broken) before reducers/effects/logging amplify the loop.
  const onStorm = (info: StormInfo): void => {
    // `ended`, not a guess from the rate. A storm that stops by dropping
    // back UNDER the threshold ends at a non-zero rate, so this branch never
    // fired for it and the recovery was reported as a fresh storm — with a
    // rate below the threshold that triggers one.
    if (info.ended) {
      log.info(
        "storm",
        `${info.type} storm ended after ${info.seconds}s above threshold`,
      );
      return;
    }
    log.warn(
      "storm",
      `DISPATCH_STORM: ${info.type} fired ${info.rate}×/s for ${info.seconds}s${
        info.breaking ? " — circuit-breaking (dropping) it" : ""
      } — look for a feedback loop (e.g. an fs watcher observing your own writes)`,
    );
    diagEmit({
      type: "dispatch:storm",
      severity: "warning",
      source: "dispatch",
      message: `${info.type} fired ${info.rate}×/s for ${info.seconds}s`,
      detail: info,
      hint:
        "find the feedback loop; set dispatchStorm.breaker to drop it automatically",
    });
  };
  const stormCfg = typeof fc.dispatchStorm === "object" ? fc.dispatchStorm : {};
  // `true`/omitted → defaults; object → tuned; false → disabled.
  const storm = fc.dispatchStorm === false
    ? null
    : createStormDetector({ ...stormCfg, onStorm });
  // A `worker: true` cell's commits arrive as patch batches, all of ONE type
  // (`__aioWorkerPatch`) whichever cell sent them. Tracked under that type,
  // a worker cell streaming progress was reported as a storm of an action
  // nobody wrote, every worker cell's rate was summed into one, and the
  // breaker DROPPED batches the worker had already committed — its copy and
  // this one then disagreed for good (measured: the method returned 603 rows
  // while state held 472, and every later op landed on the wrong copy). Tracked per
  // cell, under the name the journal gives the batch, and never dropped: a
  // batch is a record of writes made, not new input.
  const workerStorm = fc.dispatchStorm === false
    ? null
    : createStormDetector({ ...stormCfg, breaker: false, onStorm });
  const userBeforeReduce = beforeReduce as
    | ((a: unknown, s: unknown, u?: unknown) => unknown)
    | undefined;

  // ── Mechanical passthrough — the fail-closed core of this bridge ──
  // Every plain CellsConfig option rides through by DEFAULT. This used to be a
  // hand-maintained field-by-field copy, and a forgotten line silently dropped
  // the option after it was typed and validated (`strictOrigin`, then
  // `redactActions`, then `appDir` — data written to the wrong directory, and
  // `renderBudget` — never reached the browser). Only keys the bridge CONSUMES
  // are held back; keys it wraps or computes are overridden below, after the
  // spread. tests/config-bridge-completeness.test.ts proves the passthrough at
  // runtime with a sentinel per documented option.
  const {
    cells: _consumedCells, // composed already
    logging: _consumedLogging, // became `logger`
    dispatchStorm: _consumedStorm, // became the storm detector above
    diagnostics: _renamedDiagnostics, // forwarded as _diagnostics below
    onCheckpointRestore: _renamedOcr, // forwarded as _onCheckpointRestore below
    ...passthrough
  } = fc as Record<string, unknown>;
  // Composition-time options (cellDefaults, localFirst, isolate, …) are
  // consumed BEFORE this bridge and are not AioConfig keys — the runtime
  // validator rightly rejects them. Filter to the runtime's own whitelist, so
  // both directions stay mechanical: a new option added to both whitelists
  // (which option validation already forces) rides through with no edit here.
  for (const k of Object.keys(passthrough)) {
    if (!VALID_AIO_CONFIG_KEYS.has(k)) delete passthrough[k];
  }

  /** Cells the WORKER POOL owns, and a predicate over their ids.
   *
   *  A `worker: true` cell composes on BOTH sides — main routes to it, the
   *  worker runs it — and both sides walked `initAll`/`destroyAll`, so its
   *  `onInit` and `onDestroy` each ran TWICE, on two threads. Measured: two
   *  executions, `where: ["worker","worker"]`, for one boot. An `onInit` that
   *  opens a device, seeds a table or starts a watcher did all of it twice,
   *  and the in-isolate harness could never show it because there is no
   *  second isolate there — the textbook green-test-broken-prod shape.
   *
   *  This is the aio.run path, where the pool exists; the harness composes on
   *  the standalone runtime and keeps running them on its one thread. */
  const workerCells = composed.cells.filter((f) => f.__aio.worker === true);
  // …only when this boot ACTUALLY hosts workers — the pool's own decider. A
  // `worker: true` cell in libraryMode with no worker entry, or under an entry
  // no worker can be spawned from, runs in THIS isolate and must init here.
  // Skipping it unconditionally would trade a double init for none at all.
  const hostsWorkers = _hostsWorkerThreads(
    (fc as { libraryMode?: boolean }).libraryMode,
    (fc as { _workerEntry?: string })._workerEntry,
  );
  const workerIds = new Set(
    hostsWorkers ? workerCells.map((f) => f.__aio.id) : [],
  );
  const _ownedByWorker = (id: string) => workerIds.has(id);

  return {
    ...(passthrough as Partial<
      AioConfig<Record<string, unknown>, unknown, unknown>
    >),
    appId: fc.appId,
    // The EFFECT side of `long`. The caller side is lifted at compose time (so
    // testCell gets it too); this is the same declaration reaching the effect
    // tracker's abandon-the-effect deadline, from the same list. Two ceilings
    // resolved from one source — the trap the `effectTimeoutMs` unification
    // already fixed once, and a per-method flag that lifted only ONE of them
    // would have re-opened.
    perfBudget: mergeLongIntoPerfBudget(fc.perfBudget, composed.cells),
    reduce: ((state: unknown, action: unknown) =>
      inAppScope(
        scope,
        () =>
          (composed.reduce as (s: unknown, a: unknown) => unknown)(
            state,
            action,
          ),
      )) as AioConfig<
        Record<string, unknown>,
        unknown,
        unknown
      >["reduce"],
    execute:
      ((app: AioApp<Record<string, unknown>, unknown>, effect: unknown) =>
        inAppScope(scope, () =>
          composed.execute(
            {
              dispatch: (a) => app.dispatch(a),
              getState: () => app.getState(),
            },
            effect as { type: string; payload: unknown },
          ))) as AioConfig<Record<string, unknown>, unknown, unknown>[
          "execute"
        ],
    beforeReduce: ((action, state, user) => {
      // The drain that called this reports a THROWING reduce itself, after
      // `reduce` has returned — outside the scope `reduce` runs in. So the
      // drain is marked as this app's for the rest of its synchronous run.
      // A drain reached through a cell method is already inside that
      // method's `run` scope (see bindCell below), which contains this; one
      // reached from a socket marks that socket handler's turn, which is this
      // app's own server.
      if (scope) _appScope.enterWith(scope);
      return inAppScope(scope, () => {
        const type = (action as { type: string }).type ?? "unknown";
        if (type === WORKER_PATCH_ACTION) {
          const cell = (action as { payload?: { cell?: unknown } }).payload
            ?.cell;
          workerStorm?.track(`${String(cell)}:__worker`);
        } else if (storm && !storm.track(type)) {
          return null; // breaker active — drop mid-storm dispatches
        }
        return userBeforeReduce
          ? userBeforeReduce(action, state, user)
          : action;
      });
    }) as AioConfig<
      Record<string, unknown>,
      unknown,
      unknown
    >["beforeReduce"],
    onAction: logger
      ? ((action, state, user) =>
        inAppScope(scope, () => {
          logger.observe(
            action as { type: string; payload?: unknown },
            state as Record<string, unknown>,
          );
          // RETURNED, not dropped: an async hook's rejection is guarded at
          // the dispatch call site, which can only guard what reaches it.
          return fc.onAction?.(action, state, user);
        })) as AioConfig<Record<string, unknown>, unknown, unknown>["onAction"]
      : fc.onAction as AioConfig<
        Record<string, unknown>,
        unknown,
        unknown
      >["onAction"],
    onStart:
      ((app: AioApp<Record<string, unknown>, unknown>) =>
        inAppScope(scope, () => {
          // Up: from here on only this app's own stop detaches its logger.
          if (logger) markAppLoggerUp(logger);
          const initApp = {
            dispatch: (a: Parameters<typeof app.dispatch>[0]) =>
              app.dispatch(a),
            getState: () => app.getState(),
          };
          // Optional on the interface (the surface is frozen, so it could not be
          // required), always present from `composeCells`. A producer without it
          // keeps the old behaviour rather than silently initialising nothing.
          // Marked while the `__init`s run, so a method called from a hook
          // or an onInit in this window is told it came too early — not to
          // list a cell the app already lists (cell-catalog.ts).
          _whileCellsBoot(composed.cells, () => {
            if (composed.initAllExcept) {
              composed.initAllExcept(initApp, _ownedByWorker);
            } else composed.initAll(initApp);
          });
          // What the app LISTENS on (aio.ts `_listening`), not `app.port`: a
          // zero-port app keeps a number there it never bound, and this line
          // printed it — `started port=49725` for a socket-only app.
          const on =
            (app as { _listening?: { port?: number; socketPath?: string } })
              ._listening;
          if (logger && on?.socketPath) {
            _setStartSocket(logger, on.socketPath);
          }
          logger?.onStart(composed.cellNames, on ? on.port : app.port);
          // AIO-418: user `onStart` is fired by the cells runner AFTER
          // wrapAppWithCells() binds the callable method surface — NOT here. Calling
          // e.g. `members.seed()` in onStart threw ("cell runtime not booted")
          // because the method binding happened after this hook. See aio.ts.
        })) as AioConfig<Record<string, unknown>, unknown, unknown>["onStart"],
    // Phase 0 — before dispatch closes. Nothing of the framework's belongs
    // here: the bridge's own teardown (logger flush, cell destroy) is
    // after-the-fact work and stays in `onStop`. This is the app quiescing
    // its own producers, so it is a straight pass-through.
    onStopping: fc.onStopping,
    onStop: () =>
      inAppScope(scope, async () => {
        // THE APP'S HOOK RUNS BEFORE THE LOGGER IS TORN DOWN.
        //
        // It used to run LAST — after `setLogger(null)` — so every `log.*` an
        // app made from its own `onStop` went nowhere. "Wipe secrets on the way
        // out" and "say what was cleaned up" are the two things people do in
        // this hook, and the second was silent: no line, no warning, no error.
        // The comment below even describes a hook that "logged its first line
        // and never its last", which by then could not happen at all, because
        // there was nothing left to log to.
        //
        // AWAITED. The orchestrator budgets this phase (5 s teardown) precisely
        // so arbitrary app code can finish; calling the hook without awaiting it
        // resolved the phase the moment the hook STARTED, and an async `onStop`
        // — a flush to a remote, a handle to close, a child to wait for — was
        // abandoned ~ms before `Deno.exit`. Measured: a 4.5 s hook logged its
        // first line and never its last, on every `am stop`.
        // Cells first, exactly where they were: a cell's `onDestroy` runs BEFORE
        // the app's `onStop`, and `tests/beta-promise.test.ts` pins that order.
        // Fixing the logger needed ONE thing moved, not two — the first attempt
        // moved this too and silently reordered a lifecycle an app can observe.
        if (appRef.current) {
          const stopApp = {
            dispatch: (a: Parameters<typeof appRef.current.dispatch>[0]) =>
              appRef.current!.dispatch(a),
            getState: () => appRef.current!.getState(),
          };
          if (composed.destroyAllExcept) {
            composed.destroyAllExcept(stopApp, _ownedByWorker);
          } else composed.destroyAll(stopApp);
        }
        try {
          if (fc.onStop) await fc.onStop();
        } finally {
          // ALWAYS — a hook that throws (a dispatch from `onStop` is refused,
          // and an app that awaits it throws) used to skip everything below:
          // the heartbeat interval stayed armed and the "stopped" line was
          // never written, so the one shutdown that had something to report
          // was the one that kept the process alive and said nothing.
          logger?.onStop();
          // Drain in-flight writes before clearing the singleton. Without this,
          // the final "stopped" entry + any late error logs race the process
          // exit and can be lost (F-3).
          await logger?.flush();
          // THIS app's logger, and only it. `setLogger(null)` emptied the one
          // process-wide slot, so closing app B left a still-running app A
          // logging to nothing ("reportError failed" on its next error).
          if (logger) releaseAppLogger(logger);
        }
      }),
    onRestore: onRestore as AioConfig<
      Record<string, unknown>,
      unknown,
      unknown
    >["onRestore"],
    _getUIState: autoGetUIState as AioConfig<
      Record<string, unknown>,
      unknown,
      unknown
    >["_getUIState"],
    _getDBState: autoGetDBState as AioConfig<
      Record<string, unknown>,
      unknown,
      unknown
    >["_getDBState"],
    _cellPatchStrategies: cellPatchStrategies,
    _cellFilterFields: cellFilterFieldsMap,
    // AUTH-1: cell → declarative network-access rule (absent = open).
    _cellAccess: new Map(
      composed.cells
        .filter((c) => c.__aio.access !== undefined)
        .map((c) => [c.__aio.id, c.__aio.access!]),
    ),
    // Cell id → public method names — trojan `cells` route (amui run-method
    // buttons). Internal keys (__set* reducer synonyms, __error, __effects) are
    // dropped: they're framework plumbing, not user-dispatchable actions.
    _cellMethods: Object.fromEntries(
      composed.cells.map((
        c,
      ) => [c.__aio.id, c.__aio.actionKeys.filter((k) => !k.startsWith("__"))]),
    ),
    // Cell id → the ASYNC subset. A correlation id (`_callId`) is settled by
    // the async executor; on a sync method the reducer resolves it as
    // "blocked". The trojan needs the split to correlate only what can answer.
    _cellAsyncMethods: Object.fromEntries(
      composed.cells.map((
        c,
      ) => [c.__aio.id, [...(c.__aio.asyncMethods ?? [])]]),
    ),
    // Cell id → method name → REQUIRED argument count. A short call (`am
    // dispatch todo:add` with no text) reached the method as
    // `add(s, undefined)` and wrote a row whose declared field was gone, under
    // a green `{"ok":true}`; the trojan refuses it by name now, the way it
    // already refuses an unknown method. Empty for actions-form cells, where a
    // positional count is not the calling convention.
    _cellMethodArity: Object.fromEntries(
      composed.cells.map((c) => [c.__aio.id, c.__aio.methodArity ?? {}]),
    ),
    // Cell id → per-field { persisted, ui } flags — trojan `fields` route (amui
    // State overview). Answers "what survives a restart" (persist) and "what
    // ships to the browser" (ui) for every top-level state key.
    // Cell id → the persist filter itself, resolved exactly as the store's
    // getter resolves it (aio-composition.ts buildDBStateGetter), so journal
    // replay reads nested excludes the way the snapshot writes them.
    _cellPersist: Object.fromEntries(
      composed.cells.map((c) => [c.__aio.id, persistFilterOf(c)]),
    ),
    // Cells whose `onPersist` SHAPES the stored slice — a shape names no fields,
    // so journal replay round-trips these through the store instead.
    _cellPersistShaped: composed.cells
      .filter((c) => c.__aio.persistTransform && persisting.has(c.__aio.id))
      .map((c) => c.__aio.id),
    // Cell id → the `visible` filter a door that screens VALUES with NO CLIENT
    // in hand must apply. The flags below flatten a dot path to its top-level
    // key (all the `fields` overview needs), so the bug report takes this one
    // and runs it through `applyCellFieldFilter`.
    //
    // A per-user cell (`visible: { forUser }`) reduces to an EMPTY ALLOWLIST,
    // and that is the whole point of computing this here rather than at each
    // door: such a cell is screened TWICE on the wire — the structural filter,
    // then a callback run once per client (`decideForUser`) — and the second
    // screen has no answer without a client. Handing out the structural filter
    // alone put every user's rows in the file `feedback:` writes and POSTs.
    // This is a SCREEN, not a description: what such a cell really declares is
    // in the startup visibility report (`buildVisibilityReport`, which prints
    // `forUser`), because no single filter describes a per-client callback.
    _cellVisible: Object.fromEntries(
      composed.cells
        .filter((c) => c.__aio.ui !== undefined || c.__aio.uiForUser)
        .map((
          c,
        ) => [c.__aio.id, c.__aio.uiForUser ? { include: [] } : c.__aio.ui!]),
    ),
    _cellFields: Object.fromEntries(
      composed.cells.map((c) => [
        c.__aio.id,
        Object.fromEntries(
          Object.keys(c.__aio.state ?? {}).map((k) => [k, {
            persisted: fieldIncluded(k, c.__aio.persist),
            ui: fieldIncluded(k, c.__aio.ui),
          }]),
        ),
      ]),
    ),
    _onScheduleReady: (cancelByPrefix) =>
      composed.registry.setOnDisable(cancelByPrefix),
    _onReportOptsReady: (opts) => {
      _cellReportOpts.logger = opts.logger;
      _cellReportOpts.tt = opts.tt;
      _cellReportOpts.prod = opts.prod;
    },
    _diagnostics: fc.diagnostics,
    _onCheckpointRestore: fc.onCheckpointRestore,
    _cellNames: composed.cellNames,
    _pluginNames: fc._pluginNames,
    // The defs of cells flagged `worker: true` — _run spawns one Deno worker
    // each and routes their actions off the main dispatch queue.
    _workerCells: workerCells,
    // …and the flag those workers need to answer a refusal the way the main
    // isolate does. Same value the composed reduce was given.
    _refusalsReject: fc.refusalsReject === true,
    // …and the circuit breaker, which lives HERE: a worker cell's method never
    // runs in this composition, so its failures are counted by the pool, and a
    // cell the breaker disabled is not routed to its worker at all.
    _cellBreaker: {
      count: (cell: string) => _countCellError(composed, cell),
      // …and a routed call is the cell's last action, as the reduce records
      // it for a local one (`health()[i].lastAction`).
      note: (cell: string, type: string) =>
        _noteCellAction(composed, cell, type),
      isEnabled: (cell: string) => composed.registry.isEnabled(cell),
      // …and `disable`/`enable` of a worker cell run its lifecycle there.
      bindWorkers: (remote) => _setRemoteLifecycle(composed, remote),
    },
    _reduceBreakdown: composed.lastBreakdown,
    // The full rows, per app. `/__aio/health` and the vitals probe used to read
    // them off `globalThis.__aioCells` — the LAST app booted in the process —
    // so with two apps in one process (an embedding host, two `testServer`s)
    // the first app's health endpoint listed the second app's cells.
    _cellHealth: (state) => composed.registry.health(state),
    _healthGetter: (state: unknown) => {
      const health = composed.registry.health(
        state as Record<string, unknown>,
      );
      const result: Record<string, { errors: number; enabled: boolean }> = {};
      for (const h of health) {
        result[h.name] = { errors: h.errors, enabled: h.enabled };
      }
      return result;
    },
    _syncCellIds: composed.cells
      .filter((f) => f.__aio.syncConfig)
      .map((f) => f.__aio.id),
    // How long a client may hold an unacked op for this cell. The SERVER
    // needs it: compaction deletes op rows and tombstones their ids so the
    // `INSERT OR IGNORE` dedup survives, and it swept those tombstones on a
    // fixed 24h — justified by a comment claiming client-side eviction made
    // older resends impossible. It does not (that eviction only runs when the
    // buffer is at `pendingCap`), and `offline.retention` is per-cell with
    // `"7d"` as the docs' own example. A resend after the sweep is a
    // server-side DOUBLE APPLY. One declaration, both ends.
    _syncRetentionMs: (() => {
      const out: Record<string, number> = {};
      for (const f of composed.cells) {
        const r = f.__aio.syncConfig?.offline?.retention;
        if (r) out[f.__aio.id] = parseRetention(r);
      }
      return out;
    })(),
    // Everything that is not explicitly `persist: "none"` reaches the store.
    _persistingCellIds: [...persisting],
    _cellMigrations: (() => {
      const m = new Map<
        string,
        {
          version: number;
          initialState: Record<string, unknown>;
          onMigrate?: (
            state: Record<string, unknown>,
            fromVersion: number,
          ) => Record<string, unknown>;
        }
      >();
      for (const f of composed.cells) {
        if (f.__aio.version > 0 || f.__aio.onMigrate) {
          m.set(f.__aio.id, {
            version: f.__aio.version,
            initialState: f.__aio.state,
            onMigrate: f.__aio.onMigrate,
          });
        }
      }
      return m.size > 0 ? m : undefined;
    })(),
    // Per-cell boot repair. Collected like `_cellMigrations`, and applied at
    // the same point in boot — see aio-boot step 5.
    _cellRestores: (() => {
      const m = new Map<
        string,
        (state: Record<string, unknown>) => Record<string, unknown> | void
      >();
      for (const f of composed.cells) {
        if (f.__aio.onRestore) m.set(f.__aio.id, f.__aio.onRestore);
      }
      return m.size > 0 ? m : undefined;
    })(),
    // What each cell `listensTo` — the upgrade replay names a sync cell whose
    // reactions to a store-persisted cell no record held (aio-boot.ts).
    _cellForeignActions: (() => {
      const m: Record<string, string[]> = {};
      for (const f of composed.cells) {
        if (f.__aio.foreignActions.length > 0) {
          m[f.__aio.id] = [...f.__aio.foreignActions];
        }
      }
      return m;
    })(),
    _cellVersions: (() => {
      const v: Record<string, number> = {};
      let any = false;
      for (const f of composed.cells) {
        if (f.__aio.version > 0) {
          v[f.__aio.id] = f.__aio.version;
          any = true;
        }
      }
      return any ? v : undefined;
    })(),
  };
}

/** Each app's logger, by the config object it booted from — `initLogger` and
 *  `wrapAppWithCells` receive the same `fc`, and the second needs the first's
 *  answer to scope the cell methods it binds. */
const _loggerOf = new WeakMap<CellsConfig, AioLogger>();

/** Initialize structured logger from CellsConfig */
export async function initLogger(
  fc: CellsConfig,
  /** The persist decider's answer (`persistingCellIds`) and every declared
   *  cell: a cell outside it is `persist: "none"`, and debug.log keeps its
   *  actions' arguments — which ARE its state — out, like every other sink
   *  that retains payloads on disk. */
  persist?: { persisting: ReadonlySet<string>; cells: readonly string[] },
): Promise<AioLogger | null> {
  const appId = resolveAppId(fc.appId);
  // Tri-state on purpose: the flag used to be spread only when TRUTHY, which
  // was harmless while `false` was the default and silently unusable the moment
  // it stopped being — `--no-backup-logs` would have parsed and done nothing.
  const { backupLogs: cliBackup, logBudget: cliBudget } = parseCli();
  const logCfg = fc.logging === false
    ? null
    : (fc.logging === true || fc.logging === undefined ? {} : fc.logging);
  // Logs are tier ② — regenerable, excluded from a backup — but they live in the
  // app's own directory so there is ONE place to look for everything an app
  // writes (`~/.<appId>/logs`, was `./.aio/log` relative to cwd, which meant a
  // service started from `/` wrote to `/.aio/log`). An explicit `logging.dir`
  // still wins.
  const dirs = appDirs(appId, fc.appDir);
  const logger = logCfg
    ? new AioLogger({
      dir: dirs.logs,
      ...logCfg,
      ...(cliBackup !== undefined ? { backupLogs: cliBackup } : {}),
      ...(cliBudget !== undefined ? { logBudget: cliBudget } : {}),
      appName: appId,
      // `debug.log` retains action payloads on disk, so it obeys the SAME
      // `redactActions` list as the journal, the timeline, the action log and
      // the checkpoint. It was the one sink that never saw the list, and it
      // wrote a redacted method's arguments — and the diff values it produced —
      // in cleartext (`docs/persistence/where-files-live.md` promises they are
      // kept nowhere).
      // …and a `persist: "none"` cell is withheld whole (a bare cell name):
      // at `level: "debug"` its method's arguments reached debug.log in
      // cleartext.
      redact: makeRedactor([
        ...(fc.redactActions ?? []),
        ...(persist?.cells.filter((c) => !persist.persisting.has(c)) ?? []),
      ]),
    })
    : null;
  // Do NOT rotate the logs of an app that is already running. `logger.init()`
  // happens long before `acquireSingletonLock`, so a start that was about to
  // be REFUSED ("Already running", or a taken port) renamed the LIVE
  // instance's `app.log` to `app.log.1` and exited — the running process kept
  // appending to the renamed inode, and `am logs` then answered "no log file
  // at …/stdout.log" for a perfectly healthy app. Same bug as the one already
  // closed for `--help`/`--version`; the common case was left in.
  //
  // Read, never acquire: this is only "is someone else there", and the real
  // decision still belongs to `acquireSingletonLock`.
  if (logger) {
    const held = readLock(lockKey(appId, dirs.home, registeredProfile(appId)));
    const live = held !== null && isLockOwnerAlive(held) &&
      held.pid !== Deno.pid;
    await logger.init({ rotate: !live });
  }
  // Installed, not "set": another app in this process keeps its own.
  if (logger) {
    installAppLogger(logger);
    _loggerOf.set(fc, logger);
  }
  // The boot running this is the app's scope: from here its lines — and those
  // of every timer and handler its boot already started — are its logger's.
  const scope = _appScope.getStore();
  if (scope) {
    if (logger) scope.logger = logger;
    _scopeOf.set(fc, scope);
  }
  return logger;
}

/** Wrap app with memory monitor, cells API, and bindCell — post-_run() setup */
export async function wrapAppWithCells(
  app: AioApp<Record<string, unknown>, unknown>,
  composed: ComposedCells,
  fc: CellsConfig,
  _cellReportOpts: ReportErrorOpts,
): Promise<void> {
  // Initialize memory pressure monitor
  let _heapLimit = 0;
  try {
    const v8 = await import("node:v8");
    _heapLimit = (v8.getHeapStatistics() as { heap_size_limit: number })
      .heap_size_limit;
  } catch { /* node:v8 unavailable — fall back to heapTotal in monitor */ }

  // `diagnostics.{dev,prod}.memoryMonitor` is DECLARED, defaulted (`false` in
  // prod), snapshotted in the public API — and was read by nobody: `grep -rn
  // "\.memoryMonitor" src/` found zero consumers, so the monitor ran every
  // 10 s in production, doing a full recursive `sizeof()` over all cell state,
  // while the documented default said it was off. Third instance of a class
  // this repo has already fixed twice (`timeTravel`, `vitals.backpressure`);
  // `check:dead-wiring` cannot see it because it scans exports, not config
  // keys. Both switches now have to agree — the diagnostics option says
  // whether the FEATURE is on, `memory.enabled` is the app's own override.
  const _diagOpts = resolveOptions(
    fc.diagnostics ?? true,
    _cellReportOpts.prod === true,
  );
  const _memoryOpt = _diagOpts === false ? false : _diagOpts.memoryMonitor;
  const _memoryCfg = typeof _memoryOpt === "object" ? _memoryOpt : undefined;
  const memoryMonitor = createMemoryMonitor({
    enabled: _memoryOpt !== false && (fc.memory?.enabled ?? true),
    interval: fc.memory?.interval ?? _memoryCfg?.interval ?? 10_000,
    warnThreshold: fc.memory?.warnThreshold ?? _memoryCfg?.warnThreshold ??
      0.75,
    criticalThreshold: fc.memory?.criticalThreshold ??
      _memoryCfg?.criticalThreshold ?? 0.90,
    onReport: (report) => {
      const code = report.level === "critical"
        ? "MEMORY_CRITICAL"
        : "MEMORY_PRESSURE";
      const topCell = report.cellStates[0];
      const err = createAioError(
        code as import("../diagnostics/error.ts").AioErrorCode,
        // A pressure alarm whose one number reads "0%" says nothing — the
        // same defect as the "unreachable for 0.0s" already fixed in vitals.
        `heap at ${
          report.heapPct < 0.01
            ? (report.heapPct * 100).toFixed(2)
            : (report.heapPct * 100).toFixed(0)
        }% (${(report.heapUsed / 1e6).toFixed(0)} MB / ${
          (report.heapLimit / 1e6).toFixed(0)
        } MB)`,
        { cellName: topCell?.name },
      );
      reportAioError(err, _cellReportOpts);
      fc.memory?.onMemoryPressure?.(report);
    },
    machineWarnFraction: fc.memory?.machineWarnFraction ?? 0.5,
    growthReportRatio: fc.memory?.growthReportRatio ?? 0.15,
    // Allowlisted and documented, and never passed on — it was always 10.
    trendWindow: fc.memory?.trendWindow,
    getMemoryUsage: () => Deno.memoryUsage(),
    getHeapLimit: () => _heapLimit,
    // The machine, not just the ceiling: 75%-of-a-47 GB-ceiling is 35 GB, and a
    // desktop is long gone by then. Without this denominator the monitor can
    // only ever warn about the app's health, never the machine's.
    getTotalMemory: () => physicalMemoryBytes() ?? 0,
    getCellStates: () => {
      const fullState = app.getState() as Record<string, unknown>;
      return composed.cells.map((f) => ({
        name: f.__aio.id,
        state: fullState[f.__aio.id],
      }));
    },
  });

  // Wrap close to also stop memory monitor
  // …and to end the app's scope once it is fully down (see `liveScope`).
  // Serving from here: a namespace every app serves is named once two are up.
  const leaveServerFns = _serverFnsAppLive(resolveAppId(fc.appId));
  // THIS app's scope, taken now: `fc` is the caller's object, and a later
  // `aio.run(fc)` with the same one re-keys `_scopeOf` to ITS scope — a second
  // (idempotent) close of this app then ended the NEXT app's scope.
  const ownScope = _scopeOf.get(fc);
  const origClose = app.close;
  (app as Record<string, unknown>).close = async () => {
    memoryMonitor.stop();
    try {
      await origClose();
    } finally {
      leaveServerFns();
      if (ownScope) ownScope.closed = true;
    }
  };

  // Attach cells API to app
  const cellsApi = {
    enable: (name: string) =>
      composed.registry.enable(name, {
        dispatch: (a) => app.dispatch(a),
        getState: () => app.getState(),
      }),
    disable: (name: string) =>
      composed.registry.disable(name, {
        dispatch: (a) => app.dispatch(a),
        getState: () => app.getState(),
      }),
    status: (name: string) =>
      composed.registry.status(
        name,
        app.getState() as Record<string, unknown>,
      ),
    health: () =>
      composed.registry.health(app.getState() as Record<string, unknown>),
    list: () => composed.cellNames,
  };
  (app as Record<string, unknown>).cells = cellsApi;

  // Bind cells — enables todo.add('milk') syntax (dispatch + selector binding)
  // …each call scoped to THIS app's logger, and contained: the dispatch it
  // starts (and whatever that drain reports) is this app's, and the caller's
  // own scope is back when it returns — a method of app A that calls a cell
  // of app B still logs as A afterwards.
  const logger = _loggerOf.get(fc) ?? null;
  const scope = scopeOf(fc, logger);
  /** The dispatch each of OUR cells is bound to — "is it still ours?" at
   *  release (see `_boundDispatchOf`). */
  const ours = new Map<CellDef, unknown>();
  for (const f of composed.cells) {
    const dispatch = (a: Parameters<typeof app.dispatch>[0]) =>
      inAppScope(scope, () => app.dispatch(a));
    // …and a call's ceiling is this app's, whoever calls (see `_bindCallScope`).
    if (scope) _bindCallScope(dispatch, scope);
    bindCell(
      f,
      dispatch,
      () => app.getState() as Record<string, unknown>,
    );
    ours.set(f, _boundDispatchOf(f));
  }
  // …and record how to give them back. A cell def binds to exactly one app, and
  // that claim used to outlive the app: a second `testServer()` in the same file
  // failed with "already bound" even after `await using` closed the first
  //. Shutdown calls this — after the final persist and the worker pool's
  // close — with each closed worker cell's reason; scoped to OUR cells, so a
  // second app in the same process keeps its own bindings.
  (app as Record<string, unknown>)._releaseCells = (
    closedWorkers: Record<string, string | null> = {},
  ) => {
    // Only cells STILL bound to this app: a harness reset (`_resetCellBindings`)
    // lets another app re-bind one while this app lives, and releasing it
    // here broke THAT app's live cell (DISPATCH_CLOSED for good).
    const mine = composed.cells.filter((f) =>
      _boundDispatchOf(f) === ours.get(f)
    );
    _releaseCellBindings(mine, composed.appId);
    // …and let go of the APP. A cell def is a module object that outlives
    // every app it serves (and `cell()` registers it process-wide), so the
    // dispatch/getState closures bound above kept the closed app — its state,
    // its config, its scope and logger — reachable for the life of the
    // process: 0 of N closed apps were ever collected. The def is re-bound to
    // a tombstone that answers every call shape exactly as the closed app did
    // — its FINAL state (frozen plain data, read now: dispatch is sealed), the
    // main loop's DISPATCH_CLOSED, a closed worker's refusal by name — and
    // holds nothing else of it. `bound` stays false: the next app binds as
    // before. Built at MODULE level on purpose: a closure made in here would
    // carry this function's context chain, i.e. the app's config, right back.
    const finalState = app.getState() as Record<string, unknown>;
    _tombstoneCells(mine, finalState, closedWorkers);
  };
}

/** Re-bind closed cells to a tombstone that holds nothing of their app — see
 *  `_releaseCells`. Module level so no closure here can reach an app's scope
 *  through its context chain; everything it keeps is plain data. Each shape
 *  answers as the closed app's own door did: a worker cell as its closed
 *  worker (`closedWorkerCall`), any other as the sealed main loop
 *  (dispatch.ts — the same warning, once per type, and DISPATCH_CLOSED). */
function _tombstoneCells(
  cells: readonly CellDef[],
  finalState: Record<string, unknown>,
  closedWorkers: Readonly<Record<string, string | null>>,
): void {
  if (cells.length === 0) return;
  const warned = new Set<string>();
  let dropped = 0;
  const sealed = (a: Msg): Promise<unknown> => {
    const t = String(a?.type ?? "(unknown)");
    dropped++;
    if (!warned.has(t)) {
      warned.add(t);
      log.warn(
        `dispatch after close() — '${t}' ignored (further drops of this ` +
          `type suppressed; ${dropped} dropped so far)`,
      );
    }
    const p = Promise.reject(createAioError(
      "DISPATCH_CLOSED",
      "dispatch after close() — action dropped, not applied",
      { actionType: a?.type as string },
    ));
    p.catch(() => {
      // aio-ok: marks it handled only — the caller still receives the
      // rejection, and the drop was warned above; a fire-and-forget call must
      // not crash the process with an unhandled rejection.
    });
    return p;
  };
  const getState = () => finalState;
  for (const f of cells) {
    const id = f.__aio.id;
    // Own keys only: a cell named `constructor` is not a worker.
    const crash = Object.hasOwn(closedWorkers, id)
      ? closedWorkers[id]
      : undefined;
    bindCell(
      f,
      crash === undefined ? sealed : (a) => closedWorkerCall(id, crash, a),
      getState,
    );
    (f.__aio as Record<string, unknown>).bound = false;
  }
}

/** Filter cell entries by --isolate flag */
export function filterCellsByIsolate(
  cellEntries: NonNullable<CellsConfig["cells"]>,
  isolate: string[] | undefined,
): NonNullable<CellsConfig["cells"]> {
  if (!isolate || isolate.length === 0) return cellEntries;
  const idOf = (entry: (typeof cellEntries)[number]): string =>
    ("__aio" in entry ? entry as CellDef : (entry as { cell: CellDef }).cell)
      .__aio.id;
  const ids = cellEntries.map(idOf);
  // A name that matches no cell is REFUSED, dev and prod. `--isolate=setings`
  // used to warn "no cells matched — check spelling" and boot ZERO cells —
  // then the shape-drift check, seeing every persisted key undeclared,
  // blamed the SCHEMA; and `--isolate=todo,setings` silently booted `todo`
  // alone. Same class as an unknown flag or config key: a name aio cannot
  // act on gets a did-you-mean, not a default.
  const unknown = [...new Set(isolate)].filter((n) => !ids.includes(n));
  if (unknown.length > 0) {
    const near = unknown
      .map((n) => [n, nearestOf(n, ids)] as const)
      .filter((p): p is readonly [string, string] => p[1] !== null)
      .map(([n, m]) => `${n} → ${m}`);
    throw teachableError(
      `isolate names ${
        unknown.length === 1
          ? "a cell this app does not have"
          : "cells this app does not have"
      }: ${unknown.join(", ")}`,
      (near.length ? `did you mean ${near.join(", ")}? ` : "") +
        `The cells here are: ${ids.join(", ")} (--isolate=a,b or ` +
        `aio.run({ isolate: [...] }) picks from these).`,
    );
  }
  const isolateSet = new Set(isolate);
  const filtered = cellEntries.filter((entry) => isolateSet.has(idOf(entry)));
  log.info(`isolate: ${filtered.map(idOf).join(", ")}`);
  return filtered;
}
