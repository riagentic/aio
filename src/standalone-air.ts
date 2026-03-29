// Standalone AIR runtime — signal-based client-side dispatch loop for Android WebView builds
// Replaces standalone.ts when building with --android + renderer: "aio". Same API, no React.
import { type Draft, produce } from "immer";
import { msg } from "./msg.ts";
import { actions, effects } from "./factory.ts";
import { deepMerge } from "./deep-merge.ts";
import { createDispatch, type PerfBudget, type PerfCheck } from "./dispatch.ts";
import {
  createAioError,
  reportError as reportAioError,
  type ReportErrorOpts,
} from "./error.ts";
import type { AioApp } from "./aio.ts";
import { isScheduleEffect, type ScheduleEffect } from "./schedule.ts";
import { Listeners } from "./listeners.ts";
import { signal } from "./signal.ts";
import { useRef } from "./aio-renderer.ts";
import { type ComponentFn, h } from "./vdom.ts";

// Re-exports for user code
export { actions, effects, msg };

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
    effects = fn(d);
  });
  if (effects.length) effects = structuredClone(effects);
  return { state: next, effects };
}

// ── Internal state (singleton) ──

const _listeners = new Listeners<unknown>();
let _state: unknown = null;
let _app: AioApp | null = null;

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
  ) => { state: S; effects: (E | ScheduleEffect)[] };
  execute: (app: AioApp<S, A>, effect: E) => void;
  persist?: boolean;
  stateForDB?: (state: S) => unknown;
  stateForUI?: (state: S) => unknown;
  persistKey?: string;
  persistDebounceMs?: number;
  perfCheck?: PerfCheck;
  perfBudget?: PerfBudget;
  freezeState?: boolean;
  onRestore?: (state: S) => S;
};

const STORAGE_KEY = "aio_state";

/** Initializes standalone runtime — call before AIR mounts */
export function initStandalone<S, A, E>(
  initialState: S,
  config: StandaloneConfig<S, A, E>,
): AioApp<S, A> {
  const { reduce, execute } = config;
  const shouldPersist = config.persist !== false;
  const getDBState = config.stateForDB ?? ((s: S) => s);
  const getUIState = config.stateForUI ?? ((s: S) => s);
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
      if (isScheduleEffect(effect)) {
        console.warn(
          "[aio] scheduled effects are not supported in standalone mode — ignoring",
          effect,
        );
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
export function _reset(): void {
  _state = null;
  _app = null;
  _stateSignal.set(null);
  _listeners.clear();
}
