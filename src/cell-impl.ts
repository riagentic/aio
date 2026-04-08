// cell-impl.ts — Implementation shared by cell() and reactive()
//
// This module contains the shared logic for:
// - Method classification (sync/async)
// - Live proxy for async methods
// - Mutation batching
// - Machine auto-generation
// - Inter-cell call() — callback form only (typed, no raw strings)

import type { Msg } from "./cell-types.ts";
import type { ScheduleEffect } from "./schedule.ts";

// Internal method types — `any` at spread args/return is unavoidable when
// mapping over heterogeneous method signatures at the type-system boundary.
/** Synchronous cell method — mutates state, optionally returns effects */
export type SyncMethod<S> = (
  s: S,
  // deno-lint-ignore no-explicit-any
  ...args: any[]
) => void | ScheduleEffect | ScheduleEffect[];
/** Async cell method — runs in executor, mutations batched via proxy */
// deno-lint-ignore no-explicit-any
export type AsyncMethod<S> = (s: S, ...args: any[]) => Promise<any>;
/** Cell method — sync or async */
export type Method<S> = SyncMethod<S> | AsyncMethod<S>;

/** Map of cell methods keyed by name */
export type CellMethods<S extends Record<string, unknown>> = Record<
  string,
  Method<S>
>;

// ── Pending async call registry ────────────────────────────────────
// Tracks in-flight async method calls keyed by UUID.
// Used by direct calling (bindCell) and resolveCall (executor completion).

const _pending = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (e: Error) => void }
>();

/** Options for call() — timeout in ms, retries on failure */
export type CallOptions = { timeout?: number; retries?: number };

/**
 * Wrap an inter-cell async call with timeout and/or retry.
 * Use direct calling for the simple case — `await cell.method(args)`.
 * Use `call()` when you need timeout or retry semantics.
 *
 * @example
 * // Simple — preferred
 * const reserved = await inventory.reserve(items)
 *
 * // With timeout/retry
 * const reserved = await call({ timeout: 5000, retries: 2 }, () => inventory.reserve(items))
 */
export function call<T>(opts: CallOptions, fn: () => Promise<T>): Promise<T>;
export function call(
  opts: CallOptions,
  fn: () => Promise<unknown>,
): Promise<unknown> {
  return callWithOpts(fn, opts);
}

/** Wraps a fn with timeout and/or retries — shared by call() and ctx.call() */
export function callWithOpts(
  fn: () => unknown | Promise<unknown>,
  opts: CallOptions,
): Promise<unknown> {
  const attempt = (): Promise<unknown> => {
    let p: Promise<unknown>;
    try {
      p = Promise.resolve(fn());
    } catch (e) {
      p = Promise.reject(e);
    }
    if (!opts.timeout) return p;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`call(): timeout after ${opts.timeout}ms`)),
        opts.timeout,
      );
      p.then((v) => {
        clearTimeout(timer);
        resolve(v);
      }, (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  };
  if (!opts.retries) return attempt();
  let remaining = opts.retries;
  const retry = (): Promise<unknown> =>
    attempt().catch((e) => {
      if (remaining-- > 0) return retry();
      throw e;
    });
  return retry();
}

/** Default timeout for await cell.method() — prevents silent hangs if executor never resolves */
const CALL_TIMEOUT = 30_000;

/** Register a pending call — returns Promise that resolves when resolveCall() is called.
 *  Times out after 30s by default to prevent silent deadlocks. */
export function registerCall(callId: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (_pending.has(callId)) {
        _pending.delete(callId);
        reject(
          new Error(
            `await cell.method() timed out after ${
              CALL_TIMEOUT / 1000
            }s — the effect executor may have crashed or never resolved this call`,
          ),
        );
      }
    }, CALL_TIMEOUT);
    _pending.set(callId, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
  });
}

/** Resolve a pending call() — invoked by executor on async method completion */
export function resolveCall(
  callId: string | undefined,
  value?: unknown,
  error?: Error,
): void {
  if (!callId) return;
  const pending = _pending.get(callId);
  if (!pending) return;
  _pending.delete(callId);
  if (error) pending.reject(error);
  else pending.resolve(value);
}

/** Clear all pending async call registrations — for test isolation between runs */
export function resetPending(): void {
  _pending.clear();
}

/** Batched mutation — multiple property writes grouped into one action */
export type Mutation = {
  path: string[];
  value?: unknown;
  op?: string;
  args?: unknown[];
};

// ── Helpers ────────────────────────────────────────────────────────

/** Uppercase the first character of a string. */
export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Symbol marker for minification-safe async detection.
// `.constructor.name` is the primary detection path; `_asyncMark` is a fallback
// for cases where minification strips constructor names (rare in Deno, common in bundled JS).
const _asyncMark = Symbol("aio.async");

/** Explicitly mark a method as async when minification would strip constructor names.
 *  Rarely needed — standard `async function` syntax is auto-detected. */
export function markAsync<T extends (...args: unknown[]) => Promise<unknown>>(
  fn: T,
): T {
  (fn as unknown as Record<symbol, boolean>)[_asyncMark] = true;
  return fn;
}

/** Check if a function is async — detects `async function` or explicitly marked with `markAsync`. */
// deno-lint-ignore ban-types
export function isAsyncFunction(fn: Function): boolean {
  return (fn as unknown as Record<symbol, boolean>)[_asyncMark] === true ||
    fn.constructor.name === "AsyncFunction";
}

/** Internal set action key for an async method: __setMethodName */
export function setKey(method: string): string {
  return `__set${capitalize(method)}`;
}

// ── Mutation helpers ───────────────────────────────────────────────

function getNestedValue(obj: unknown, path: string[]): unknown {
  let current = obj;
  for (const key of path) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

// AIO-240: delete a nested key by path
function deleteNestedKey(
  obj: Record<string, unknown>,
  path: string[],
): void {
  if (path.length === 0) return;
  let current: unknown = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (current === null || current === undefined) return;
    current = (current as Record<string, unknown>)[path[i]!];
  }
  if (current === null || current === undefined) return;
  delete (current as Record<string, unknown>)[path[path.length - 1]!];
}

function setNestedValue(
  obj: Record<string, unknown>,
  path: string[],
  value: unknown,
): void {
  if (path.length === 0) return;
  let current: unknown = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (current === null || current === undefined) return; // AIO-231
    current = (current as Record<string, unknown>)[path[i]!];
  }
  if (current === null || current === undefined) return; // AIO-231
  (current as Record<string, unknown>)[path[path.length - 1]!] = value;
}

function applyArrayOp(
  obj: Record<string, unknown>,
  path: string[],
  op: string,
  args: unknown[],
): void {
  const arr = path.length === 0 ? obj : getNestedValue(obj, path);
  if (!Array.isArray(arr)) return; // deno-lint-ignore no-explicit-any
  (arr as any)[op](...args);
}

/** Apply a batch of mutations (set, delete, array ops) to a state object. */
export function applyMutations(
  s: Record<string, unknown>,
  mutations: Mutation[],
): void {
  for (const m of mutations) {
    if (m.op === "delete") deleteNestedKey(s, m.path); // AIO-240: handle property deletion
    else if (m.op) applyArrayOp(s, m.path, m.op, m.args ?? []);
    else setNestedValue(s, m.path, m.value);
  }
}

// ── Microtask batcher ──────────────────────────────────────────────
//
// Async method mutations are batched and flushed via queueMicrotask.
// This means `s.count++` inside an async method does NOT dispatch immediately —
// it dispatches at the next microtask boundary AFTER the async call resolves.
//
// Implication: concurrent async methods each see the state snapshot from when
// they were called, not the latest state. To read fresh state mid-method,
// call getState()[cellName] directly instead of using the `s` proxy.
//
// This is intentional: all mutations stay observable (dispatched as actions)
// and partial-state visibility during async gaps is prevented.

type BatchState = {
  mutations: Mutation[];
  scheduled: boolean;
  method: string;
};

/** Create a microtask batcher that groups async method mutations into single dispatched actions. */
export function createBatcher(prefix: string, dispatch: (action: Msg) => void) {
  const batch: BatchState = { mutations: [], scheduled: false, method: "" };

  function add(method: string, mutation: Mutation): void {
    // Different method → flush previous batch immediately so mutations
    // are never misattributed (AIO-77)
    if (batch.mutations.length > 0 && batch.method !== method) {
      flush();
    }
    batch.mutations.push(mutation);
    batch.method = method;
    if (!batch.scheduled) {
      batch.scheduled = true;
      queueMicrotask(flush);
    }
  }

  function flush(): void {
    if (batch.mutations.length === 0) {
      batch.scheduled = false;
      return;
    }
    const mutations = batch.mutations;
    const method = batch.method;
    batch.mutations = [];
    batch.scheduled = false;
    batch.method = "";
    dispatch({
      type: `${prefix}:${setKey(method)}`,
      payload: { mutations, _origin: method },
    });
  }

  return { add };
}

// ── Live Proxy for async methods ───────────────────────────────────

const ARRAY_MUTATORS = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
]);

/** Create a proxy over cell state that intercepts writes and batches them as mutations. */
export function createLiveProxy<S extends Record<string, unknown>>(
  cellName: string,
  prefix: string,
  methodName: string,
  getState: () => S,
  batcher: ReturnType<typeof createBatcher>,
  path: string[] = [],
  _proxyCache: Map<string, S> = new Map(),
): S {
  // AIO-57: Target must stay extensible and mirror state's keys.
  // ES Proxy invariant: if target is non-extensible, ownKeys must return exactly
  // the target's own keys. If deepFreeze (dispatch.ts freezeState) reaches this
  // proxy, it freezes the target → makes it non-extensible → ownKeys trap breaks
  // when state has keys the target doesn't. Fix: sync target keys on each ownKeys
  // call, and use configurable+writable descriptors so keys can always be added.
  const target = {} as S;

  const handler: ProxyHandler<S> = {
    get(_target, prop, _receiver) {
      if (typeof prop === "symbol") return undefined;
      const key = prop as string;
      const fresh = path.length === 0
        ? getState()
        : getNestedValue(getState(), path);
      const value = (fresh as Record<string, unknown>)[key];

      // Array method interception
      if (
        Array.isArray(fresh) && ARRAY_MUTATORS.has(key) &&
        typeof value === "function"
      ) {
        return (...args: unknown[]) => {
          // AIO-253: compute return value from a copy before batching the mutation
          const copy = [...fresh as unknown[]];
          // deno-lint-ignore no-explicit-any
          const result = (copy as any)[key](...args);
          batcher.add(methodName, { path: [...path], op: key, args });
          return result;
        };
      }

      // Nested object/array — return cached nested proxy
      if (value !== null && typeof value === "object") {
        const cacheKey = [...path, key].join("\0");
        let cached = _proxyCache.get(cacheKey);
        if (!cached) {
          cached = createLiveProxy(
            cellName,
            prefix,
            methodName,
            getState,
            batcher,
            [...path, key],
            _proxyCache,
          );
          _proxyCache.set(cacheKey, cached);
        }
        return cached;
      }

      return value;
    },

    set(_target, prop, value) {
      if (typeof prop === "symbol") return false;
      batcher.add(methodName, { path: [...path, prop as string], value });
      return true;
    },

    // AIO-240: intercept `delete` so property removal is batched as a mutation
    deleteProperty(_target, prop) {
      if (typeof prop === "symbol") return false;
      batcher.add(methodName, {
        path: [...path, prop as string],
        value: undefined,
        op: "delete",
      });
      return true;
    },

    has(_target, prop) {
      if (typeof prop === "symbol") return false;
      const fresh = path.length === 0
        ? getState()
        : getNestedValue(getState(), path);
      if (fresh === null || fresh === undefined) return false; // AIO-232
      return prop in (fresh as object);
    },

    ownKeys() {
      const fresh = path.length === 0
        ? getState()
        : getNestedValue(getState(), path);
      if (fresh === null || fresh === undefined) return []; // AIO-232
      const freshKeys = Reflect.ownKeys(fresh as object);
      // Sync target keys with fresh state to satisfy ES invariant:
      // target must have at least all keys returned by ownKeys.
      const freshKeySet = new Set(
        freshKeys.filter((k): k is string => typeof k === "string"),
      );
      // DELETE stale keys from target that no longer exist in fresh state
      // (handles array/object replacement where old indices linger).
      for (const k of Object.keys(target)) {
        if (!freshKeySet.has(k)) {
          delete (target as Record<string, unknown>)[k];
        }
      }
      // ADD missing keys so getOwnPropertyDescriptor can satisfy the invariant.
      for (const k of freshKeySet) {
        if (!(k in target)) {
          Object.defineProperty(target, k, {
            configurable: true,
            enumerable: true,
            writable: true,
            value: undefined,
          });
        }
      }
      return freshKeys;
    },

    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop === "symbol") return undefined;
      const fresh = path.length === 0
        ? getState()
        : getNestedValue(getState(), path);
      if (fresh === null || fresh === undefined) return undefined; // AIO-232
      // Check fresh state directly — target may be stale if state was replaced.
      const freshObj = fresh as Record<string, unknown>;
      if (!(prop in freshObj)) return undefined;
      return {
        configurable: true,
        enumerable: true,
        writable: true,
        value: freshObj[prop as string],
      };
    },

    // Prevent Object.freeze/preventExtensions from locking the target
    preventExtensions() {
      return false;
    },
    isExtensible() {
      return true;
    },
  };

  return new Proxy(target, handler);
}

// ── Method classification ──────────────────────────────────────────

/** Partition cell methods into sync and async sets based on function type. */
export function classifyMethods<S extends Record<string, unknown>>(
  methods: CellMethods<S>,
): {
  syncMethods: Set<string>;
  asyncMethods: Set<string>;
} {
  const syncMethods = new Set<string>();
  const asyncMethods = new Set<string>();
  for (const key of Object.keys(methods)) {
    if (isAsyncFunction(methods[key]!)) asyncMethods.add(key);
    else syncMethods.add(key);
  }
  return { syncMethods, asyncMethods };
}
