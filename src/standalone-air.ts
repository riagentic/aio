// Standalone AIR runtime — signal-based client-side dispatch loop for Android WebView builds
// Replaces standalone.ts when building with --android + renderer: "aio". Same API, no React.
import { type Draft, produce } from "immer";
import { msg } from "./state/msg.ts";
import type { Msg } from "./state/cell-types.ts";
import { deepMerge } from "./state/deep-merge.ts";
import {
  createDispatch,
  type PerfBudget,
  type PerfCheck,
} from "./state/dispatch.ts";
import {
  createAioError,
  reportError as reportAioError,
  type ReportErrorOpts,
} from "./diagnostics/error.ts";
import type { AioApp } from "./server/aio.ts";
import {
  createScheduleManager,
  createVirtualTimers,
  type ScheduleEffect,
} from "./state/schedule.ts";
import { log } from "./diagnostics/logger-api.ts";
import { createOwnManager, type OwnEffect } from "./state/own.ts";
import { routeEffect } from "./state/route-effect.ts";
import { Listeners } from "./state/listeners.ts";
import { signal } from "./state/signal.ts";
import { type ComponentFn, h } from "./air/vdom.ts";
import { bindCell, bindCellReactive, type CellDef } from "./state/cell.ts";
import { composeCells } from "./state/cell-compose.ts";
import {
  _resetCellBindings,
  _resetCellRegistry,
  getRegisteredCells,
} from "./state/cell-reactive.ts";
import {
  _applyFullState,
  _resetSignals,
  getReadySignal,
} from "./state/state-signals.ts";
import {
  abortAllInflight,
  DRAIN_TIMEOUT_MS,
  endShutdownAbort,
  settlePending,
} from "./state/method-cancel.ts";

// Re-exports for user code
export { msg };

// ── The `aio/air` surface, on the android target ──────────────────────
//
// The android bundle maps BOTH "aio" and "aio/air" to this module
// (src/build/build-bundle.ts), so everything an app imports from `aio/air` has
// to be visible here — and has to be THE SAME symbol, never a second copy with
// a narrower contract. It used to be a handful of lifecycle hooks plus a
// private `useLocal` that lacked the documented tuple form and patch(): an app
// written to the docs built green for browser and electron and threw
// `useLocal(...) is not iterable` on android alone. tests/android-air-surface.
// test.ts pins the parity and enumerates what android deliberately omits
// (server transport, auth UI, the browser-history router, SSR/islands,
// devtools) — none of which exist in a standalone app.
//
// Everything below is renderer/signal code with no transport dependency, so
// re-exporting it costs the bundle nothing it does not use (esbuild tree-shakes
// from the app entry).
export {
  afterRender,
  type Context,
  createContext,
  hydrate,
  mount,
  type MountHandle,
  onCleanup,
  // Every target ships the SAME global-key binding: a shortcut that works on
  // desktop and silently does nothing on android is the twin hazard this file
  // already carries two notes about (useLocal, useAio).
  onGlobalKey,
  onMount,
  // aio-renderer's setDevMode is the one `aio/air` exports — it turns on the
  // renderer's dev checks AND forwards to vdom's flag.
  setDevMode,
  useContext,
  useContextSelector,
  useId,
  useOptimistic,
  useRef,
  useSignal,
} from "./air/aio-renderer.ts";
export {
  type Action,
  type ComponentFn,
  ErrorBoundary,
  Fragment,
  h,
  lazy,
  type NodeAction,
  Portal,
  type Ref,
  renderToString,
  Suspense,
  type VChild,
  type VNode,
} from "./air/vdom.ts";
export {
  batch,
  type Computed,
  computed,
  effect,
  type Signal,
  signal,
  untrack,
} from "./state/signal.ts";
// `log` — the same call an app makes on the server.
//
// A standalone/Android bundle is still the whole app: it holds the cells, the
// network code and the session logic, and every one of those has something
// worth saying when it goes wrong. `aio` and the browser build both export
// this; without it here, `import { log } from "aio"` — code that compiled on
// three platforms — fails to BUNDLE for the fourth, with an esbuild error that
// names the framework's internal module rather than the app's own import.
// The implementation is already used above; only the export was missing.
export { log } from "./diagnostics/logger-api.ts";
export type { Log } from "./diagnostics/logger-api.ts";

// The rest of the `aio` surface an app uses INSIDE a method, none of which
// needs a server — and every one of which failed to BUNDLE for android, with
// an esbuild error naming a framework internal, because this entry never
// re-exported them. `until` and `race` appear in mod.ts's own header example,
// so the documented spelling of an async method did not build for a shipped
// target. Each module below is dependency-light and Deno-free (the gate in
// tests/bundle-load-time-throw.test.ts holds them to that).
export {
  race,
  sleep,
  until,
  UntilTimeoutError,
} from "./state/async-helpers.ts";
export type { UntilOptions } from "./state/async-helpers.ts";
export { own } from "./state/own.ts";
export type { OwnEffect } from "./state/own.ts";
export { self } from "./state/self.ts";
export { call } from "./state/cell-impl.ts";
export { bindCell, composeCells } from "./state/cell.ts";
export { createSelector } from "./selector.ts";
export { degraded, degradedReport } from "./diagnostics/degraded.ts";

export { Show } from "./air/show.ts";
export { on, watch } from "./state/watch.ts";
export type { WatchOptions } from "./state/watch.ts";
export { useFieldArray, useForm } from "./air/form.ts";
export type {
  FieldArrayState,
  FieldState,
  FormState,
  ValidationRule,
} from "./air/form.ts";
export { useVirtualList } from "./air/virtual-list.ts";
export type {
  VirtualListConfig,
  VirtualListState,
} from "./air/virtual-list.ts";
export {
  Transition,
  type TransitionProps,
} from "./air/transition-component.ts";
export {
  TransitionGroup,
  type TransitionGroupProps,
} from "./air/transition-group.ts";
export {
  fade,
  scale,
  slide,
  type TransitionFn,
  type TransitionOptions,
  type TransitionResult,
} from "./air/transition.ts";
export {
  type SpringConfig,
  type SpringValue,
  useSpring,
} from "./air/animation.ts";
export { Defer, type DeferProps, type DeferTrigger } from "./air/defer.ts";
export { type Resource, resource } from "./air/resource.ts";
export { type DimensionsState, useDimensions } from "./air/dimensions.ts";
export { useInterval, useRaf } from "./air/raf.ts";
/** Auto-memo is built into the renderer — `memo()` is the identity function on
 *  every target, and exists so React-shaped code compiles unchanged. */
export { memo } from "./air/memo.ts";
/** Client-only reactive state. ONE implementation, shared with every other
 *  target — `{ local, set, patch }` and the preferred tuple form
 *  `const [v, setV] = useLocal(init)`. */
export { useLocal, type UseLocalResult } from "./adapters/air.ts";

/** Extracts return types of all function members into a union */
export type UnionOf<T> = {
  // deno-lint-ignore no-explicit-any
  [K in keyof T]: T[K] extends (...args: any[]) => infer R ? R : never;
}[keyof T];

// WHY DUPLICATED: draft() is a copy of mod.ts draft(). standalone-air.ts can't import mod.ts
// because it IS the aio entrypoint for Android AIR builds (replaces browser-air.ts + mod.ts).
/** Immutable state update — mutate the draft, return effects */
export function draft<S, E>(
  state: S,
  fn: (d: Draft<S>) => E[],
): { state: S; effects: E[] } {
  let effects: E[] = [];
  const next = produce(state, (d) => {
    const result = fn(d);
    // Clone inside produce() while draft is still alive — after produce()
    // returns, Immer revokes draft proxies making state refs unreadable.
    effects = result.length ? structuredClone(result) : result;
  });
  return { state: next, effects };
}

// ── Internal state (singleton) ──

const _listeners = new Listeners<unknown>();
let _state: unknown = null;
/** THIS runtime's cell names — late-bound by `bootStandalone`, exactly like the
 *  server's `getCellNames`. `close()` aborts and waits for ITS OWN cells: the
 *  in-process harnesses can hold a server app in the same process, and one
 *  runtime shutting down must never cancel the other's methods mid-write.
 *  Undefined (a raw `initStandalone`, no cells) has nothing to scope. */
let _standaloneCells: Set<string> | undefined;
let _app: AioApp | null = null;

// Owned resources (`own.set`) acquired in this runtime. Lazily created so the
// module stays side-effect-free, and disposed by _resetState() so a test that
// boots cells and disposes the handle leaves nothing running.
let _own: ReturnType<typeof createOwnManager> | null = null;
function _ownManager(): ReturnType<typeof createOwnManager> {
  if (!_own) _own = createOwnManager(log);
  return _own;
}

// ── Virtual-clock scheduler (test/standalone) ──────────────────────────
// The REAL `createScheduleManager`, driven by a virtual clock: firing on the
// wall clock would be non-deterministic and dropping the effects would be
// untestable (a field report), so the clock is swapped — and NOTHING ELSE is.
//
// It used to be a second, hand-written scheduler living right here, and every
// rule it did not re-implement became a rule tests could not see:
// `Math.max(1, ms)` where production THROWS below 1 (`after`) and below 10
// (`every`), no id validation, `skipIfRunning` ignored, `at`/`cron` dropped
// with a once-per-process console warn. An `every` with a 5ms period and a
// spaced id was green in the harness and refused twice over in production — a test
// environment more permissive than production, the one thing CLAUDE.md
// forbids outright ("tests are the STRICTEST environment").
//
// `_advanceSchedules(ms)` moves the virtual clock, so a test can still drive
// toast auto-dismiss, debounce, backoff and poll deterministically.
let _clock: ReturnType<typeof createVirtualTimers> | null = null;
let _sched: ReturnType<typeof createScheduleManager> | null = null;
/** Virtual time is a TEST affordance and must be opted into. This runtime is
 *  also the REAL Android standalone runtime: with a virtual clock as the
 *  default, nothing in a shipped APK ever advanced it, so every `after`,
 *  `every`, `at` and `cron` was registered and then silently never fired —
 *  a dead timer with no error anywhere. The harness opts in (below); an app
 *  gets the platform's timers. */
let _wantVirtual = false;

/** Test-only: use a virtual clock so `advance(ms)` drives schedules
 *  deterministically. MUST be called before the first schedule is registered
 *  — after that the manager exists and its timer host is fixed. */
export function _useVirtualSchedules(): void {
  _wantVirtual = true;
}

function _scheduler(): ReturnType<typeof createScheduleManager> {
  if (!_sched) {
    _clock = _wantVirtual ? createVirtualTimers() : null;
    _sched = createScheduleManager(
      // The manager AWAITS this to know when a tick settles (skipIfRunning)
      // and to see a rejection — so hand back the dispatch promise itself.
      (action) => Promise.resolve(_cellApp?.dispatch(action as Msg)),
      log,
      _clock ? { timers: _clock } : undefined,
    );
  }
  return _sched;
}

/** Advance the virtual clock by `ms`, firing every schedule that comes due —
 *  `after` once, `every`/`cron` re-arming, exactly as production would, with
 *  microtasks draining between fires the way a real turn of the loop does. */
export function _advanceSchedules(ms: number): Promise<void> {
  return _clock?.advance(ms) ?? Promise.resolve();
}

/** Reset the virtual clock + pending schedules (per-mount test isolation). */
export function _resetSchedules(): void {
  _sched?.cancelAll();
  _sched = null;
  _clock = null;
}

// Signal for AIR reactivity — updated on every state change
const _stateSignal = signal<unknown>(null);

/** Notifies all subscribers and updates signal */
function _notify(): void {
  _stateSignal.set(_state);
  _listeners.notify(_state);
}

// ── Standalone config ──

type StandaloneConfig<S, A, E> = {
  reduce: (
    state: S,
    action: A,
  ) => { state: S; effects: (E | ScheduleEffect | OwnEffect)[] };
  execute: (app: AioApp<S, A>, effect: E) => void;
  persist?: boolean;
  persistKey?: string;
  persistDebounceMs?: number;
  perfCheck?: PerfCheck;
  perfBudget?: PerfBudget;
  freezeState?: boolean;
  onRestore?: (state: S) => S;
  /** Fires after each committed state change (cell-based standalone uses it to
   *  push the new state into per-cell reactive signals). */
  onCommit?: (state: S) => void;
};

const STORAGE_KEY = "aio_state";

/** Initializes standalone runtime — call before AIR mounts */
export function initStandalone<S, A, E>(
  initialState: S,
  config: StandaloneConfig<S, A, E>,
): AioApp<S, A> {
  const { reduce, execute } = config;
  const shouldPersist = config.persist !== false;
  const getDBState = (s: S) => s;
  const getUIState = (s: S) => s;
  const persistKey = config.persistKey ?? STORAGE_KEY;

  // Restore from localStorage
  let state = initialState;
  if (shouldPersist) {
    try {
      const raw = localStorage.getItem(persistKey);
      if (raw) {
        const persisted = JSON.parse(raw);
        state = deepMerge(
          initialState as Record<string, unknown>,
          persisted as Record<string, unknown>,
        ) as S;
      }
    } catch (e) {
      console.warn("[aio] localStorage restore failed:", e);
    }
  }

  const _reportOpts: ReportErrorOpts = {
    onError: undefined,
    prod: true,
  };

  // onRestore — let user transform/validate restored state before UI renders
  if (config.onRestore) {
    try {
      state = config.onRestore(state);
    } catch (e) {
      const err = createAioError("HOOK_ERROR", e, { hookName: "onRestore" });
      reportAioError(err, _reportOpts);
    }
  }

  _state = getUIState(state);
  _stateSignal.set(_state);

  // Debounced localStorage persistence
  const persistMs = config.persistDebounceMs ?? 100;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  function schedulePersist(): void {
    if (!shouldPersist || persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      try {
        localStorage.setItem(persistKey, JSON.stringify(getDBState(state)));
      } catch (e) {
        console.warn("[aio] persist failed:", e);
      }
    }, persistMs);
  }

  function flushPersist(): void {
    if (!shouldPersist) return;
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    try {
      localStorage.setItem(persistKey, JSON.stringify(getDBState(state)));
    } catch (e) {
      console.warn("[aio] flush failed:", e);
    }
  }

  const standaloneLog = {
    debug: (_: string) => {},
    // The level is in the line, not only in the console method — this output
    // is read in a terminal transcript as often as in devtools.
    warn: (msg: string) => console.warn(`[aio] \u26a0 ${msg}`),
    error: (msg: string) => console.error(`[aio] \u2717 ${msg}`),
  };

  const dispatch = createDispatch<S, A, E>({
    reduce,
    execute: (effect) =>
      // ONE exhaustive classifier for all three effect runtimes — a new
      // framework effect kind is a compile error here (see route-effect.ts).
      routeEffect<E>(effect, {
        // Schedule effects: hold on the virtual clock so tests can fire them
        // deterministically with ui.advance(ms) / handle.advance(ms).
        schedule: (e) => _scheduler().handle(e),
        // Really acquire and dispose. Ignoring `own` here made the in-process
        // harnesses (testCell / testUI / bootCells) more permissive than
        // production — a leaked or misfiring resource could not surface in the
        // one place a test boots and disposes cells, converting a whole class
        // of bug into a production-only bug. Tests are the strictest
        // environment; a warning that says "ignored" is not strictness.
        own: (e) => _ownManager().handle(e),
        app: (e) => execute(app, e),
      }),
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {
      _state = getUIState(state);
      _notify();
      config.onCommit?.(state);
      schedulePersist();
    },
    log: standaloneLog,
    debug: false,
    reportOpts: _reportOpts,
    perfCheck: config.perfCheck,
    perfBudget: config.perfBudget,
    freezeState: config.freezeState ?? true,
  });

  const app: AioApp<S, A> = {
    dispatch,
    getState: () => state,
    // THE SAME four steps as `src/server/shutdown.ts` Phase 1, in the same
    // order, on the same budget: close the door, ABORT every in-flight async
    // method so a stream takes its own `s.$signal.aborted` path, WAIT for the
    // writes it makes on the way out, and only then write the snapshot.
    //
    // It used to close-and-flush in one breath, so the snapshot was the state
    // as of the instant close() was called and everything an in-flight method
    // still had to write rode on a debounce timer — in a process that is being
    // torn down. On Android close() IS the process ending, so that timer never
    // fires: the streamed reply was simply missing on the next launch, exactly
    // the report `tests/shutdown-inflight.test.ts` exists for. What close()
    // returns has to be what the next launch reads.
    close: async () => {
      dispatch.close();
      abortAllInflight(_standaloneCells);
      try {
        // ONE deadline for both waits — two budgets would double the time the
        // window takes to disappear.
        const deadline = Date.now() + DRAIN_TIMEOUT_MS;
        const left = () => Math.max(1, deadline - Date.now());
        const stuck = await settlePending(left(), _standaloneCells);
        if (stuck > 0) {
          standaloneLog.warn(
            `close: ${stuck} call(s) still running at the ` +
              `${DRAIN_TIMEOUT_MS}ms deadline (slow write, or an ignored ` +
              `abort signal) — their remaining writes are lost`,
          );
        }
        await dispatch.drain(left());
      } catch (e) {
        standaloneLog.error(`close: drain — ${e}`);
      } finally {
        // The drain is over: a later app in this process (every sequential
        // test) may legitimately reuse these cell names.
        endShutdownAbort(_standaloneCells);
      }
      flushPersist();
    },
    mode: "standalone",
  };

  // Test-harness seam: install a starting state before the first render, so a
  // test can pin the state a cell would otherwise get from the machine it runs
  // on (real telemetry, a device, the clock). Without it, a test of "what does
  // the UI do when there are two GPUs" either runs against whatever the
  // developer's box reports that second, or doesn't run — one field report
  // ended up asserting whichever branch the hardware chose. Not part of the app surface: `_seedState` is only reachable from the
  // harness, and it is a plain state install, not a dispatch, precisely because
  // it must look like "the app started this way".
  _seed = (partial: Record<string, unknown>): void => {
    const merged = { ...(state as Record<string, unknown>) };
    for (const [cellName, slice] of Object.entries(partial)) {
      merged[cellName] = {
        ...(merged[cellName] as Record<string, unknown> ?? {}),
        ...(slice as Record<string, unknown>),
      };
    }
    state = merged as S;
    _applyFullState(merged);
  };

  _app = app as AioApp;
  return app;
}

// ── AIR hooks (signal-based) ──

/** Connects to standalone dispatch loop. Signal-based — auto-tracked by AIR. */
export function useAio<S = unknown>(): {
  state: S | null;
  send: (action: { type: string; payload?: unknown }) => void;
  /** Has a full state frame landed? On this target the runtime IS local, so
   *  it is true from the first commit — but the flag has to EXIST, or a
   *  component written against `useAio().ready` renders a spinner forever on
   *  android alone. Same twin hazard the `useLocal` note below records. */
  ready: boolean;
} {
  const state = _stateSignal.value as S | null;

  const send = (action: { type: string; payload?: unknown }) => {
    if (_app) _app.dispatch(action);
    else {console.warn(
        "[aio] \u26a0 not initialized — call initStandalone() before rendering",
      );}
  };

  return {
    state,
    send,
    get ready(): boolean {
      return getReadySignal().value;
    },
  };
}

// `useLocal` used to be re-implemented here — see the re-export above. The copy
// was missing the documented tuple form and patch(), so android alone threw on
// the spelling docs call preferred.

/** Renders the component matching the current page key */
export function page<K extends string>(
  current: K,
  routes: Record<K, ComponentFn>,
): unknown {
  const Component = routes[current];
  return Component ? h(Component, null) : null;
}

/** Resets module state — for testing only */
/**
 * Reset runtime STATE only (keeps the cell registry) — for hermetic testUI
 * mounts. Nulls `_cellApp` so the next runStandalone() re-composes from the
 * cells' pristine declared initials, and resets signal VALUES in place (stable
 * identity, so reactive getter closures see the reset). This is what makes each
 * mount start clean without dropping the module-singleton cells themselves.
 */
export function _resetState(): void {
  // Destroy the booted cells FIRST, while the app and its signals are still
  // alive — onDestroy hooks may read state or dispatch (dispatch is
  // synchronous here, so everything commits before the teardown below).
  // Nulled before the call so a re-entrant reset cannot loop.
  const destroyCells = _destroyCells;
  _destroyCells = null;
  destroyCells?.();
  _state = null;
  _app = null;
  _cellApp = null;
  _standaloneCells = undefined;
  _stateSignal.set(null);
  _listeners.clear();
  _resetSignals();
  _resetCellBindings(); // release module-singleton cells so they re-bind
  _seed = null;
  _resetSchedules(); // reset the virtual clock + pending schedules
  // Dispose every owned resource this runtime acquired. `await using ui` /
  // `h.dispose()` must leave no watcher, socket or child process behind — and a
  // disposer that throws is exactly the defect a test should catch.
  if (_own) {
    _own.disposeAll();
    _own = null;
  }
}

/** Full reset — state AND the cell registry. */
export function _reset(): void {
  _resetState();
  _resetCellRegistry();
}

// ── Cell-based standalone runtime (AIO-404) ─────────────────────────
// The scaffolded app code (`cell()` + `aio.run()`) must work in Android
// WebView builds too: compose the cells, run the composed reducer through
// the local dispatch loop, bind cell methods to it. No server, no sync —
// persistence is localStorage via initStandalone.
//
// The generated client bundle mounts App.tsx directly and never executes the
// user's app.ts (which calls the *server* aio.run()). So on standalone the
// runtime boots from the cell registry — every `cell()` self-registers, and
// ensureConnected()/aio.run() compose + bind whatever has been defined.

let _cellApp: AioApp<Record<string, unknown>, Msg> | null = null;

// Set by the running standalone app (see `_seed` above); cleared on reset.
let _seed: ((partial: Record<string, unknown>) => void) | null = null;

// Tears down the booted cells (composed.destroyAll — onDestroy hooks + the
// `:__destroy` reset dispatches). Installed by bootStandalone, idempotent, and
// fired from BOTH exits: `app.close()` (the production Android path) and
// `_resetState()` (the harness dispose/re-mount path). Null when no cell
// runtime is up.
let _destroyCells: (() => void) | null = null;

/** Install a starting state for the booted cells — harness only.
 *
 *  Throws when a key names no booted cell: a silently-ignored seed is a test
 *  that asserts against the developer's machine while looking like it pins a
 *  fixture, which is worse than no seeding at all.
 *  @internal */
export function _seedState(partial: Record<string, unknown>): void {
  if (!_seed) {
    throw new Error(
      "[aio] seed: no standalone app is running — seed after the cells boot",
    );
  }
  const known = Object.keys(
    (_cellApp?.getState() ?? {}) as Record<string, unknown>,
  );
  const unknown = Object.keys(partial).filter((k) => !known.includes(k));
  if (unknown.length > 0) {
    throw new Error(
      `[aio] seed: no booted cell named ${
        unknown.map((u) => `"${u}"`).join(", ")
      }` +
        ` — booted cells: ${known.join(", ") || "(none)"}`,
    );
  }
  _seed(partial);
}

function bootStandalone(
  cells: CellDef[],
  opts: {
    appId?: string;
    persist?: boolean | string;
    onRestore?: (s: Record<string, unknown>) => Record<string, unknown>;
    circuitBreaker?: import("./state/cell-compose.ts").CircuitBreakerConfig;
  } = {},
): AioApp<Record<string, unknown>, Msg> {
  if (_cellApp) return _cellApp; // idempotent — first caller wins
  // `circuitBreaker` rides through exactly like the server composition
  // (aio-composition.ts) — an app that configures a breaker gets the SAME
  // auto-disable behaviour on Android and in the in-process harnesses.
  const composed = composeCells(
    cells,
    opts.circuitBreaker ? { circuitBreaker: opts.circuitBreaker } : undefined,
  );
  // Client-scoped cells own their signal state locally (bindCellReactive runs
  // their methods against the signal directly, bypassing the dispatch loop).
  // The composed reducer never updates their slice, so a blanket
  // _applyFullState on every commit would overwrite the client signal with
  // the stale initial slice — e.g. a `session` cell's signed-in member gets
  // wiped the moment any server cell dispatches. Skip them on commit.
  const clientCellIds = new Set(
    cells.filter((f) => f.__aio.scope === "client").map((f) => f.__aio.id),
  );
  const app = initStandalone<Record<string, unknown>, Msg, Msg>(
    composed.initialState,
    {
      reduce: composed.reduce,
      execute: composed.execute,
      persist: opts.persist !== false && opts.persist !== "none",
      persistKey: `aio:${opts.appId ?? "app"}`,
      onRestore: opts.onRestore,
      // push each committed state into per-cell signals so `counter.count`
      // reads (upgraded to reactive below) re-render the AIR tree. Skip
      // client-scoped cells — they own their signal state (see note above).
      onCommit: (s) => {
        if (clientCellIds.size === 0) {
          _applyFullState(s as Record<string, unknown>);
          return;
        }
        const filtered: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
          if (!clientCellIds.has(k)) filtered[k] = v;
        }
        _applyFullState(filtered);
      },
    },
  );
  for (const f of cells) {
    // bindCell: wrap methods to dispatch through the local loop
    bindCell(
      f,
      (action) => Promise.resolve(app.dispatch(action)),
      () => app.getState() as Record<string, unknown>,
    );
    // bindCellReactive (no sendFn): upgrade the state getters to read the
    // per-cell signal — keeps the bound methods from bindCell intact
    bindCellReactive(f);
  }
  // A disabled cell must stop owning things — the same contract the server
  // runtime wires in `aio.ts` (`config._onScheduleReady`), which nothing wired
  // here: a cell the registry disabled kept its timers ticking and its
  // resources open in the harness while production cancelled and disposed them
  // by prefix.
  composed.registry.setOnDisable((prefix: string) => {
    _scheduler().cancelByPrefix(prefix);
    _ownManager().disposeByPrefix(prefix);
  });
  // seed the cell signals with the restored/initial state
  _applyFullState(app.getState() as Record<string, unknown>);
  // Late-bind the cell names so `close()` can scope its abort + drain to this
  // runtime's own cells (see `_standaloneCells`).
  _standaloneCells = new Set(composed.cellNames);
  _cellApp = app;
  // ── Cell lifecycle — the SAME contract as the server (aio-cells-bridge
  // onStart/onStop) and the worker host (cell-worker-host.ts): initAll at
  // boot, destroyAll on teardown. This used to be skipped entirely, so
  // `onInit`/`onDestroy` never ran on this runtime AND `setCbApp` stayed
  // unset — the circuit breaker could not TRIP in-process. testUI/testCell/
  // bootCells boot through here, which made the harness MORE permissive than
  // production (the one thing CLAUDE.md forbids outright).
  const lifecycleApp = {
    dispatch: (a: Msg) => void app.dispatch(a),
    getState: () => app.getState() as unknown,
  };
  composed.initAll(lifecycleApp); // wires setCbApp, runs each cell's onInit
  let destroyed = false;
  _destroyCells = () => {
    if (destroyed) return; // close() then _resetState() must not destroy twice
    destroyed = true;
    // The `:__destroy` dispatches ride the System-teardown exception in
    // dispatch.ts, so they still apply after `dispatch.close()` — exactly like
    // the server's onStop destroyAll.
    composed.destroyAll(lifecycleApp);
  };
  // Production Android path: close() drains in-flight work first (see
  // initStandalone), THEN the cells are destroyed — the worker-host ordering
  // (abort → settle → destroyAll).
  const innerClose = app.close;
  app.close = async () => {
    await innerClose();
    _destroyCells?.();
  };
  return app;
}

/** Standalone builds have no server — instead, boot the local runtime from the
 *  cell registry. Called by the generated bundle entry before mount, so cell
 *  methods are bound by the time the first component renders. Idempotent. */
export function ensureConnected(): void {
  if (_cellApp) return;
  const cells = [...getRegisteredCells().values()];
  if (cells.length) bootStandalone(cells);
}

type StandaloneRunConfig = {
  appId: string;
  appVersion?: string;
  cells?: CellDef[];
  persist?: boolean | string;
  onRestore?: (state: Record<string, unknown>) => Record<string, unknown>;
  circuitBreaker?: import("./state/cell-compose.ts").CircuitBreakerConfig;
  /** `ui` is mostly server-only here, but two keys DO reach a standalone
   *  shell — `theme` and `lang` — because the packaged HTML could not be told
   *  them at build time. See {@linkcode applyShellUi}. */
  ui?: Record<string, unknown>;
  // other server-only options (baseDir, port, schedules, …) are accepted and
  // ignored so one app.ts can serve both server and standalone builds
  [key: string]: unknown;
};

/** Standalone `aio.run()` — cell-based apps in WebView/Android builds.
 *  Composes the given cells (or the whole registry) and binds their methods to
 *  a local dispatch loop. Server-only config (ui, port, schedules, db) is
 *  ignored. Idempotent with ensureConnected(). */
/** The `<head>` half of `ui` a packaged shell could not be told at BUILD time.
 *
 *  The android/standalone shell is written before `aio.run()` exists, so it
 *  cannot know `ui.theme` or `ui.lang`. Both travel with the bundle instead:
 *  the shell ships the default look DISABLED (`media="not all"`, see
 *  `server-html-gen.ts`) and this enables it when the app actually asked for
 *  it. Without this, a scaffolded android app — whose template markup uses
 *  `.card` / `.row` / `.stack` — was themed under `deno task dev` and unstyled
 *  in its own APK, which is the WYSIDIWYSIP break the shells exist to prevent.
 *
 *  Observe-only and defensive: no document (a test, a worker) means nothing to
 *  do, and a shell without the deferred sheet is simply left alone. */
export function _applyShellUi(
  ui: Record<string, unknown> | undefined,
): void {
  if (!ui || typeof document === "undefined") return;
  const lang = typeof ui.lang === "string" ? ui.lang.trim() : "";
  if (lang) document.documentElement.lang = lang;
  const theme = ui.theme;
  if (theme !== "auto" && theme !== "full") return;
  const deferred = document.querySelector("style[data-aio-theme-deferred]");
  if (!deferred) return;
  // `"auto"` steps aside for an app that ships its own stylesheet — the same
  // rule the server shell applies, asked at the one moment this runtime can
  // see the answer.
  const appCss = document.querySelector('link[rel="stylesheet"]');
  if (theme === "auto" && appCss) return;
  deferred.removeAttribute("media");
}

function runStandalone(
  cfg: StandaloneRunConfig,
): Promise<AioApp<Record<string, unknown>, Msg>> {
  _applyShellUi(cfg.ui as Record<string, unknown> | undefined);
  const cells = cfg.cells && cfg.cells.length
    ? cfg.cells
    : [...getRegisteredCells().values()];
  return Promise.resolve(
    bootStandalone(cells, {
      appId: cfg.appId,
      persist: cfg.persist,
      onRestore: cfg.onRestore,
      circuitBreaker: cfg.circuitBreaker,
    }),
  );
}

/** Standalone counterpart of the server `aio` namespace. */
export const aio: { run: typeof runStandalone } = { run: runStandalone };

/** Define a cell — works identically in standalone builds; methods dispatch
 *  through the local loop instead of a server connection. */
export { cell } from "./state/cell.ts";
