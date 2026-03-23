// Standalone runtime — full client-side dispatch loop for Android WebView builds
// Note: consumers must include "dom" in their tsconfig lib or use /// <reference lib="dom" />
// Replaces browser.ts when building with --android. Same API, no server.
import { type ComponentType, createElement, useEffect, useState } from "react";
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

// Re-exports for user code — reduce.ts imports { draft } from 'aio', etc.
export { actions, effects, msg };

/** Extracts return types of all function members into a union */
export type UnionOf<T> = {
  // deno-lint-ignore no-explicit-any
  [K in keyof T]: T[K] extends (...args: any[]) => infer R ? R : never;
}[keyof T];

// WHY DUPLICATED: draft() is a copy of mod.ts draft(). standalone.ts can't import mod.ts
// because it IS the aio entrypoint for Android builds (replaces browser.ts + mod.ts).
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

/** Notifies all React subscribers of state change */
function _notify(): void {
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
  persistDebounceMs?: number; // ms between localStorage writes (default: 100)
  perfCheck?: PerfCheck; // 'strict' or 'soft' — performance violation handling
  perfBudget?: PerfBudget; // override default budgets
  freezeState?: boolean; // deep freeze state after reduce to catch mutations (default: true)
  onRestore?: (state: S) => S; // transform state after restore, before UI renders
};

const STORAGE_KEY = "aio_state";

/** Initializes standalone runtime — call before React mounts */
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

  // Build error reporting opts (standalone is always prod-like, compact format)
  // Memory monitor not available in standalone/browser mode (no Deno.memoryUsage API)
  const _reportOpts: ReportErrorOpts = {
    onError: undefined, // standalone doesn't expose onError config yet
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

  // Debounced localStorage persistence (matches KV debounce pattern)
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

  // Shared dispatch loop — same implementation as aio.ts
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
    freezeState: config.freezeState ?? true, // default: true for standalone
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

// ── React hooks ──

/** Connects to standalone dispatch loop. Same API as browser.ts useAio(). */
export function useAio<S = unknown>(): {
  state: S | null;
  send: (action: { type: string; payload?: unknown }) => void;
} {
  const [state, setState] = useState<S | null>(_state as S | null);

  useEffect(() => {
    const unsub = _listeners.add((s) => setState(s as S | null));
    if (_state !== null) setState(_state as S | null);
    return unsub;
  }, []);

  const send = (action: { type: string; payload?: unknown }) => {
    if (_app) _app.dispatch(action);
    else {console.warn(
        "[aio] not initialized — call initStandalone() before rendering",
      );}
  };

  return { state, send };
}

/** Client-only state — not synced, not persisted */
export function useLocal<T>(
  initial: T,
): { local: T; set: (next: T | ((prev: T) => T)) => void } {
  const [local, setLocal] = useState<T>(initial);
  return { local, set: setLocal };
}

/** Renders the component matching the current page key */
export function page<K extends string>(
  current: K,
  routes: Record<K, ComponentType>,
): ReturnType<typeof createElement> | null {
  const Component = routes[current];
  return Component ? createElement(Component) : null;
}

/** Resets module state — for testing only */
export function _reset(): void {
  _state = null;
  _app = null;
  _listeners.clear();
}
