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
import { isScheduleEffect, type ScheduleEffect } from "./state/schedule.ts";
import { log } from "./diagnostics/logger-api.ts";
import { createOwnManager, isOwnEffect, type OwnEffect } from "./state/own.ts";
import { Listeners } from "./state/listeners.ts";
import { signal } from "./state/signal.ts";
import { useRef } from "./air/aio-renderer.ts";
import { type ComponentFn, h } from "./air/vdom.ts";
import { bindCell, bindCellReactive, type CellDef } from "./state/cell.ts";
import { composeCells } from "./state/cell-compose.ts";
import {
  _resetCellBindings,
  _resetCellRegistry,
  getRegisteredCells,
} from "./state/cell-reactive.ts";
import { _applyFullState, _resetSignals } from "./state/state-signals.ts";

// Re-exports for user code
export { msg };

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
let _app: AioApp | null = null;
// Once-per-process dedup for the "effect ignored in standalone" notices — a
// toast that returns schedule.after otherwise floods every test.
const _warnedStandalone = { schedule: false };

// Owned resources (`own.set`) acquired in this runtime. Lazily created so the
// module stays side-effect-free, and disposed by _resetState() so a test that
// boots cells and disposes the handle leaves nothing running.
let _own: ReturnType<typeof createOwnManager> | null = null;
function _ownManager(): ReturnType<typeof createOwnManager> {
  if (!_own) _own = createOwnManager(log);
  return _own;
}

// ── Virtual-clock scheduler (test/standalone) ──────────────────────────
// Schedule effects have no timer runtime in standalone/test mode, so instead of
// firing on the wall clock (non-deterministic) or dropping them (untestable —
// a field report), we hold `after`/`every` on a virtual clock. `_advanceSchedules(ms)`
// fires everything now due — so a test can drive toast auto-dismiss, debounce,
// backoff, poll, etc. deterministically.
interface PendingSched {
  id: string;
  kind: "after" | "every";
  ms: number;
  action: Msg;
  dueAt: number;
}
let _vclock = 0;
const _pendingScheds = new Map<string, PendingSched>();

/** Advance the virtual clock by `ms` and dispatch every schedule that comes
 *  due, in order. `every` schedules re-arm; `after` schedules fire once. */
export function _advanceSchedules(ms: number): void {
  if (!_cellApp) return;
  const target = _vclock + Math.max(0, ms);
  let guard = 0;
  while (guard++ < 1_000_000) {
    let next: PendingSched | null = null;
    for (const s of _pendingScheds.values()) {
      if (s.dueAt <= target && (!next || s.dueAt < next.dueAt)) next = s;
    }
    if (!next) break;
    _vclock = next.dueAt;
    if (next.kind === "every") next.dueAt += Math.max(1, next.ms);
    else _pendingScheds.delete(next.id);
    _cellApp.dispatch(next.action as Msg);
  }
  _vclock = target;
}

/** Reset the virtual clock + pending schedules (per-mount test isolation). */
export function _resetSchedules(): void {
  _vclock = 0;
  _pendingScheds.clear();
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
    warn: (msg: string) => console.warn(`[aio] ${msg}`),
    error: (msg: string) => console.error(`[aio] ${msg}`),
  };

  const dispatch = createDispatch<S, A, E>({
    reduce,
    execute: (effect) => {
      // Schedule effects: hold on the virtual clock so tests can fire them
      // deterministically with ui.advance(ms) / handle.advance(ms).
      if (isScheduleEffect(effect)) {
        const e = effect as ScheduleEffect;
        if (e.kind === "cancel") {
          _pendingScheds.delete(e.id);
        } else if (e.kind === "after" || e.kind === "every") {
          _pendingScheds.set(e.id, {
            id: e.id,
            kind: e.kind,
            ms: e.ms,
            action: e.action as Msg,
            dueAt: _vclock + Math.max(1, e.ms),
          });
        } else if (!_warnedStandalone.schedule) {
          // at/cron have no virtual-clock analogue — warn once.
          _warnedStandalone.schedule = true;
          console.warn(
            "[aio] schedule.at/cron are not supported in standalone/test mode " +
              "(warns once); after/every are testable via .advance(ms).",
          );
        }
        return;
      }
      if (isOwnEffect(effect)) {
        // Really acquire and dispose. Ignoring `own` here made the in-process
        // harnesses (testCell / testUI / bootCells) more permissive than
        // production — a leaked or misfiring resource could not surface in the
        // one place a test boots and disposes cells, converting a whole class of
        // bug into a production-only bug. Tests are the strictest
        // environment; a warning that says "ignored" is not strictness.
        _ownManager().handle(effect);
        return;
      }
      execute(app, effect as E);
    },
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
    close: () => {
      dispatch.close();
      flushPersist();
      return Promise.resolve();
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
} {
  const state = _stateSignal.value as S | null;

  const send = (action: { type: string; payload?: unknown }) => {
    if (_app) _app.dispatch(action);
    else {console.warn(
        "[aio] not initialized — call initStandalone() before rendering",
      );}
  };

  return { state, send };
}

/** Client-only signal state — not synced, not persisted */
export function useLocal<T>(
  initial: T,
): { local: T; set: (next: T | ((prev: T) => T)) => void } {
  const ref = useRef<ReturnType<typeof signal<T>> | null>(null);
  if (!ref.current) ref.current = signal<T>(initial);
  const sig = ref.current;
  return {
    get local() {
      return sig.value;
    },
    set: (next: T | ((prev: T) => T)) => {
      sig.set(
        typeof next === "function" ? (next as (prev: T) => T)(sig.value) : next,
      );
    },
  };
}

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
  _state = null;
  _app = null;
  _cellApp = null;
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
  } = {},
): AioApp<Record<string, unknown>, Msg> {
  if (_cellApp) return _cellApp; // idempotent — first caller wins
  const composed = composeCells(cells);
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
  // seed the cell signals with the restored/initial state
  _applyFullState(app.getState() as Record<string, unknown>);
  _cellApp = app;
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
  // server-only options (ui, baseDir, port, schedules, …) are accepted and
  // ignored so one app.ts can serve both server and standalone builds
  [key: string]: unknown;
};

/** Standalone `aio.run()` — cell-based apps in WebView/Android builds.
 *  Composes the given cells (or the whole registry) and binds their methods to
 *  a local dispatch loop. Server-only config (ui, port, schedules, db) is
 *  ignored. Idempotent with ensureConnected(). */
function runStandalone(
  cfg: StandaloneRunConfig,
): Promise<AioApp<Record<string, unknown>, Msg>> {
  const cells = cfg.cells && cfg.cells.length
    ? cfg.cells
    : [...getRegisteredCells().values()];
  return Promise.resolve(
    bootStandalone(cells, {
      appId: cfg.appId,
      persist: cfg.persist,
      onRestore: cfg.onRestore,
    }),
  );
}

/** Standalone counterpart of the server `aio` namespace. */
export const aio: { run: typeof runStandalone } = { run: runStandalone };

/** Define a cell — works identically in standalone builds; methods dispatch
 *  through the local loop instead of a server connection. */
export { cell } from "./state/cell.ts";
