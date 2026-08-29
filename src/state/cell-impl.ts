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
import { removalMessage, removalOf } from "./removals.ts";
import type { ScheduleEffect } from "./schedule.ts";
import type { OwnEffect } from "./own.ts";
import { diagEmit } from "../diagnostics/diagnostic-bus.ts";
import { log } from "../diagnostics/logger-api.ts";
import { markInflight } from "./dispatch.ts";

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

/** The draft members served on EVERY method invocation, sync AND async
 *  (alpha52) — unlike the Partial meta below, `s.$do(...)` needs no `!`:
 *  sync drafts get it from the invocation wrapper, async proxies serve it at
 *  the root. */
export type MethodDraftServed = {
  /** Run effect(s) — the effect channel. See {@linkcode MethodDraftMeta.$do}. */
  readonly $do: (
    effect: ScheduleEffect | OwnEffect,
    ...more: (ScheduleEffect | OwnEffect)[]
  ) => void;
};

/** Synchronous cell method — mutates state; may return a `CellEffect` (to
 *  schedule work) OR a plain VALUE that `await cell.method()` resolves with
 *  (AIO-427). Effects are tagged (`type: "__schedule"/"__own"`), so a returned
 *  value is unambiguous at runtime. `unknown` keeps the constraint permissive;
 *  the caller-side return type is inferred precisely by DirectCalling. */
export type SyncMethod<S> = (
  s: S & Partial<MethodDraftMeta<S>> & MethodDraftServed,
  // deno-lint-ignore no-explicit-any
  ...args: any[]
) => unknown;
/** Async cell method — runs in executor, mutations batched via proxy */
export type AsyncMethod<S> = (
  s: S & Partial<MethodDraftMeta<S>> & MethodDraftServed,
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
export type MethodDraftMeta<S = Record<string, unknown>> = {
  readonly $signal: AbortSignal;
  /** Transactional cells: publish the buffered write-set atomically
   *  mid-method, then continue against a fresh snapshot. No-op off
   *  `transaction`.
   *
   *  `s.$commit(minMs)` publishes at most once per `minMs` — the progress
   *  throttle every long-running method otherwise hand-rolls:
   *
   *  ```ts
   *  for (const file of files) {
   *    s.scanned++
   *    s.$commit(100)          // ≤10 UI updates/second, whatever the loop does
   *  }
   *  ```
   *
   *  One report wrote that counter twice in one app (`if (++ticks % 8 === 0)`
   *  in a walk, `if (pct - published >= 0.01)` in a hasher) — a counter, a
   *  threshold and a bookkeeping variable per method, all of it the same
   *  decision. The FIRST call always publishes: a progress bar that waits an
   *  interval before its first frame looks like a hang. */
  readonly $commit: (minMs?: number) => void;
  /** The state as it is NOW, not as it was when this method entered — the one
   *  sanctioned way out of snapshot isolation. Writes through it still join the
   *  transaction's atomic commit; reads through it are deliberately fresh, so
   *  they never trip conflict detection. Off `transaction` it is just `s`. */
  readonly $live: S;
  /** Run effect(s) — `s.$do(schedule.after(...), own.set(...))` (alpha52).
   *  The effect channel: `return` is for VALUES, `$do` is for effects, so a
   *  method can do both in one call. Sync methods: captured and executed with
   *  the commit. Async methods: dispatched immediately (an `own.set` factory
   *  registers in the same tick). Returning effects still works through beta,
   *  with a one-time deprecation hint. */
  readonly $do: (
    effect: ScheduleEffect | OwnEffect,
    ...more: (ScheduleEffect | OwnEffect)[]
  ) => void;
};
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
  {
    resolve: (value: unknown) => void;
    reject: (e: Error) => void;
    /** The deadline timer, kept so a human wait can cancel it (see
     *  `pauseCallDeadlines`). Undefined for an explicitly unbounded call. */
    timer?: ReturnType<typeof setTimeout>;
    /** The half-way heartbeat timer (see `CEILING_HEARTBEAT_FRACTION`) —
     *  paused and re-armed with `timer`, cleared with it on settle. */
    heartbeat?: ReturnType<typeof setTimeout>;
    /** Arms the heartbeat for a fresh window — kept so a resume can re-arm. */
    armHeartbeat?: () => void;
    /** The ceiling this call was registered with — what a resume re-arms. */
    timeoutMs?: number;
    /** Fires the deadline rejection — kept so a resume can re-arm it. */
    expire?: () => void;
  }
>();

/** Options for call() — `timeoutMs` (the `...Ms` suffix every other duration
 *  in the API uses, matching `until({ timeoutMs })`), retries on failure.
 *  (alpha52: the long-deprecated `timeout` alias was REMOVED — passing it
 *  throws with the rename, never silently drops the timeout;
 *  `aiol --safe-fix` rewrites it.) */
export type CallOptions = {
  timeoutMs?: number;
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
  // alpha52: `timeout` (the pre-alpha alias) is REMOVED. Silently ignoring it
  // would drop a timeout the caller believes is armed — fail loud, with the
  // ONE registry-sourced message every removal surface prints.
  if ("timeout" in opts && (opts as { timeout?: unknown }).timeout != null) {
    throw new Error(removalMessage(removalOf("call({ timeout })")));
  }
  const timeoutMs = opts.timeoutMs;
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

// How long `await cell.method()` waits before it stops waiting.
//
// This was a hardcoded 30s whose error blamed a crashed executor — and that was
// almost never what happened. A method doing legitimately long work (an NFT
// scan, a chain query) blew the ceiling, the caller got told the executor had
// died, and the method KEPT RUNNING: its writes committed later, unannounced,
// on top of whatever the caller did next. Reporting a false cause while hiding
// the true state is the exact failure `.katana/errors.md` names, and it cost a
// production incident.
//
// It is also no longer a SECOND ceiling. `effectTimeoutMs` (and per-method
// `perfBudget.methods["cell:method"].timeout`) already governs how long an
// async effect may run; the caller-side wait now resolves from the same
// numbers, so raising the limit raises it everywhere — previously it raised the
// effect's and left this one at 30s, which is precisely the trap of a knob that
// looks like it worked.
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
let _callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS;
let _callTimeoutByMethod: Record<string, number> | undefined;
/** `perfBudget.methods[key].timeout: "warn"` — the ceiling REPORTS instead of
 *  rejecting: one `log.warn` at N ms naming the method and the elapsed time,
 *  and the caller keeps awaiting. The default stays reject. */
let _callWarnMethods = new Set<string>();

/** Point the caller-side wait at the app's configured effect timeouts.
 *  `0` (or a negative) means wait indefinitely; `"warn"` means warn at the
 *  default ceiling and keep waiting. Called at boot. */
export function _setCallTimeouts(
  defaultMs?: number,
  perMethod?: Record<string, number | "warn">,
): void {
  _callTimeoutMs = defaultMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const numeric: Record<string, number> = {};
  const warn = new Set<string>();
  for (const [k, v] of Object.entries(perMethod ?? {})) {
    if (v === "warn") warn.add(k);
    else numeric[k] = v;
  }
  _callTimeoutByMethod = perMethod ? numeric : undefined;
  _callWarnMethods = warn;
}

/** Restore the built-in default — test isolation. */
export function _resetCallTimeouts(): void {
  _callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS;
  _callTimeoutByMethod = undefined;
  _callWarnMethods = new Set();
  _longMethods.clear();
}

/** `cell:method` keys the CELL declared `long`. Registered at compose time, so
 *  the ceiling is lifted wherever the cell runs — including `testCell`, which
 *  never boots an app and therefore never sees `perfBudget`. A field report
 *  worked around exactly that gap by starting the method and polling `kind`
 *  instead of awaiting the call the test was about. */
const _longMethods = new Set<string>();

/** @internal — called by `composeCells` for every cell that declares `long`. */
export function _registerLongMethods(keys: readonly string[]): void {
  for (const k of keys) _longMethods.add(k);
}

/** Every `"cell:method"` the given cells declared `long`. Pure — the ONE
 *  decider both consumers read, so the caller-side wait and the effect
 *  tracker can never disagree about which methods are long. */
export function longMethodKeys(
  cells: readonly { __aio: { id: string; longMethods?: string[] } }[],
): string[] {
  return cells.flatMap((c) =>
    (c.__aio.longMethods ?? []).map((m) => `${c.__aio.id}:${m}`)
  );
}

/** Fold `long` into the effective `perfBudget.methods` as `timeout: 0`
 *  (unbounded), leaving any entry the app wrote ALONE — an explicit number is
 *  a decision, and silently replacing it with "no ceiling" would be the
 *  framework overruling the developer. Pure: returns a new budget. */
export function mergeLongIntoPerfBudget<
  B extends {
    methods?: Record<string, { effect?: number; timeout?: number | "warn" }>;
  },
>(
  budget: B | undefined,
  cells: readonly { __aio: { id: string; longMethods?: string[] } }[],
): B | undefined {
  const keys = longMethodKeys(cells);
  if (keys.length === 0) return budget;
  const methods = { ...(budget?.methods ?? {}) };
  for (const k of keys) {
    if (methods[k]?.timeout !== undefined) continue; // the app said a number
    methods[k] = { ...methods[k], timeout: 0 };
  }
  return { ...(budget ?? {} as B), methods } as B;
}

/** The resolved ceilings, for bridging into the page shell — the BROWSER side
 *  of `await cell.method()` must wait from the same numbers, or it invents its
 *  own (a hardcoded 15s used to fire first and blame the transport for a
 *  method that was simply still running). */
export function _getCallTimeouts(): {
  default: number;
  methods?: Record<string, number | "warn">;
} {
  // `"warn"` rides along: the browser must keep awaiting a warn-mode method
  // exactly as this process does, not reject it at the default ceiling.
  const warn: Record<string, "warn"> = {};
  for (const k of _callWarnMethods) warn[k] = "warn";
  const explicit = _callTimeoutByMethod || _callWarnMethods.size
    ? { ...(_callTimeoutByMethod ?? {}), ...warn }
    : undefined;
  // `long` folded in HERE, not only where the server assembles its config: the
  // browser must resolve the same ceiling this process enforces, and the
  // server bridge is not the only runtime that boots cells (the standalone
  // WebView/Android path and `bootCells` never touch it). Reading both sources
  // in the one function that answers "what does the client wait?" is what keeps
  // them from drifting. An explicit per-method number still wins.
  if (_longMethods.size === 0) {
    return { default: _callTimeoutMs, methods: explicit };
  }
  const methods: Record<string, number | "warn"> = {};
  for (const k of _longMethods) methods[k] = 0;
  return {
    default: _callTimeoutMs,
    methods: { ...methods, ...(explicit ?? {}) },
  };
}

/** The ceiling for one call, in ms. `<= 0` ⇒ no ceiling.
 *
 *  Precedence: an explicit `perfBudget.methods[key].timeout` beats the cell's
 *  `long` (a number the app WROTE outranks a blanket "no ceiling"), which beats
 *  the global default. */
export function callTimeoutFor(method?: string): number {
  const perMethod = method ? _callTimeoutByMethod?.[method] : undefined;
  if (perMethod !== undefined) return perMethod;
  if (method && _longMethods.has(method)) return 0;
  return _callTimeoutMs;
}

/** What the ceiling DOES when it is reached: `"reject"` (default) or
 *  `"warn"` — `perfBudget.methods[key].timeout: "warn"` keeps the caller
 *  waiting and reports once. A `long` method has no ceiling to reach. */
export function callTimeoutModeFor(method?: string): "reject" | "warn" {
  return method && _callWarnMethods.has(method) ? "warn" : "reject";
}

/** The one line that names the fix — shared by the reject and the warn text
 *  so the two can never disagree about what to do. */
function callCeilingFix(method: string, timeoutMs: number): string {
  const [cellName, name] = method.includes(":")
    ? method.split(":", 2)
    : ["cell", method];
  return `Fix: long: [${JSON.stringify(name)}] on cell(${
    JSON.stringify(cellName)
  }) (no ceiling), or perfBudget.methods[${
    JSON.stringify(method)
  }].timeout: "warn" (report at ${timeoutMs}ms, keep waiting) or a number ` +
    `(effectTimeoutMs raises the default for every method; 0 = forever). ` +
    `Under transaction: { serialize: true } the still-running method HOLDS ` +
    `the cell's mutex, so every later async call on it queues behind it ` +
    `and burns its own ceiling — one slow method cascades. Or fetch outside ` +
    `and commit with a sync reducer (docs/state/methods.md).`;
}

/** Where in its ceiling a call says "still running (slow)" — once, at info.
 *
 *  A wallet app's field ask: a chain query that takes 20s of a 30s ceiling is
 *  SLOW, and until the ceiling fires nothing distinguishes it from DEAD — the
 *  caller stares at a spinner and the log says nothing. One line at the
 *  half-way mark, naming cell:method and elapsed/deadline, is the difference
 *  between "it is working" and "is it working?". Info, not warn: slow is a
 *  fact, not a fault; the ceiling itself still warns or rejects as
 *  configured. Unbounded (`long`) calls have no deadline to be half-way to. */
export const CEILING_HEARTBEAT_FRACTION = 0.5;

/** Register a pending call — returns a Promise that resolves when resolveCall()
 *  is called. `method` ("cell:name") picks up any per-method override. */
export function registerCall(
  callId: string,
  method?: string,
): Promise<unknown> {
  const timeoutMs = callTimeoutFor(method);
  if (timeoutMs <= 0) {
    // Explicitly unbounded — the app said so.
    return new Promise((resolve, reject) => {
      _pending.set(callId, { resolve, reject });
    });
  }
  const label = method ?? "await cell.method()";
  const stillRunning = `The call gave up; the METHOD did not — it may still ` +
    `be running, and if it finishes its writes will still commit, without a ` +
    `return value reaching this caller.`;
  const mode = callTimeoutModeFor(method);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const expire = () => {
      if (!_pending.has(callId)) return;
      if (mode === "warn") {
        // `timeout: "warn"`: report ONCE, keep the registration — the caller
        // asked to be told, not abandoned. The timer is gone, so a pause /
        // resume finds nothing to re-arm (`timer` cleared below).
        const entry = _pending.get(callId)!;
        entry.timer = undefined;
        log.warn(
          `${label}: still running after ${
            Date.now() - started
          }ms (ceiling ${timeoutMs}ms, timeout: "warn") — the caller keeps ` +
            `waiting. Under transaction: { serialize: true } it also holds ` +
            `the cell's mutex until it settles.`,
        );
        return;
      }
      _pending.delete(callId);
      reject(
        new Error(
          `${label}: stopped waiting after ${timeoutMs}ms. ${stillRunning} ` +
            callCeilingFix(method ?? "cell:method", timeoutMs),
        ),
      );
    };
    const timer = setTimeout(expire, timeoutMs);
    // ONE heartbeat per call, however many times its window is re-armed
    // (a pause/resume restarts the clock; the line must not repeat).
    let beat = false;
    const armHeartbeat = () => {
      const entry = _pending.get(callId);
      if (!entry || beat) return;
      entry.heartbeat = setTimeout(() => {
        const e = _pending.get(callId);
        if (e) e.heartbeat = undefined;
        if (!e || beat) return;
        beat = true;
        log.info(
          "cell",
          `${label}: still running (slow) — ${Date.now() - started}ms of ` +
            `its ${timeoutMs}ms ceiling; not dead, still awaited` +
            (mode === "warn" ? ' (timeout: "warn" keeps waiting past it)' : ""),
        );
      }, Math.ceil(timeoutMs * CEILING_HEARTBEAT_FRACTION));
    };
    const settle = () => {
      clearTimeout(timer);
      const e = _pending.get(callId);
      if (e?.heartbeat !== undefined) clearTimeout(e.heartbeat);
    };
    _pending.set(callId, {
      // The timer is kept so a HUMAN WAIT can cancel it — see
      // `pauseCallDeadlines`.
      timer,
      timeoutMs,
      expire,
      armHeartbeat,
      resolve: (v) => {
        settle();
        resolve(v);
      },
      reject: (e) => {
        settle();
        reject(e);
      },
    });
    armHeartbeat();
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

/** Stop the clock on every in-flight call while a human is being waited on.
 *  Returns a RESUME that re-arms each surviving call with a fresh, full
 *  window.
 *
 *  A native file/directory picker blocks on a PERSON. Thirty seconds is a
 *  perfectly ordinary amount of time to spend finding a folder, and the call
 *  ceiling would cancel the pick out from under them — a field report hit
 *  exactly that and had to add `long: ["openKataFolder"]`, having copied an
 *  example that marks the hours-long render `long` and not the two methods
 *  that wait on a human. "Waiting on a dialog" is never "the app being slow",
 *  and it is a property of the PRIMITIVE, not of the method that calls it, so
 *  the primitive is where it belongs.
 *
 *  It pauses every pending deadline rather than only the calling method's:
 *  identifying the caller would need an ambient the picker does not have, and
 *  a modal dialog stops the user from advancing the others anyway. The resume
 *  is why this is a PAUSE and not an amnesty — without it, one dialog would
 *  permanently disarm the timeout of an unrelated method that genuinely hung,
 *  turning "rejected with a reason after 30s" into "hangs forever, silently".
 *  A fresh full window (rather than the remaining time) errs on the side the
 *  dialog already chose: the human was the delay, not the method. */
export function pauseCallDeadlines(): () => void {
  const paused: Array<{
    id: string;
    entry: {
      timer?: ReturnType<typeof setTimeout>;
      heartbeat?: ReturnType<typeof setTimeout>;
      armHeartbeat?: () => void;
      timeoutMs?: number;
      expire?: () => void;
    };
  }> = [];
  for (const [id, p] of _pending.entries()) {
    if (p.timer !== undefined && p.timeoutMs !== undefined && p.expire) {
      clearTimeout(p.timer);
      p.timer = undefined;
      // The heartbeat pauses with the deadline it is half of: a person at a
      // picker is not the method being slow.
      if (p.heartbeat !== undefined) {
        clearTimeout(p.heartbeat);
        p.heartbeat = undefined;
      }
      paused.push({ id, entry: p });
    }
  }
  return () => {
    for (const { id, entry } of paused) {
      // Settled while paused (no longer registered), or already re-armed by a
      // nested pause's resume: nothing to do. Skipping settled entries is
      // load-bearing — a timer armed for a finished call would be a garbage
      // wakeup that a test's op sanitizer rightly reports as a leak.
      if (_pending.get(id) !== entry || entry.timer !== undefined) continue;
      entry.timer = setTimeout(entry.expire!, entry.timeoutMs!);
      entry.armHeartbeat?.();
    }
  };
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

/** A mutation could not be applied because the tree it addresses is not the
 *  shape it was recorded against (a null/undefined parent, or an array op on
 *  something that is not an array).
 *
 *  `strict` is the difference between a PREVIEW and a COMMIT. The overlay
 *  replay is a preview — the same batch is replayed on every read, and a path
 *  that is not there yet may well be there by the time the batch commits — so
 *  it warns and carries on. The commit is the last word: dropping a write
 *  there and returning normally told the caller a change had landed that never
 *  did, which is the exact class `batcher.settled()` exists to kill (it only
 *  ever saw errors the dispatch REJECTED, and a warn is not a rejection). At
 *  the commit the drop throws, the reduce fails, the write-set is discarded
 *  and the method that made the write rejects — dev, prod and every harness
 *  alike. */
function _warnDroppedMutation(
  reason: string,
  m: Mutation,
  strict = false,
): void {
  const detail = { reason, path: m.path, op: m.op ?? null };
  const where = `path=${JSON.stringify(m.path)}${
    m.op ? `, op=${String(m.op)}` : ""
  }`;
  const msg = `[aio:cell] dropped mutation — ${reason} (${where})`;
  const hint = "An async-method mutation walked through a null/undefined " +
    "parent, or addressed a non-array with an array op. Initialize the " +
    "parent object/array in the cell's declared state, or guard the access " +
    "in the method.";
  diagEmit({
    type: "mutation-dropped",
    severity: strict ? "error" : "warning",
    source: "cell",
    message: msg,
    detail,
    hint,
  });
  if (!strict) {
    log.warn(msg);
    return;
  }
  throw new Error(
    `[aio:cell] a write was REFUSED at commit — ${reason} (${where}). ` +
      `The value never reached state, so the method that made it fails ` +
      `instead of resolving as if it had landed. ${hint}`,
  );
}

// ── Transactional conflict detection ───────────────────────────────────
//
// A transactional method reads a snapshot pinned at entry, so anything another
// method writes DURING an await is invisible to it. That is the feature (reads
// don't shift under you) and, unvalidated, also the bug: a read-modify-write
// commits over the newer value and nothing says so — a field report #1, where
// a balance refresh committed pre-send numbers and stamped them "confirmed".
//
// Databases solved this long ago, so we use their model rather than invent one:
//
//   transaction: true              → snapshot isolation. A write DERIVED from a
//                                    read of the same place (read-modify-write)
//                                    is validated at commit; if that path moved
//                                    since entry, the update would be lost.
//                                    Blind writes (`s.loading = false`) are
//                                    last-writer-wins by intent, never conflict.
//   transaction: {serialize: true} → serializable. Every read is validated too,
//                                    so a guard reading a field a SYNC method
//                                    writes mid-await can no longer be inert.
//
// Identity is the comparator: Immer's structural sharing keeps untouched
// subtrees referentially equal, so writes elsewhere cost nothing and a real
// change on a watched path is always caught.

const PATH_SEP = "\u0000";

/** Paths touched by one transactional method invocation. */
export type ReadWatch = {
  /** Paths read against the pinned snapshot. */
  reads: Set<string>;
  /** Paths written into the transaction's buffer. */
  writes: Set<string>;
};

export const createReadWatch = (): ReadWatch => ({
  reads: new Set(),
  writes: new Set(),
});

/** Path array → watch key. The one place the separator is spelled. */
export const watchKey = (path: readonly string[]): string =>
  path.join(PATH_SEP);

/** Same path, an ancestor, or a descendant of one in `set`. The empty key is
 *  the cell root — an ancestor of every path (the prefix test can't see that:
 *  `"" + SEP` prefixes nothing). */
function overlaps(path: string, set: Set<string>): boolean {
  if (set.has(path)) return true;
  if (path.length === 0) return set.size > 0;
  if (set.has("")) return true;
  for (const q of set) {
    if (path.startsWith(q + PATH_SEP) || q.startsWith(path + PATH_SEP)) {
      return true;
    }
  }
  return false;
}

/** A path segment that addresses an array slot by position. */
const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/;

const readPath = (key: string): string[] =>
  key.length === 0 ? [] : key.split(PATH_SEP);

/** The first path whose value moved between the state the method's reads are
 *  pinned to (`origin` — its entry snapshot, or the state its last `$commit()`
 *  produced) and live state, in a way that makes committing unsound — dotted,
 *  `""` for the cell root — or null while the transaction is still valid. Pure.
 *
 *  `origin` is always a REAL committed state object, never a locally rebuilt
 *  one: identity is the comparator, and a value we cloned and patched ourselves
 *  can never be identical to the one Immer commits, so passing one here reads
 *  every published container as somebody else's write. The executor's `rebase`
 *  is what keeps that invariant across `$commit`.
 *
 *  `strictReads` promotes snapshot isolation to serializable: every read is
 *  validated, not only the ones a write was derived from. */
export function conflictPath(
  origin: unknown,
  live: unknown,
  watch: ReadWatch,
  strictReads: boolean,
): string | null {
  if (origin === live) return null; // nothing committed since the epoch began
  const moved = (key: string) =>
    !Object.is(
      getNestedValue(origin, readPath(key)),
      getNestedValue(live, readPath(key)),
    );
  // Lost updates: a write whose value came from a read of the same place.
  for (const w of watch.writes) {
    if (!overlaps(w, watch.reads)) continue;
    if (moved(w)) return readPath(w).join(".");
  }
  // Re-addressed positions. An array index is a POSITION, not a name: `items.0`
  // means "whatever is first now", and a concurrent `unshift`/`splice`/`sort`
  // makes it name a different element. `moved(w)` cannot see that — it compares
  // the value AT the path, and `items.0.done` was `false` before the insert and
  // is `false` after, because it is a different element's `false`. Measured:
  // `s.items[0].done = true` marked the WRONG element under `transaction: true`
  // and under `{ serialize: true }` alike, and the caller was told `ok`. What
  // moved is the element the index resolves to, so that is what gets compared.
  //
  // Only arrays, and only positions the method actually traversed: an object
  // KEY is a stable name (`s.user.name` still means the same field however
  // `user` changed), so container traversal by key stays a blind write —
  // last-writer-wins by intent, exactly as documented.
  for (const w of watch.writes) {
    const seg = readPath(w);
    for (let i = 1; i < seg.length; i++) {
      const idx = seg[i]!;
      if (!ARRAY_INDEX.test(idx)) continue;
      const parent = seg.slice(0, i);
      if (!watch.reads.has(watchKey(parent))) continue;
      if (!Array.isArray(getNestedValue(origin, parent))) continue;
      const el = [...parent, idx];
      if (
        !Object.is(getNestedValue(origin, el), getNestedValue(live, el))
      ) {
        return el.join(".");
      }
    }
  }
  if (!strictReads) return null;
  // Serializable: a read that fed no write still decided something. Skip only
  // EXACT write matches (loop above validated that very path) — an overlap
  // skip would exempt a broad read (root enumeration, a container scan)
  // because one narrow descendant was written.
  for (const r of watch.reads) {
    if (watch.writes.has(r)) continue;
    if (moved(r)) return readPath(r).join(".");
  }
  return null;
}

export function getNestedValue(obj: unknown, path: string[]): unknown {
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
  strict: boolean,
): void {
  const path = m.path;
  if (path.length === 0) return;
  let current: unknown = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (current === null || current === undefined) {
      _warnDroppedMutation(
        `null intermediate at path[${i - 1}] for delete`,
        m,
        strict,
      );
      return;
    }
    current = (current as Record<string, unknown>)[path[i]!];
  }
  if (current === null || current === undefined) {
    _warnDroppedMutation(`null parent for delete leaf`, m, strict);
    return;
  }
  delete (current as Record<string, unknown>)[path[path.length - 1]!];
}

/** A recorded mutation payload must SURVIVE being applied — the same batch is
 *  replayed many times (every overlay recompute, the `$commit` local advance,
 *  the final reduce), so installing a recorded object by REFERENCE lets a later
 *  op in the batch mutate the recording itself through the applied tree:
 *  `s.nums = s.nums.filter(…); s.nums.shift()` shifted the RECORDED array once
 *  per replay and committed garbage (found by the sync/async differential
 *  fuzzer). Deep-clone on install; primitives pass through. */
function ownedValue(v: unknown): unknown {
  return v !== null && typeof v === "object" ? cloneState(v, "shallow") : v;
}

/** Identity through which a live proxy exposes its current underlying value. */
export const LIVE_RAW = Symbol("aio.liveRaw");

/** Turn a value that may CONTAIN live proxies into plain data, at record time.
 *
 *  `s.obj = { ...s.obj }` copies nested object fields as their nested PROXIES;
 *  recording those by reference used to poison the overlay (a leaked proxy at
 *  the wrong path reads itself — unbounded recursion; found by the sync/async
 *  differential fuzzer). Each proxy resolves to its current underlying value
 *  via LIVE_RAW — the same semantics Immer gives nested drafts assigned back
 *  into a draft. Plain subtrees are returned UNTOUCHED (same reference): a
 *  method that assigns an array and keeps mutating its local reference sees
 *  those later mutations committed, exactly like the Immer draft;
 *  `ownedValue` still clones at apply time so replays stay safe. */
export function materializeValue(v: unknown): unknown {
  // ONE object reached through two proxies must materialize to ONE clone.
  // `s.items.fill(o)` puts the same object at every index (plain JS, and Immer
  // does the same on a draft), so `[...s.items]` is an array of two proxies
  // over one raw object. Cloning each proxy independently silently DE-ALIASED
  // it: a later `delete s.items[0].q` then changed one slot where plain JS and
  // the identical sync method change both. Memoized by the RAW object, so
  // within one recorded value the alias survives — `ownedValue`'s
  // structuredClone at apply time preserves internal aliasing too. Allocated
  // lazily: a write with no proxy inside it costs nothing.
  let memo: Map<object, unknown> | null = null;
  const walk = (x: unknown): unknown => {
    if (x === null || typeof x !== "object") return x;
    const raw = (x as Record<symbol, unknown>)[LIVE_RAW];
    if (raw !== undefined) {
      if (raw === null || typeof raw !== "object") return raw;
      memo ??= new Map();
      const hit = memo.get(raw as object);
      if (hit !== undefined) return hit;
      const clone = cloneState(raw, "shallow");
      memo.set(raw as object, clone);
      return clone;
    }
    if (Array.isArray(x)) {
      let out: unknown[] | null = null;
      for (let i = 0; i < x.length; i++) {
        const m = walk(x[i]);
        if (m !== x[i] && out === null) out = x.slice();
        if (out !== null) out[i] = m;
      }
      return out ?? x;
    }
    let outObj: Record<string, unknown> | null = null;
    for (const k of Object.keys(x as Record<string, unknown>)) {
      const cur = (x as Record<string, unknown>)[k];
      const m = walk(cur);
      if (m !== cur && outObj === null) {
        outObj = { ...(x as Record<string, unknown>) };
      }
      if (outObj !== null) outObj[k] = m;
    }
    return outObj ?? x;
  };
  return walk(v);
}

function setNestedValue(
  obj: Record<string, unknown>,
  m: Mutation,
  strict: boolean,
): void {
  const path = m.path;
  if (path.length === 0) return;
  let current: unknown = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (current === null || current === undefined) {
      _warnDroppedMutation(
        `null intermediate at path[${i - 1}] for set`,
        m,
        strict,
      );
      return;
    }
    current = (current as Record<string, unknown>)[path[i]!];
  }
  if (current === null || current === undefined) {
    _warnDroppedMutation(`null parent for set leaf`, m, strict);
    return;
  }
  (current as Record<string, unknown>)[path[path.length - 1]!] = ownedValue(
    m.value,
  );
}

function applyArrayOp(
  obj: Record<string, unknown>,
  m: Mutation,
  strict: boolean,
): void {
  const arr = m.path.length === 0 ? obj : getNestedValue(obj, m.path);
  if (!Array.isArray(arr)) {
    _warnDroppedMutation(
      `target at path is not an array (op=${m.op})`,
      m,
      strict,
    );
    return;
  }
  // Args cloned for the same reason as set values: a pushed object enters the
  // applied tree, and a later op addressing it by path would mutate the
  // RECORDING, corrupting every subsequent replay.
  // deno-lint-ignore no-explicit-any
  (arr as any)[m.op as string](...(m.args ?? []).map(ownedValue));
}

/** Apply a batch of mutations (set, delete, array ops) to a state object.
 *  Hard-rejects mutations with banned-key paths or unknown array ops to
 *  prevent prototype pollution and sandbox-escape from network-sourced payloads. */
export function applyMutations(
  s: Record<string, unknown>,
  mutations: Mutation[],
  /** `true` at the COMMIT (the `__set` reduce), where a write that cannot be
   *  applied must FAIL the method rather than be warned about and skipped.
   *  Left `false` for the read-your-writes overlay, which is a preview. */
  strict = false,
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
      deleteNestedKey(s, m, strict);
    } else if (m.op !== undefined) {
      if (typeof m.op !== "string" || !ARRAY_MUTATORS.has(m.op)) {
        _rejectUnsafeMutation(
          `unsupported array op "${String(m.op)}" — only ${
            [...ARRAY_MUTATORS].join("/")
          } are allowed`,
          m,
        );
      }
      applyArrayOp(s, m, strict);
    } else {
      setNestedValue(s, m, strict);
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
export function createBatcher(
  prefix: string,
  // Returns whatever `app.dispatch` returns: a promise that REJECTS when the
  // write-set was refused (see `settled()` — dropping that rejection is how a
  // discarded write became invisible to the method that made it).
  dispatch: (action: Msg) => unknown,
  // Transactional methods: buffer every mutation across the whole
  // method — no microtask/method-change auto-flush — and commit ONCE via an
  // explicit flush() at method return. This is what makes an `await` NOT a
  // commit point: nothing is dispatched until the transaction settles.
  opts: { deferred?: boolean } = {},
) {
  const batch: BatchState = { mutations: [], scheduled: false, method: "" };
  const deferred = opts.deferred === true;
  // Every dispatched write-set, and the first refusal among them. A write the
  // store rejects (most often `s.x = {...s.x}` — a proxy-derived value assigned
  // back into state) makes `app.dispatch` reject; without this the rejection was
  // dropped on the floor and the async method that made the write RESOLVED, so
  // the caller was told a change had been applied that never was.
  const inflight: Promise<unknown>[] = [];
  let firstError: unknown = null;
  // Set once the call that owns this batcher has settled. A write after that
  // point comes from a callback that outlived the method — `setTimeout`, an
  // event listener, a `.then` nobody awaited — and used to COMMIT: persisted,
  // broadcast, `ok: true`, not a line in any log. Immer revokes a sync
  // method's draft at the same moment; the async view refused nothing.
  let closed = false;

  function add(method: string, mutation: Mutation): void {
    if (closed) {
      const at = mutation.path.length ? `s.${mutation.path.join(".")}` : "s";
      const msg =
        `[${prefix}:${method}] write after the method finished: ${at} was ` +
        `assigned from a callback that outlived ${method}(). An async ` +
        `method's state view is live only until its promise settles — await ` +
        `the work inside ${method}(), or dispatch a method from the callback.`;
      log.error("cell", msg);
      throw new Error(msg);
    }
    // Different method → flush previous batch immediately so mutations
    // are never misattributed (AIO-77). Deferred: keep accumulating.
    if (!deferred && batch.mutations.length > 0 && batch.method !== method) {
      flush();
    }
    batch.mutations.push(mutation);
    batch.method = method;
    if (!deferred && !batch.scheduled) {
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
    const r = dispatch(markInflight({
      // Sourced, because a write-set IS an effect result: it is the only way an
      // async method publishes anything. Flagged in-flight, because shutdown's
      // drain admits exactly this — a running method finishing its work — and
      // refuses a scheduled tick or a late client action (dispatch.ts
      // INFLIGHT).
      _source: "Effect",
      type: `${prefix}:${setKey(method)}`,
      payload: { mutations, _origin: method },
    }) as Msg);
    if (r && typeof (r as Promise<unknown>).then === "function") {
      inflight.push(
        (r as Promise<unknown>).catch((e) => {
          if (firstError === null) firstError = e;
        }),
      );
    }
  }

  /** Drop the buffered write-set without dispatching (transaction abort). */
  function discard(): void {
    batch.mutations = [];
    batch.scheduled = false;
    batch.method = "";
  }

  return {
    add,
    /** The owning call has settled: every later write is refused by name. */
    close: () => {
      closed = true;
    },
    /** Unflushed mutations of the current batch — the live proxy overlays
     *  these on reads (read-your-writes). */
    pending: () => batch.mutations,
    /** Commit the buffered write-set as one atomic `__set` (transactional). */
    flush,
    /** Discard the buffered write-set (transactional abort). */
    discard,
    /** Await every write-set this batcher dispatched and rethrow the first one
     *  the store refused. Called at async-method return, so a refused write
     *  fails the method that made it instead of resolving as if it had landed.
     *  Dev, prod and every test harness alike — silence here was the single
     *  costliest bug in one field report. */
    async settled(): Promise<void> {
      while (inflight.length > 0) await Promise.all(inflight.splice(0));
      if (firstError !== null) {
        const e = firstError;
        firstError = null;
        throw e;
      }
    },
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

/** Array read methods (non-mutating) intercepted on the live proxy so they run
 *  against LIVE elements — see {@linkcode ARRAY_SNAPSHOT_READ_METHODS} for the
 *  three stringifying exceptions. Mutators remain in ARRAY_MUTATORS and are
 *  handled separately. */
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

/** Array read methods that must run against a detached SNAPSHOT instead of
 *  live element proxies — the ONLY exceptions to the rule below.
 *
 *  Each stringifies every element, and `String(proxy)` throws the canonical
 *  "not supported on live async state" error where an Immer draft yields
 *  "[object Object]". A loud throw here would be a divergence the sync side
 *  never has, so these three stay on plain data.
 *
 *  Everything ELSE in {@linkcode ARRAY_READ_METHODS} runs against live
 *  elements. That was not always true, and the gap was the framework's worst
 *  remaining silent divergence: `map`/`filter`/`slice`/… handed back DETACHED
 *  clones, so
 *
 *      const rows = s.items.filter(r => r.on);   // async method
 *      for (const r of rows) r.q = 0;            // ← silently did NOTHING
 *
 *  while the identical SYNC body (an Immer draft, whose `filter` yields
 *  drafts) updated every row. A field report from a production consumer
 *  distilled it into a memorized law — "mutate in ONE contiguous block, writes
 *  interleaved between awaits drop" — which is not what was happening at all;
 *  they had simply learned to avoid the shape that dropped. A rule invented to
 *  route around a silent bug is the most expensive kind of documentation.
 *
 *  Running live also fixes identity: `s.items.indexOf(s.items[0])` is `0` on
 *  the Immer draft and was `-1` through the snapshot. */
const ARRAY_SNAPSHOT_READ_METHODS = new Set([
  "join",
  "toString",
  "toLocaleString",
]);

/** Snapshot a value for read-method interception — the shared cloneState
 *  ladder with the `"shallow"` last rung: never returns the live value by
 *  reference (an identity fallback would let a `.map()`/`.find()` over the
 *  "snapshot" silently mutate real state — the Immer-alias bug class
 *  immutable.ts exists to kill). */
export function snapshotForRead(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  return cloneState(value, "shallow");
}

// ── Stale-capture detection (R-1, a remote-desktop report) ──────────────────────────
//
// In a SYNC method a captured reference keeps the old object:
//   const req = s.pending; s.pending = null; req.sid   // still "s1"
// The async live proxy is a PATH view, so the identical code resolves through
// `pending` to the NEW value — null (TypeError) or, worse, a replaced object
// (silent wrong data). The two flavours cannot agree here by construction: the
// proxy re-resolves its path on purpose (read-your-writes + surviving
// `$commit`'s re-snapshot), so it cannot also pin object identity. What it CAN
// do is refuse loudly: every proxy remembers the ledger length at its creation
// ("birth"), every container overwrite this invocation makes is appended to a
// shared ledger, and any use of a proxy whose container was overwritten AFTER
// its birth throws a named error. A fresh re-fetch through the parent after
// the overwrite creates a NEW proxy (the cache entry is lazily replaced), so
// `s.obj = {…}; s.obj.nest.v = 1` keeps working — only HELD references trip.
type StaleLedger = {
  log: Array<{
    /** Joined path of the overwritten container. */
    p: string;
    /** For index-moving array mutators: first affected index… */
    from?: number;
    /** …and last (inclusive); undefined = to the end. */
    to?: number;
  }>;
  /** Per-invocation memo of built live-array views, keyed by path — see the
   *  array read-method interception. Lives here because the ledger is already
   *  the one object threaded through every proxy of one method call, and its
   *  `log.length` is exactly the invalidation cursor the memo checks. */
  live?: Map<string, { src: unknown[]; live: unknown[]; birth: number }>;
};

/** Array mutators that re-address existing indexes — a captured element proxy
 *  would silently start reading a DIFFERENT element. `push` is exempt: it
 *  never moves what already exists. */
const INDEX_MOVING_MUTATORS = new Set([
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
]);

/** Normalize a possibly-negative array index argument. */
function normIdx(v: unknown, len: number): number {
  let n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) n = 0;
  if (n < 0) n = Math.max(len + n, 0);
  return Math.min(n, len);
}

/** The ledger entry (birth-onward) that overwrote this proxy's container, or
 *  null. An entry hits when it names this path or an ancestor of it; entries
 *  with `from` (index-moving mutators) hit only strict descendants whose
 *  element index falls in [from, to]. */
function staleHit(
  pathKey: string,
  birth: number,
  ledger: StaleLedger,
): { p: string } | null {
  const log = ledger.log;
  for (let i = birth; i < log.length; i++) {
    const e = log[i]!;
    if (e.from === undefined) {
      if (pathKey === e.p || pathKey.startsWith(e.p + PATH_SEP)) return e;
      continue;
    }
    if (pathKey.length <= e.p.length || !pathKey.startsWith(e.p + PATH_SEP)) {
      continue;
    }
    const rest = pathKey.slice(e.p.length + 1);
    const cut = rest.indexOf(PATH_SEP);
    const idx = Number(cut === -1 ? rest : rest.slice(0, cut));
    if (Number.isInteger(idx) && idx >= e.from && idx <= (e.to ?? Infinity)) {
      return e;
    }
  }
  return null;
}

/** Throw the named stale-capture error (get/set/has/keys on a reference that
 *  predates this method's overwrite of its container). */
function throwStaleCapture(
  cellName: string,
  methodName: string,
  pathKey: string,
  overwrittenKey: string,
): never {
  const ref = "s." + pathKey.split(PATH_SEP).join(".");
  const ow = "s." + overwrittenKey.split(PATH_SEP).join(".");
  throw new Error(
    `[${cellName}:${methodName}] stale reference: this value was captured from ${ref} before the method overwrote ${ow}. ` +
      `In an async method \`s\` is a live view — the old reference would silently resolve to the NEW value ` +
      `(a sync method keeps the old object). Copy what you need before overwriting ` +
      `(const x = ${ref}?.field) or snapshot first (const v = { ...${ref} }).`,
  );
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
  // The proxy only reads pending writes + records new ones — flush/discard are
  // the executor's concern, so keep the param structural (test mocks + the
  // transactional path both satisfy it).
  batcher: Pick<ReturnType<typeof createBatcher>, "add" | "pending">,
  path: string[] = [],
  // Cache values carry the proxy AND its birth cursor so a re-fetch after an
  // overwrite can detect the entry is stale and rebuild (see StaleLedger).
  _proxyCache: Map<string, { px: unknown; birth: number }> = new Map(),
  _overlay: OverlayBox = { v: null },
  // Cancellation signal for this call (cancelOn / s.$signal — perfect-aio D1).
  _signal?: AbortSignal,
  // Transactional mid-method publish: `s.$commit()` flushes the
  // buffered write-set atomically and re-snapshots. Root-level only; undefined
  // for non-transactional methods.
  _commit?: (minMs?: number) => void,
  // Read/write recorder for snapshot-isolation conflict detection. Set only for
  // transactional methods (whose reads are pinned and therefore go stale);
  // undefined ⇒ zero overhead on the live path.
  _watch?: ReadWatch,
  // `s.$live` — a sibling proxy whose reads resolve CURRENT state instead of the
  // pinned snapshot, sharing this batcher so writes still commit atomically.
  // Root-level only; its reads are deliberately fresh, so they are not watched.
  _live?: () => S,
  // `s.$do(effect, ...)` — the effect channel (alpha52). Root-level only; the
  // executor wires it to an immediate `__effects` dispatch so an own.set
  // factory is consumed in the same tick.
  _do?: (...effects: unknown[]) => void,
  // Stale-capture detection: shared per-invocation overwrite ledger + this
  // proxy's birth cursor into it. Defaults create the ledger at the root; the
  // recursion threads it through.
  _stale: StaleLedger = { log: [] },
  _birth = 0,
): S {
  const pathKey = path.join(PATH_SEP);
  const _liveArrays = (_stale.live ??= new Map());
  const noteRead = _watch ? (k: string) => _watch.reads.add(k) : undefined;
  const noteWrite = _watch ? (k: string) => _watch.writes.add(k) : undefined;
  /** Throw if this proxy's container was overwritten after its creation. The
   *  root can never be stale, and the length check makes the common case free. */
  const assertFresh = (): void => {
    if (path.length === 0 || _stale.log.length <= _birth) return;
    const hit = staleHit(pathKey, _birth, _stale);
    if (hit) throwStaleCapture(cellName, methodName, pathKey, hit.p);
  };
  /** Record a container overwrite — only when a proxy could already exist at
   *  or below the written path (every proxy's ancestors are cached by
   *  construction, so an O(1) exact-key check covers descendants too). Leaf
   *  scalar writes therefore never grow the ledger. */
  const noteOverwrite = (writeKey: string): void => {
    if (_proxyCache.has(writeKey)) _stale.log.push({ p: writeKey });
  };
  /** Fetch a nested proxy through the cache, rebuilding it when the cached one
   *  predates an overwrite of its container — a fresh fetch through the parent
   *  is a NEW capture and must stay legal. */
  const nestedProxy = (childKey: string, cacheKey: string): unknown => {
    // `childKey`, not the built path: every call site's child is this proxy's
    // own `path` plus one key, and the array is only NEEDED when the cache
    // misses. Building it eagerly cost one 10k-element allocation storm per
    // array read method — `s.items.reduce(...)` allocated ten thousand arrays
    // to look ten thousand entries up in a Map, and then threw them away.
    let cached = _proxyCache.get(cacheKey);
    if (
      cached && _stale.log.length > cached.birth &&
      staleHit(cacheKey, cached.birth, _stale)
    ) {
      cached = undefined;
    }
    if (!cached) {
      cached = {
        px: createLiveProxy(
          cellName,
          prefix,
          methodName,
          getState,
          batcher,
          [...path, childKey],
          _proxyCache,
          _overlay,
          undefined,
          undefined,
          _watch,
          undefined,
          undefined,
          _stale,
          _stale.log.length,
        ),
        birth: _stale.log.length,
      };
      _proxyCache.set(cacheKey, cached);
    }
    return cached.px;
  };
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
        // Materialization hook (LIVE_RAW): hands out the proxy's CURRENT
        // underlying value so a write of a proxy-derived structure can be
        // recorded as plain data — see materializeValue.
        if (prop === LIVE_RAW) {
          // Materializing a stale reference into a write is the same silent
          // wrong data — refuse at the write site.
          assertFresh();
          return effectiveAt();
        }
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
          assertFresh();
          const fresh = effectiveAt();
          if (Array.isArray(fresh)) {
            noteRead?.(pathKey);
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
      // Held reference across this method's own overwrite of its container —
      // named error instead of a silent read of the NEW value (R-1).
      assertFresh();
      // `s.$signal` — the call's AbortSignal (aborts when a cancelOn trigger
      // fires). A never-aborting fallback keeps `s.$signal.aborted` safe in
      // sync methods / contexts without cancellation.
      if (key === "$signal") {
        return _signal ?? _neverSignal();
      }
      // Transactional mid-method publish (root-level; no-op off the flag).
      if (key === "$commit" && path.length === 0) {
        return _commit ?? (() => {});
      }
      // `s.$live` — escape hatch out of snapshot isolation: read the world as it
      // is NOW (after an await), deliberately and visibly. Outside a
      // transactional method it is the same proxy, so the spelling is portable.
      if (key === "$live" && path.length === 0) {
        return _live ? _live() : receiver;
      }
      // `s.$do(effect, ...)` — the effect channel (alpha52). Root-level only,
      // like $commit/$live.
      if (key === "$do" && path.length === 0 && _do) {
        return _do;
      }
      const fresh = effectiveAt();
      const value = (fresh as Record<string, unknown>)[key];

      // Array method interception — read methods
      if (
        Array.isArray(fresh) && ARRAY_READ_METHODS.has(key) &&
        typeof value === "function"
      ) {
        // Read methods run against the LIVE elements — `[...receiver]` reuses
        // the iterator trap, which resolves each element through indexed
        // access, so every element the method hands back (to a callback, or in
        // a rebuilt array) is the SAME live proxy `s.items[i]` gives. A write
        // through one therefore batches exactly like `s.items[i].q = 0`, which
        // is what the Immer draft does on the sync side.
        if (!ARRAY_SNAPSHOT_READ_METHODS.has(key)) {
          return (...args: unknown[]) => {
            // The whole array feeds the result — watch it as one read.
            noteRead?.(pathKey);
            // Built directly from `fresh` rather than spreading `receiver`:
            // the spread resolves EVERY index through the get trap, and each
            // of those re-runs effectiveAt() (a root resolve + path walk).
            // Over a 10k-element array that doubled the framework's own
            // `proxy-array-10k` benchmark. Semantics are identical by
            // construction — a primitive is handed out raw and an object as
            // the SAME cached child proxy `receiver[i]` would return, so a
            // write through an element still batches like `s.items[i].q = 0`.
            const arr = fresh as unknown[];
            // MEMO. `rows.filter(...).map(...)`, or two reads in a row with no
            // write between them, rebuilt the whole live view each time — for
            // a 10k array that is 10k key strings and 10k Map lookups to hand
            // back the identical proxies.
            //
            // Reused only when BOTH are true, and both are conservative:
            //   • the underlying array is the SAME object, so the elements and
            //     their indices cannot have changed; and
            //   • the stale log has not grown by even one entry, so nothing
            //     anywhere has invalidated a child proxy.
            // Either one different ⇒ rebuild. It can be too cautious (a write
            // to an unrelated path busts it); it cannot be wrong.
            const memo = _liveArrays.get(pathKey);
            let live: unknown[];
            if (memo && memo.src === arr && memo.birth === _stale.log.length) {
              live = memo.live;
            } else {
              live = new Array(arr.length);
              // Hoisted: the parent half of every child's cache key is the
              // same string for all N elements, so concatenating it inside the
              // loop rebuilt it ten thousand times.
              const childPrefix = pathKey + PATH_SEP;
              for (let i = 0; i < arr.length; i++) {
                const el = arr[i];
                if (el === null || typeof el !== "object") {
                  live[i] = el;
                  continue;
                }
                const idx = String(i);
                live[i] = nestedProxy(
                  idx,
                  path.length === 0 ? idx : childPrefix + idx,
                );
              }
              _liveArrays.set(pathKey, {
                src: arr,
                live,
                birth: _stale.log.length,
              });
            }
            // deno-lint-ignore no-explicit-any
            return (live as any)[key](...args);
          };
        }
        return (...args: unknown[]) => {
          noteRead?.(pathKey);
          // Stringifying methods only — see ARRAY_SNAPSHOT_READ_METHODS.
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
          noteWrite?.(pathKey);
          batcher.add(methodName, {
            path: [...path],
            op: key,
            args: args.map(materializeValue),
          });
          // Index-moving mutators re-address existing elements — a captured
          // element proxy would silently read a DIFFERENT element afterwards.
          if (INDEX_MOVING_MUTATORS.has(key)) {
            const len = (fresh as unknown[]).length;
            let from = 0;
            let to: number | undefined;
            if (key === "pop") from = Math.max(len - 1, 0);
            else if (key === "splice") from = normIdx(args[0] ?? 0, len);
            else if (key === "fill") {
              from = normIdx(args[1] ?? 0, len);
              to = normIdx(args[2] ?? len, len) - 1;
            } else if (key === "copyWithin") {
              const t = normIdx(args[0] ?? 0, len);
              const st = normIdx(args[1] ?? 0, len);
              const en = normIdx(args[2] ?? len, len);
              from = t;
              to = t + Math.max(en - st, 0) - 1;
            }
            _stale.log.push({ p: pathKey, from, to });
          }
          return result;
        };
      }

      // Nested object/array — return cached nested proxy (rebuilt when the
      // cached one predates an overwrite of this path — a fresh fetch is a
      // NEW capture).
      if (value !== null && typeof value === "object") {
        const childKey = path.length === 0 ? key : pathKey + PATH_SEP + key;
        // Traversing INTO a container is a read of that container, and it was
        // not recorded — this branch returned before `noteRead` ever ran. So
        // `s.items[0].done = true` recorded a write at `items.0.done` and no
        // read at all: `conflictPath` only validates writes that overlap a
        // read, so there was nothing to check, and `strictReads` validated an
        // EMPTY read set. Measured against a concurrent `unshift`: the wrong
        // element was marked done under `transaction: true` AND under
        // `{ serialize: true }`, and the caller was told `ok`. Which element
        // `items[0]` names is a fact this method depends on; depending on it
        // is a read.
        noteRead?.(childKey);
        return nestedProxy(key, childKey);
      }

      // AIO-4.3: any other function value on a non-array is a usage we
      // don't support. Throw the canonical "live async state" error so
      // users get an actionable message rather than silent wrong data.
      if (typeof value === "function" && !Array.isArray(fresh)) {
        throwLiveStateError(cellName, methodName, `${key}()`);
      }

      // A leaf read — the value the method actually reasons about.
      noteRead?.(path.length === 0 ? key : pathKey + PATH_SEP + key);
      return value;
    },

    set(_target, prop, value) {
      if (typeof prop === "symbol") return false;
      assertFresh();
      noteWrite?.(path.length === 0 ? prop : pathKey + PATH_SEP + prop);
      batcher.add(methodName, {
        path: [...path, prop as string],
        value: materializeValue(value),
      });
      noteOverwrite(path.length === 0 ? prop : pathKey + PATH_SEP + prop);
      return true;
    },

    // AIO-240: intercept `delete` so property removal is batched as a mutation
    deleteProperty(_target, prop) {
      if (typeof prop === "symbol") return false;
      assertFresh();
      noteWrite?.(path.length === 0 ? prop : pathKey + PATH_SEP + prop);
      batcher.add(methodName, {
        path: [...path, prop as string],
        value: undefined,
        op: "delete",
      });
      noteOverwrite(path.length === 0 ? prop : pathKey + PATH_SEP + prop);
      return true;
    },

    has(_target, prop) {
      if (typeof prop === "symbol") return false;
      assertFresh();
      // `"x" in s` reads x's existence — record the probed path, not the whole
      // container, so only a change AT x conflicts.
      noteRead?.(
        path.length === 0 ? String(prop) : pathKey + PATH_SEP + String(prop),
      );
      const fresh = effectiveAt();
      if (fresh === null || fresh === undefined) return false; // AIO-232
      return prop in (fresh as object);
    },

    ownKeys() {
      assertFresh();
      noteRead?.(pathKey);
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
      assertFresh();
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

// ── Sync-draft $do wrapper (alpha52 — the effect channel) ──────────
//
// Sync methods run on a raw Immer draft, which has no interception seam of its
// own (defineProperty on a draft throws), so `s.$do` is served by a thin
// forwarding Proxy installed at invocation. Every other trap forwards straight
// to the draft — writes, deletes, key walks and nested reads behave EXACTLY as
// on the bare draft (the sync/async parity fuzzer pins this).

/** Identity through which the wrapper exposes the underlying draft — so
 *  `return s` still resolves to the real draft (snapshotReturn needs isDraft
 *  to see it). @internal */
export const DRAFT_DO_TARGET = Symbol("aio.draftDoTarget");

/** Wrap a sync-method draft so `s.$do(...)` exists. @internal */
export function withDraftDo<S extends object>(
  draft: S,
  doFn: (...effects: unknown[]) => void,
): S {
  return new Proxy(draft, {
    get(t, p, _r) {
      if (p === "$do") return doFn;
      if (p === DRAFT_DO_TARGET) return t;
      // Receiver = the draft itself: Immer's internal getters must see their
      // own proxy, never this wrapper.
      return Reflect.get(t, p, t);
    },
    set: (t, p, v) => Reflect.set(t, p, v, t),
    has: (t, p) => p === "$do" || Reflect.has(t, p),
    deleteProperty: (t, p) => Reflect.deleteProperty(t, p),
    ownKeys: (t) => Reflect.ownKeys(t),
    getOwnPropertyDescriptor: (t, p) => Reflect.getOwnPropertyDescriptor(t, p),
    defineProperty: (t, p, d) => Reflect.defineProperty(t, p, d),
    getPrototypeOf: (t) => Reflect.getPrototypeOf(t),
    setPrototypeOf: (t, proto) => Reflect.setPrototypeOf(t, proto),
    isExtensible: (t) => Reflect.isExtensible(t),
    preventExtensions: (t) => Reflect.preventExtensions(t),
  });
}

/** The draft behind a `withDraftDo` wrapper, or the value itself. @internal */
export function unwrapDraftDo(v: unknown): unknown {
  if (v !== null && typeof v === "object") {
    const t = (v as Record<symbol, unknown>)[DRAFT_DO_TARGET];
    if (t !== undefined) return t;
  }
  return v;
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
