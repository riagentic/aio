// cell-impl.ts — Implementation shared by cell() and reactive()
//
// This module contains the shared logic for:
// - Method classification (sync/async)
// - Live proxy for async methods
// - Mutation batching
// - Machine auto-generation
// - Inter-cell call() — callback form only (typed, no raw strings)

import type { Msg } from "./cell-types.ts";
import { cloneState } from "./immutable.ts";
import type { ScheduleEffect } from "./schedule.ts";
import type { OwnEffect } from "./own.ts";
import { diagEmit } from "../diagnostics/diagnostic-bus.ts";

// Internal method types — `any` at spread args/return is unavoidable when
// mapping over heterogeneous method signatures at the type-system boundary.

/** Everything a method may return as an effect — a single schedule/own effect or
 *  an array of them. Use it as the return annotation when a method references its
 *  own cell (`return self.x.action()`), which otherwise trips TypeScript's
 *  self-referential-inference guard (TS7022/7023):
 *
 *  ```ts
 *  skip(s): CellEffect { return schedule.after("next", 0, cycle.tick.action()); }
 *  // conditional: `: CellEffect | void` · async: `: Promise<CellEffect | void>`
 *  ``` */
export type CellEffect =
  | ScheduleEffect
  | OwnEffect
  | (ScheduleEffect | OwnEffect)[];

/** Synchronous cell method — mutates state; may return a `CellEffect` (to
 *  schedule work) OR a plain VALUE that `await cell.method()` resolves with
 *  (AIO-427). Effects are tagged (`type: "__schedule"/"__own"`), so a returned
 *  value is unambiguous at runtime. `unknown` keeps the constraint permissive;
 *  the caller-side return type is inferred precisely by DirectCalling. */
export type SyncMethod<S> = (
  s: S & Partial<MethodDraftMeta>,
  // deno-lint-ignore no-explicit-any
  ...args: any[]
) => unknown;
/** Async cell method — runs in executor, mutations batched via proxy */
export type AsyncMethod<S> = (
  s: S & Partial<MethodDraftMeta>,
  // deno-lint-ignore no-explicit-any
  ...args: any[]
  // deno-lint-ignore no-explicit-any
) => Promise<any>;

/** Opt-in draft annotation for cancellation-aware methods (perfect-aio D1):
 *  `async place(s: MyState & Partial<MethodDraftMeta>) { … s.$signal?.… }`.
 *  At runtime `s.$signal` is ALWAYS served on async methods (live proxy);
 *  the annotation is Partial because strict contravariance forbids a
 *  required-extra param on Method<S> — use `s.$signal?.aborted` (or `!` when
 *  you know the method is async). */
export type MethodDraftMeta = { readonly $signal: AbortSignal };
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

/** Options for call() — `timeoutMs` (the `...Ms` suffix every other duration
 *  in the API uses, matching `until({ timeoutMs })`), retries on failure.
 *  `timeout` is a deprecated alias kept working so old code doesn't silently
 *  lose its timeout, but only `timeoutMs` is documented. */
export type CallOptions = {
  timeoutMs?: number;
  /** @deprecated use `timeoutMs` */
  timeout?: number;
  retries?: number;
};

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
 * const reserved = await call({ timeoutMs: 5000, retries: 2 }, () => inventory.reserve(items))
 */
export function call<T>(opts: CallOptions, fn: () => Promise<T>): Promise<T>;
/** Implementation — see the documented overload above. */
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
  const timeoutMs = opts.timeoutMs ?? opts.timeout; // deprecated alias
  const attempt = (): Promise<unknown> => {
    let p: Promise<unknown>;
    try {
      p = Promise.resolve(fn());
    } catch (e) {
      p = Promise.reject(e);
    }
    if (!timeoutMs) return p;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`call(): timeout after ${timeoutMs}ms`)),
        timeoutMs,
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

/** Path keys that would walk into JS prototype chain — banned to prevent
 *  prototype pollution via crafted mutation payloads from network sources. */
const BANNED_PATH_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Bound on path depth to reject pathological payloads early. */
const MAX_MUTATION_PATH_DEPTH = 32;

/** Validate a mutation path: array of plain strings, no banned keys, bounded depth. */
function isSafeMutationPath(path: unknown): path is string[] {
  if (!Array.isArray(path)) return false;
  if (path.length > MAX_MUTATION_PATH_DEPTH) return false;
  for (const k of path) {
    if (typeof k !== "string") return false;
    if (BANNED_PATH_KEYS.has(k)) return false;
  }
  return true;
}

/** Hard reject a mutation that would compromise integrity (prototype pollution etc).
 *  Always throws — the dispatch loop catches and reports as REDUCE_ERROR with full context. */
function _rejectUnsafeMutation(reason: string, m: Mutation): never {
  const detail = {
    reason,
    path: Array.isArray(m.path) ? m.path : null,
    op: m.op ?? null,
  };
  const msg = `[aio:cell] blocked unsafe mutation — ${reason} (path=${
    JSON.stringify(detail.path)
  })`;
  diagEmit({
    type: "mutation-blocked",
    severity: "error",
    source: "cell",
    message: msg,
    detail,
    hint:
      "Mutation path contained __proto__/constructor/prototype, an unknown array op, or a malformed shape. " +
      "Likely a malicious or buggy framework-internal action received from an untrusted source.",
  });
  throw new Error(msg);
}

/** Soft warn for a mutation dropped because an intermediate path key is null/undefined.
 *  Does NOT throw — preserves long-standing behavior, but surfaces the silent drop
 *  via diag bus + console.warn so app authors can find missing initialization. */
function _warnDroppedMutation(reason: string, m: Mutation): void {
  const detail = { reason, path: m.path, op: m.op ?? null };
  const msg = `[aio:cell] dropped mutation — ${reason} (path=${
    JSON.stringify(m.path)
  })`;
  diagEmit({
    type: "mutation-dropped",
    severity: "warning",
    source: "cell",
    message: msg,
    detail,
    hint: "An async-method mutation walked through a null/undefined parent. " +
      "Initialize the parent object/array, or guard the access in the method.",
  });
  console.warn(msg);
}

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
  m: Mutation,
): void {
  const path = m.path;
  if (path.length === 0) return;
  let current: unknown = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (current === null || current === undefined) {
      _warnDroppedMutation(
        `null intermediate at path[${i - 1}] for delete`,
        m,
      );
      return;
    }
    current = (current as Record<string, unknown>)[path[i]!];
  }
  if (current === null || current === undefined) {
    _warnDroppedMutation(`null parent for delete leaf`, m);
    return;
  }
  delete (current as Record<string, unknown>)[path[path.length - 1]!];
}

function setNestedValue(
  obj: Record<string, unknown>,
  m: Mutation,
): void {
  const path = m.path;
  if (path.length === 0) return;
  let current: unknown = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (current === null || current === undefined) {
      _warnDroppedMutation(`null intermediate at path[${i - 1}] for set`, m);
      return;
    }
    current = (current as Record<string, unknown>)[path[i]!];
  }
  if (current === null || current === undefined) {
    _warnDroppedMutation(`null parent for set leaf`, m);
    return;
  }
  (current as Record<string, unknown>)[path[path.length - 1]!] = m.value;
}

function applyArrayOp(
  obj: Record<string, unknown>,
  m: Mutation,
): void {
  const arr = m.path.length === 0 ? obj : getNestedValue(obj, m.path);
  if (!Array.isArray(arr)) {
    _warnDroppedMutation(`target at path is not an array (op=${m.op})`, m);
    return;
  }
  // deno-lint-ignore no-explicit-any
  (arr as any)[m.op as string](...(m.args ?? []));
}

/** Apply a batch of mutations (set, delete, array ops) to a state object.
 *  Hard-rejects mutations with banned-key paths or unknown array ops to
 *  prevent prototype pollution and sandbox-escape from network-sourced payloads. */
export function applyMutations(
  s: Record<string, unknown>,
  mutations: Mutation[],
): void {
  if (!Array.isArray(mutations)) {
    _rejectUnsafeMutation(
      "mutations payload is not an array",
      { path: [], value: mutations } as Mutation,
    );
  }
  for (const m of mutations) {
    if (!m || typeof m !== "object") {
      _rejectUnsafeMutation("mutation entry is not an object", {
        path: [],
        value: m,
      } as Mutation);
    }
    if (!isSafeMutationPath(m.path)) {
      _rejectUnsafeMutation(
        "path contains banned key (__proto__/constructor/prototype), non-string segment, or exceeds depth",
        m,
      );
    }
    if (m.op === "delete") {
      deleteNestedKey(s, m);
    } else if (m.op !== undefined) {
      if (typeof m.op !== "string" || !ARRAY_MUTATORS.has(m.op)) {
        _rejectUnsafeMutation(
          `unsupported array op "${String(m.op)}" — only ${
            [...ARRAY_MUTATORS].join("/")
          } are allowed`,
          m,
        );
      }
      applyArrayOp(s, m);
    } else {
      setNestedValue(s, m);
    }
  }
}

// ── Microtask batcher ──────────────────────────────────────────────
//
// Async method mutations are batched and flushed via queueMicrotask.
// This means `s.count++` inside an async method does NOT dispatch immediately —
// it dispatches at the next microtask boundary AFTER the async call resolves.
//
// READ-YOUR-WRITES: reads through the `s` proxy see committed state with this
// invocation's pending (unflushed) mutations overlaid — `s.x = 5; use(s.x)`
// behaves exactly like sync code. The overlay replays the pending batch
// through applyMutations itself, so what you read is byte-for-byte what will
// commit. Other cells / concurrent invocations stay invisible until they
// actually commit (their batches are their own).
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

  return {
    add,
    /** Unflushed mutations of the current batch — the live proxy overlays
     *  these on reads (read-your-writes). */
    pending: () => batch.mutations,
  };
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

/** Array read methods (non-mutating) that we intercept on the live proxy to
 *  return plain data from a structuredClone snapshot. Mutators remain in
 *  ARRAY_MUTATORS and are handled separately. */
const ARRAY_READ_METHODS = new Set([
  "map",
  "filter",
  "find",
  "findIndex",
  "some",
  "every",
  "reduce",
  "reduceRight",
  "slice",
  "concat",
  "includes",
  "indexOf",
  "lastIndexOf",
  "flat",
  "flatMap",
  "forEach",
  "entries",
  "keys",
  "values",
  "join",
  "toLocaleString",
  "toString",
  "toSorted",
  "toReversed",
  "toSpliced",
]);

/** Snapshot a value for read-method interception — the shared cloneState
 *  ladder with the `"shallow"` last rung: never returns the live value by
 *  reference (an identity fallback would let a `.map()`/`.find()` over the
 *  "snapshot" silently mutate real state — the Immer-alias bug class
 *  immutable.ts exists to kill). */
function snapshotForRead(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  return cloneState(value, "shallow");
}

/** Throw the canonical "live async state" error. */
function throwLiveStateError(
  cellName: string,
  methodName: string,
  op: string,
): never {
  throw new Error(
    `[${cellName}:${methodName}] ${op} is not supported on live async state — snapshot first: const items = [...s.items]`,
  );
}

/** Memoized read-your-writes view: committed state with the invocation's
 *  pending mutations overlaid. Shared across the proxy tree of one method
 *  invocation.
 *
 *  The key includes the pending array's IDENTITY, not just its length. A flush
 *  swaps in a fresh mutations array; when Immer commits a no-op write (same
 *  value) the committed slice keeps its identity too, so (base, length) could
 *  repeat across two different batches — the memo then served the PREVIOUS
 *  batch's overlay and a method read its own write back as the pre-write value.
 *  Within one batch the array is stable and only grows, so identity + length is
 *  exact. */
type OverlayBox = {
  v: {
    base: unknown;
    arr: readonly unknown[];
    count: number;
    root: unknown;
  } | null;
};

/** Create a proxy over cell state that intercepts writes and batches them as
 *  mutations. Reads are READ-YOUR-WRITES: they see committed state with this
 *  batch's pending mutations overlaid (replayed via {@linkcode applyMutations},
 *  the exact code path that commits them), so `s.x = 5; use(s.x)` behaves
 *  like sync code. */
let _never: AbortSignal | null = null;
/** Shared never-aborting signal — `s.$signal` outside a cancellable call. */
function _neverSignal(): AbortSignal {
  if (!_never) _never = new AbortController().signal;
  return _never;
}

export function createLiveProxy<S extends Record<string, unknown>>(
  cellName: string,
  prefix: string,
  methodName: string,
  getState: () => S,
  batcher: ReturnType<typeof createBatcher>,
  path: string[] = [],
  _proxyCache: Map<string, S> = new Map(),
  _overlay: OverlayBox = { v: null },
  // Cancellation signal for this call (cancelOn / s.$signal — perfect-aio D1).
  _signal?: AbortSignal,
): S {
  /** Committed root state with pending writes overlaid (read-your-writes). */
  function effectiveRoot(): S {
    const committed = getState();
    const pending = batcher.pending();
    if (pending.length === 0) return committed;
    const memo = _overlay.v;
    if (
      memo && memo.base === committed && memo.arr === pending &&
      memo.count === pending.length
    ) {
      return memo.root as S;
    }
    const root = snapshotForRead(committed);
    // Clone failed and returned the committed object itself — overlaying
    // would mutate real state; degrade to committed reads instead.
    if (root === committed || root === null || typeof root !== "object") {
      return committed;
    }
    applyMutations(root as Record<string, unknown>, pending);
    _overlay.v = { base: committed, arr: pending, count: pending.length, root };
    return root as S;
  }
  const effectiveAt = (): unknown =>
    path.length === 0 ? effectiveRoot() : getNestedValue(effectiveRoot(), path);
  // AIO-57: Target must stay extensible and mirror state's keys.
  // ES Proxy invariant: if target is non-extensible, ownKeys must return exactly
  // the target's own keys. If deepFreeze (dispatch.ts freezeState) reaches this
  // proxy, it freezes the target → makes it non-extensible → ownKeys trap breaks
  // when state has keys the target doesn't. Fix: sync target keys on each ownKeys
  // call, and use configurable+writable descriptors so keys can always be added.
  //
  // The target's KIND must match the proxied value: Array.isArray() and
  // JSON.stringify() inspect the proxy's target, so an array value behind an
  // object target serializes as {"0":...} instead of [...] — corrupting any
  // nested array read through the proxy.
  const initialValue = effectiveAt();
  const target = (Array.isArray(initialValue) ? [] : {}) as unknown as S;

  const handler: ProxyHandler<S> = {
    get(_target, prop, receiver) {
      if (typeof prop === "symbol") {
        // Make arrays spreadable + iterable: `[...s.items]` and
        // `for (const x of s.items)`. The blanket symbol→undefined return used
        // to make `s.items[Symbol.iterator]` undefined → "not iterable" — which
        // contradicted our own guidance ("snapshot first: const items =
        // [...s.items]"). Delegate to indexed access THROUGH the proxy so each
        // element has exactly the same semantics as `s.items[i]` (a nested live
        // proxy for objects → writes still batch; primitives as-is). This
        // matches testCell's Immer draft (also iterable + mutable) — no
        // dev/prod fork.
        if (prop === Symbol.iterator) {
          const fresh = effectiveAt();
          if (Array.isArray(fresh)) {
            const len = fresh.length;
            return function* () {
              for (let i = 0; i < len; i++) {
                yield (receiver as Record<number, unknown>)[i];
              }
            };
          }
        }
        return undefined;
      }
      const key = prop as string;
      // `s.$signal` — the call's AbortSignal (aborts when a cancelOn trigger
      // fires). A never-aborting fallback keeps `s.$signal.aborted` safe in
      // sync methods / contexts without cancellation.
      if (key === "$signal") {
        return _signal ?? _neverSignal();
      }
      const fresh = effectiveAt();
      const value = (fresh as Record<string, unknown>)[key];

      // Array method interception — read methods
      if (
        Array.isArray(fresh) && ARRAY_READ_METHODS.has(key) &&
        typeof value === "function"
      ) {
        // `find` returns an ELEMENT the caller may hold across an await and
        // then MUTATE (`const u = s.users.find(…); u.salt = x`). A detached
        // snapshot element silently dropped that write in prod while
        // testCell's Immer draft applied it — the worst kind of divergence
        // (inews R4). Resolve the element's INDEX instead and hand back the
        // LIVE proxy at that path, so writes batch exactly like s.users[i].
        if (key === "find") {
          return (...args: unknown[]) => {
            const snap = snapshotForRead(fresh) as unknown[];
            const idx = snap.findIndex(
              args[0] as (v: unknown, i: number, a: unknown[]) => boolean,
              args[1],
            );
            if (idx === -1) return undefined;
            const el = (fresh as unknown[])[idx];
            if (el === null || typeof el !== "object") return el;
            const cacheKey = [...path, String(idx)].join("\0");
            let cached = _proxyCache.get(cacheKey);
            if (!cached) {
              cached = createLiveProxy(
                cellName,
                prefix,
                methodName,
                getState,
                batcher,
                [...path, String(idx)],
                _proxyCache,
                _overlay,
              );
              _proxyCache.set(cacheKey, cached);
            }
            return cached;
          };
        }
        return (...args: unknown[]) => {
          // Snapshot the array before running the read method so the result
          // is plain data, not a live-proxy-wrapped value.
          const snap = snapshotForRead(fresh);
          // deno-lint-ignore no-explicit-any
          return (snap as any)[key](...args);
        };
      }

      // Array method interception — mutators
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
            _overlay,
          );
          _proxyCache.set(cacheKey, cached);
        }
        return cached;
      }

      // AIO-4.3: any other function value on a non-array is a usage we
      // don't support. Throw the canonical "live async state" error so
      // users get an actionable message rather than silent wrong data.
      if (typeof value === "function" && !Array.isArray(fresh)) {
        throwLiveStateError(cellName, methodName, `${key}()`);
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
      const fresh = effectiveAt();
      if (fresh === null || fresh === undefined) return false; // AIO-232
      return prop in (fresh as object);
    },

    ownKeys() {
      const fresh = effectiveAt();
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
      const fresh = effectiveAt();
      if (fresh === null || fresh === undefined) return undefined; // AIO-232
      // Check fresh state directly — target may be stale if state was replaced.
      const freshObj = fresh as Record<string, unknown>;
      if (!(prop in freshObj)) return undefined;
      // Array targets: `length` is non-configurable on the target, so the
      // reported descriptor must match (ES proxy invariant) or the trap throws.
      if (prop === "length" && Array.isArray(fresh)) {
        return {
          configurable: false,
          enumerable: false,
          writable: true,
          value: (fresh as unknown[]).length,
        };
      }
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
