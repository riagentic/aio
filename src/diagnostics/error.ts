// ─── AioError Core — Types, Factory, Formatter, Reporter ─────────────────────

import type { DiagnosticEvent } from "./diagnostic-bus.ts";
import { randomUuid } from "../rand.ts";
import { log } from "./logger-api.ts";
import {
  indent,
  mark,
  stack,
  type Style,
  style,
  termWidth,
  type Tone,
  wrap,
} from "./fmt.ts";
import { frozenWriteMessage, isFrozenWriteError } from "../state/immutable.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Discriminated error code — identifies the specific failure class (e.g. `'REDUCE_ERROR'`, `'EFFECT_TIMEOUT'`). */
export type AioErrorCode =
  | "REDUCE_ERROR"
  | "EFFECT_ERROR"
  | "EFFECT_TIMEOUT"
  | "EFFECT_ASYNC_ERROR"
  | "HOOK_ERROR"
  | "INIT_ERROR"
  | "DESTROY_ERROR"
  | "QUEUE_OVERFLOW"
  | "DISPATCH_LOOP"
  | "DISPATCH_CLOSED"
  | "DISPATCH_DRAINING"
  | "DISPATCH_ABORTED"
  | "MEMORY_PRESSURE"
  | "MEMORY_CRITICAL"
  | "BUDGET_REDUCE"
  | "BUDGET_EFFECT"
  | "PERSIST_ERROR"
  | "PERSIST_SCHEMA"
  | "TX_CONFLICT"
  // ── The two NETWORK-facing codes (alpha76) ──────────────────────────────
  // These are the ones an APP branches on, and they are the reason the wire
  // carries a code at all: a call that crossed a transport can fail three
  // ways — the gate refused it, the server took it and changed nothing, or
  // the app's own method threw — and only the third is the app's own bug.
  // Told apart by message text, they were not told apart at all.
  /** The `access:` gate (cell) or `{ access }` (serverFn) refused this call
   *  for this caller. Reaches the caller as `err.code`; read it with
   *  `errorCode(err)` from `aio`. */
  | "ACCESS_DENIED"
  /** The action reached the server and applied NOTHING — a method the cell no
   *  longer has, a cell that was never booted, a disabled cell, a `validate`
   *  refusal. Distinct from `ACCESS_DENIED` (allowed, but did nothing) and
   *  from an app throw (which carries no code). */
  | "ACTION_REFUSED"
  // ── Reserved: named by the union, not currently EMITTED ─────────────────
  // Kept because removing a public union member is a breaking change and
  // this union is frozen at beta1. `MACHINE_BLOCKED` belonged to the
  // `machine:` cell key, removed in alpha27 (src/state/removals-core.ts) —
  // a guarded action now reports as the `action-guarded` diagnostic event.
  // The three vitals codes report through the diagnostic bus
  // (`src/vitals/`), which is where a threshold breach belongs: it is an
  // observation about the process, not a failure of one call. Nothing
  // constructs any of the four; do not write a `catch` that waits for them.
  // Pinned by tests/error-code-emission.test.ts, which fails the moment one
  // of them gains (or loses) a call site, so this comment cannot go stale.
  /** @deprecated Never emitted since alpha27 — the `machine:` cell key it
   *  belonged to was removed. Kept only so the union stays source-compatible
   *  to 1.0. */
  | "MACHINE_BLOCKED"
  /** @deprecated Never emitted — the UI-freeze threshold reports on the
   *  diagnostic bus (`src/vitals/`), not as an `AioError`. */
  | "UI_FREEZE"
  /** @deprecated Never emitted — transport stalls report on the diagnostic
   *  bus (`src/vitals/`), not as an `AioError`. */
  | "TRANSPORT_STALL"
  /** @deprecated Never emitted — loop saturation reports on the diagnostic
   *  bus (`src/vitals/`), not as an `AioError`. */
  | "LOOP_SATURATED";

/** Origin subsystem that raised the error — `'reduce'`, `'effect'`, `'vitals'`, etc. */
export type AioErrorSource =
  | "reduce"
  | "effect"
  | "hook"
  | "init"
  | "destroy"
  | "memory"
  | "dispatch"
  /** The network-access gate — `ACCESS_DENIED`. */
  | "access"
  /** @deprecated The source of `MACHINE_BLOCKED`, never produced since
   *  alpha27 (see {@linkcode AioErrorCode}). */
  | "machine"
  | "vitals"
  | "persist";

/** Structured context attached to every `AioError` — cell name, action type, timing, etc. */
export type AioErrorContext = {
  cellName?: string;
  actionType?: string;
  effectType?: string;
  hookName?: string;
  duration?: number;
  budget?: number;
  machineState?: string;
  callStack?: string[];
  /** This cell has blown the SAME budget repeatedly.
   *
   *  A one-off slow call and a cell that is heavy every tick have different
   *  answers — `blocking()` for the call, `worker: true` for the cell — and a
   *  tip that named both every time would be advice to pick from rather than
   *  advice. The dispatcher counts (it is where the violations pass); the
   *  remedy stays in `errorTip`, once. */
  repeatOffender?: boolean;
};

export type ReportErrorOpts = {
  onError?: (err: AioError) => void;
  logger?: {
    error: (msg: string, data?: Record<string, unknown>) => void;
    warn?: (msg: string, data?: Record<string, unknown>) => void;
  };
  tt?: {
    markError: (
      err: {
        code: AioErrorCode;
        message: string;
        cellName?: string;
        /** The action this error belongs to, when it has one — time travel
         *  marks THAT entry rather than whatever is current. */
        actionType?: string;
      },
    ) => void;
  };
  countError?: () => void;
  prod?: boolean;
};

// ─── Code → Source mapping ───────────────────────────────────────────────────

const CODE_TO_SOURCE: Record<AioErrorCode, AioErrorSource> = {
  REDUCE_ERROR: "reduce",
  EFFECT_ERROR: "effect",
  EFFECT_TIMEOUT: "effect",
  EFFECT_ASYNC_ERROR: "effect",
  HOOK_ERROR: "hook",
  INIT_ERROR: "init",
  DESTROY_ERROR: "destroy",
  ACCESS_DENIED: "access",
  ACTION_REFUSED: "dispatch",
  MACHINE_BLOCKED: "machine",
  QUEUE_OVERFLOW: "dispatch",
  DISPATCH_LOOP: "dispatch",
  DISPATCH_CLOSED: "dispatch",
  DISPATCH_DRAINING: "dispatch",
  DISPATCH_ABORTED: "dispatch",
  MEMORY_PRESSURE: "memory",
  MEMORY_CRITICAL: "memory",
  BUDGET_REDUCE: "reduce",
  BUDGET_EFFECT: "effect",
  PERSIST_ERROR: "persist",
  PERSIST_SCHEMA: "persist",
  TX_CONFLICT: "effect",
  UI_FREEZE: "vitals",
  TRANSPORT_STALL: "vitals",
  LOOP_SATURATED: "vitals",
};

const WARN_CODES: Set<AioErrorCode> = new Set([
  // A refused call is the gate WORKING. Logging it at error level made a
  // correctly-enforced rule read like a server fault in every log scan.
  "ACCESS_DENIED",
  "ACTION_REFUSED",
  "MACHINE_BLOCKED",
  "MEMORY_PRESSURE",
  "BUDGET_REDUCE",
  "BUDGET_EFFECT",
  "UI_FREEZE",
  "TRANSPORT_STALL",
  "LOOP_SATURATED",
]);

// Perf/vitals codes fire repeatedly by nature — a slow effect trips the budget
// on every call, a long-running compute effect trips the timeout each pass.
// Reporting each one floods the console/log with identical noise. We throttle
// the CONSOLE + logger output per (code, cell/action) to once per window, while
// still counting them and surfacing them on the diagnostic bus so nothing is
// silently lost. The window resets so a genuinely recurring regression is still
// re-surfaced periodically.
const THROTTLED_CODES: Set<AioErrorCode> = new Set([
  "BUDGET_REDUCE",
  "BUDGET_EFFECT",
  "EFFECT_TIMEOUT",
  "UI_FREEZE",
  "TRANSPORT_STALL",
  "LOOP_SATURATED",
]);
const _perfThrottleMs = 10_000;
/** When the throttle bookkeeping is swept for expired keys. Not a hard limit:
 *  every entry within the throttle window is still live and stays. */
const _PERF_KEYS_SOFT_CAP = 512;
const _perfLastReported = new Map<string, number>();
const _perfSuppressed = new Map<string, number>();

/** True if this repetitive perf/vitals report should be suppressed from the
 *  console/log right now. Returns a suppressed-count on the first emission after
 *  a throttle window so the dev sees how many were coalesced. */
function _perfThrottle(
  err: AioError,
): { suppress: boolean; coalesced: number } {
  if (!THROTTLED_CODES.has(err.code)) return { suppress: false, coalesced: 0 };
  const key = `${err.code}:${
    err.context.actionType ?? err.context.cellName ?? ""
  }`;
  const now = Date.now();
  const last = _perfLastReported.get(key);
  if (last !== undefined && now - last < _perfThrottleMs) {
    _perfSuppressed.set(key, (_perfSuppressed.get(key) ?? 0) + 1);
    return { suppress: true, coalesced: 0 };
  }
  _perfLastReported.set(key, now);
  // Bounded, because the KEY is unbounded: it carries the action type, and an
  // app with dynamic action types (`workspace:fsChanged`, one per file) grows a
  // new entry per distinct action forever — a slow leak in the subsystem whose
  // job is reporting leaks, on the process that runs longest. An entry older
  // than the throttle window can never suppress anything again, so it is
  // exactly the entry to drop; the sweep only runs when the map is large, so
  // the common case pays nothing.
  if (_perfLastReported.size > _PERF_KEYS_SOFT_CAP) {
    for (const [k, t] of _perfLastReported) {
      if (now - t >= _perfThrottleMs) {
        _perfLastReported.delete(k);
        _perfSuppressed.delete(k);
      }
    }
  }
  const coalesced = _perfSuppressed.get(key) ?? 0;
  _perfSuppressed.delete(key);
  return { suppress: false, coalesced };
}

/** Reset perf-throttle state — for test isolation. */
export function _resetPerfThrottle(): void {
  _perfLastReported.clear();
  _perfSuppressed.clear();
}

// ─── Diagnostic bus bridge ───────────────────────────────────────────────────

let _diagEmitFn: ((ev: Omit<DiagnosticEvent, "ts">) => void) | null = null;

/** Wire the diagnostic bus into reportError. Called once during server init. */
export function setDiagEmit(
  fn: (ev: Omit<DiagnosticEvent, "ts">) => void,
): void {
  _diagEmitFn = fn;
}

// ─── Correlation ID context ──────────────────────────────────────────────────

let _correlationId: string | undefined;

export function setCorrelationId(id: string): void {
  _correlationId = id;
}
export function clearCorrelationId(): void {
  _correlationId = undefined;
}
export function getCorrelationId(): string {
  return _correlationId ?? "none";
}
export function generateCorrelationId(): string {
  const id = randomUuid().slice(0, 8);
  _correlationId = id;
  return id;
}

// ─── AioError class ─────────────────────────────────────────────────────────

/** Structured error with code, source, context, correlation ID, and optional state snapshot. */
export class AioError extends Error {
  /** Error classification code (e.g. `'REDUCE_ERROR'`, `'EFFECT_TIMEOUT'`). */
  readonly code: AioErrorCode;
  /** Origin subsystem — `'reduce'`, `'effect'`, `'vitals'`, etc. */
  readonly source: AioErrorSource;
  /** Structured context — cell name, action type, timing. */
  readonly context: AioErrorContext;
  /** Original error that caused this AioError, if wrapping. */
  readonly original: Error | undefined;
  /** Unix timestamp (ms) when the error was created. */
  readonly timestamp: number;
  /** Unique ID linking related errors across cells. */
  readonly correlationId: string;
  /** Optional state snapshot captured at the time of the error. */
  readonly stateSnapshot: Record<string, unknown> | undefined;

  /** Create a new AioError with code, message, context, and optional original error + state snapshot. */
  constructor(
    code: AioErrorCode,
    message: string,
    context: AioErrorContext,
    original?: Error,
    stateSnapshot?: Record<string, unknown>,
    correlationId?: string,
  ) {
    super(message);
    this.name = "AioError";
    this.code = code;
    this.source = CODE_TO_SOURCE[code];
    this.context = context;
    this.original = original;
    this.timestamp = Date.now();
    this.correlationId = correlationId ?? getCorrelationId();
    this.stateSnapshot = stateSnapshot;
  }

  /** The remedy for this error's code — the SAME text the error box and the
   *  diagnostic bus's `hint` carry, read from the one generator.
   *
   *  It exists as a property because the fix used to be reachable only two
   *  ways: `formatErrorBox()` (dev console) and `DiagnosticEvent.hint` (the
   *  bus). An `AioError` that escaped into an app's own `catch` — rethrown,
   *  awaited, printed with `console.error(err)` — carried the CAUSE and none
   *  of the FIX, so the 21 tips in {@link generateTip} were invisible exactly
   *  where a developer is already stuck. */
  get tip(): string | undefined {
    return generateTip(this);
  }

  /** `String(err)` — cause AND fix, because that is what a terminal shows.
   *  `.message` is left alone on purpose: it is compared, logged and matched
   *  in a dozen places, and a remedy is not part of what went wrong. */
  override toString(): string {
    const tip = this.tip;
    return tip
      ? `${this.name}: ${this.message}\n  → ${tip}`
      : `${this.name}: ${this.message}`;
  }

  /** Serialize to a plain object — suitable for JSON logging and diagnostic reports. */
  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      source: this.source,
      message: this.message,
      tip: this.tip,
      context: this.context,
      timestamp: this.timestamp,
      correlationId: this.correlationId,
      stack: this.stack ?? "",
      stateSnapshot: this.stateSnapshot,
    };
  }
}

// ─── Teachable errors ────────────────────────────────────────────

/** A framework message that TEACHES: what happened, the one-line fix, and
 *  (optionally) a doc link — the shape the credential refusal proved out,
 *  generalized so every boot/compose/config error follows ONE format:
 *
 *      <what>
 *        → fix: <fix>
 *        → docs: <doc>
 *
 *  Use for developer-facing framework messages (not user-facing app errors).
 *  Exported from `aio/extras` so an app's own boot checks can speak the same
 *  sentence shape as the framework's.
 *
 *  NO `[aio]` PREFIX. This string's home is `log.warn`/`log.error`, and the
 *  logger already prints the category it INFERRED from the call site — a
 *  hand-written prefix made every such line read `ERROR  aio  [aio] …`, the
 *  same fact twice. {@linkcode teachableError} adds the prefix, because a
 *  thrown Error lands on a bare stderr with no category column to carry it. */
export function teachMessage(what: string, fix: string, doc?: string): string {
  const lines = [what, `  → fix: ${fix}`];
  if (doc) lines.push(`  → docs: ${doc}`);
  return lines.join("\n");
}

/** {@linkcode teachMessage} as a throwable Error — prefixed `[aio]`, because
 *  an Error's text is all a reader gets and it has to name its own source. */
export function teachableError(what: string, fix: string, doc?: string): Error {
  return new Error(`[aio] ${teachMessage(what, fix, doc)}`);
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createAioError(
  code: AioErrorCode,
  raw: unknown,
  context: AioErrorContext,
  stateSnapshot?: Record<string, unknown>,
  correlationId?: string,
): AioError {
  let message: string;
  let original: Error | undefined;

  if (raw instanceof Error) {
    message = raw.message;
    original = raw;
  } else if (typeof raw === "string") {
    message = raw;
  } else if (raw === null || raw === undefined) {
    message =
      `[${code}] error object was null/undefined — check that the throwing code passes an Error instance`;
  } else {
    message = String(raw);
  }

  return new AioError(
    code,
    message,
    context,
    original,
    stateSnapshot,
    correlationId,
  );
}

// ─── Stack frame filtering ──────────────────────────────────────────────────

export function extractUserFrames(stack: string | undefined): string[] {
  if (!stack) return [];
  const lines = stack.split("\n");
  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("at ")) return false;
    if (trimmed.includes("dep/aio/")) return false;
    if (trimmed.includes("node_modules/")) return false;
    if (trimmed.includes("deno:")) return false;
    return true;
  });
  return filtered.slice(0, 5).map((l) => l.trim());
}

// ─── Tip generator ──────────────────────────────────────────────────────────

/** THE remedy for a code, in one place. Exported so a test can pin the advice
 *  at its single source: the dispatcher states facts (and the per-method
 *  hatch, which only it knows), and everything about what to DO is here.
 *  @internal */
/** The per-CELL answer, offered only once the per-CALL one has stopped fitting.
 *
 *  Field report: "`worker: true` is unambiguously the best thing I adopted this
 *  cycle — it deleted a hand-rolled worker and came out 456 lines lighter. The
 *  only criticism is discoverability: I hand-rolled first and found the
 *  built-in later. If a cell's tick regularly exceeds a frame budget, a
 *  dev-mode hint would route people to it at exactly the moment they care."
 *
 *  Gated on repetition on purpose. `blocking()` is the right answer for one
 *  slow call; `worker: true` is the right answer for a cell that is heavy every
 *  tick, which is the case `docs/state/methods.md` already calls "every method
 *  here can be heavy". Naming both on a first violation would be a menu. */
function workerHint(err: AioError): string {
  if (!err.context.repeatOffender) return "";
  const cell = err.context.cellName;
  return ` This cell has blown its budget repeatedly — if most of its work is ` +
    `heavy, give it a thread of its own: \`worker: true\` on ${
      cell ? `cell("${cell}", …)` : "the cell"
    } (docs/state/cell-workers.md).`;
}

export function generateTip(err: AioError): string | undefined {
  // FIRST, before the per-code tips: a frozen-state write is recognisable by
  // its message whatever code it arrives under, and it is the single most
  // common thing an author does wrong. The engine's own sentence —
  // `Cannot assign to read only property 'n' of object '#<Object>'` — names
  // neither the cell, nor the rule, nor the fix; `state/immutable.ts` has been
  // the authority for the sentence that does since alpha70, and it was wired
  // into the reducer, the test harnesses and a browser-only listener. An
  // effect, a lifecycle hook, a route handler or an `onStart` that writes
  // `app.state.x = 1` got the raw text — and those paths are all CAUGHT by the
  // framework, so no global error listener could ever have reached them.
  // Found by `scripts/audit-round.ts 24`.
  if (isFrozenWriteError(err.message)) {
    return "Tip: " + frozenWriteMessage(err.message, err.context.cellName);
  }
  switch (err.code) {
    case "REDUCE_ERROR": {
      const msg = err.message;
      // AIO-60: Better hints for proxy/state errors
      if (
        msg.includes("ownKeys") || msg.includes("non-extensible") ||
        msg.includes("proxy")
      ) {
        const method = err.context.actionType?.includes(":__set")
          ? err.context.actionType.replace(/.*:__set/, "").replace(
            /^./,
            (c: string) => c.toLowerCase(),
          )
          : err.context.actionType?.split(":")[1] ?? "?";
        return `Tip: Proxy state error in method "${method}" of cell "${
          err.context.cellName ?? "?"
        }". Avoid .map()/.spread/Object.keys() on live proxy state — use explicit property access or snapshot first: const items = [...s.items]`;
      }
      return `Tip: Reducer for "${
        err.context.actionType ?? "?"
      }" threw — check action payload shape and inspect state at crash.`;
    }
    case "EFFECT_ERROR": {
      const et = String(err.context.effectType ?? "?");
      // `cell:__exec` / `__effects` / `__set` are the FRAMEWORK's own runners
      // (an async method, the `s.$do` bridge, an async write-set), not an app
      // effect. "Sync effect … threw. If doing I/O, move to an async method"
      // told the author of an already-async method to make it async, and
      // pointed away from the code that actually threw.
      const i = et.indexOf(":__");
      if (i !== -1) {
        const runner = et.slice(i + 1);
        return `Tip: the framework's "${runner}" runner for cell '${
          et.slice(0, i)
        }' threw — the error above comes from the method or write-set it was ` +
          `running, not from an app effect. ${
            runner === "__exec"
              ? "Check the async method's own body and the arguments it was called with."
              : "Check the effect or write-set the method produced."
          }`;
      }
      return `Tip: Sync effect "${et}" threw. If doing I/O, move to an async method or return a promise.`;
    }
    case "EFFECT_TIMEOUT":
      return `Tip: Effect "${err.context.effectType ?? "?"}" timed out after ${
        err.context.duration ?? "?"
      }ms. Check for network issues or increase effectTimeoutMs.`;
    case "EFFECT_ASYNC_ERROR": {
      // An async METHOD that threw is the common case here; "execute handler"
      // and `call({ retries })` are the actions-form vocabulary and sent
      // method authors looking for a handler they do not have.
      const at = err.context.actionType;
      if (typeof at === "string" && at.includes(":")) {
        return `Tip: async method ${at}() threw after it started. The caller ` +
          `that awaited it was rejected with this error, and writes it made ` +
          `before the throw are already state — catch inside the method to ` +
          `record a failure the UI can show, or catch at the call site.`;
      }
      return `Tip: Async effect "${
        err.context.effectType ?? "?"
      }" rejected. Add error handling in your execute handler or use call({ retries }).`;
    }
    case "HOOK_ERROR":
      return `Tip: Hook "${
        err.context.hookName ?? "?"
      }" threw. Hooks should be side-effect-free observers — avoid mutations or throwing.`;
    case "INIT_ERROR":
      return `Tip: Cell "${
        err.context.cellName ?? "?"
      }" onInit threw. Check for missing dependencies or invalid initial state.`;
    case "DESTROY_ERROR":
      return `Tip: Cell "${
        err.context.cellName ?? "?"
      }" onDestroy threw. Cleanup should be best-effort — guard against already-cleaned resources.`;
    case "ACCESS_DENIED":
      return `Tip: the caller was refused by the \`access:\` rule on cell "${
        err.context.cellName ?? "?"
      }" (or the serverFn's \`{ access }\`). This is the gate working — sign the ` +
        `user in, give them the required role, or widen the rule. In app code, ` +
        `branch on it: \`if (errorCode(e) === "ACCESS_DENIED")\` — never on the ` +
        `message text.`;
    case "ACTION_REFUSED":
      return `Tip: the action reached the server and changed nothing — a ` +
        `renamed/removed method still called by an older client, a cell missing ` +
        `from \`aio.run({ cells })\`, a disabled cell, or a \`validate\` refusal. ` +
        `The message names which. Branch on it with ` +
        `\`errorCode(e) === "ACTION_REFUSED"\`, not on the wording.`;
    case "MACHINE_BLOCKED":
      return `Tip: Machine in state "${
        err.context.machineState ?? "?"
      }" blocked this action. Check your machine config or add the transition.`;
    case "QUEUE_OVERFLOW":
      return `Tip: Action queue exceeded ${10_000} entries. You may have a dispatch loop — check effects that dispatch synchronously.`;
    case "DISPATCH_LOOP":
      return `Tip: the drain loop hit its iteration ceiling (the message names it — the same bound as the action queue). A reducer or effect is dispatching back to itself. Break the cycle.`;
    case "DISPATCH_DRAINING":
      return "Tip: the app is closing — running methods are finishing their writes; this action was new input. Stop dispatching once shutdown starts.";
    case "DISPATCH_CLOSED":
      return `Tip: Action dispatched after the app/cell was closed — it was not applied. Stop dispatching during/after shutdown, or guard awaited calls.`;
    case "DISPATCH_ABORTED":
      return `Tip: The drain loop threw outside every per-action guard, so these actions were never applied and dispatch was reset. The preceding error names the cause — a common one is a non-plain value (typed array, Map/Set) in cell state under freezeState. Retry the actions once the cause is fixed.`;
    case "MEMORY_PRESSURE":
      return `Tip: Heap usage rising. Check per-cell state sizes — prune unbounded arrays or move large data to SQLite.`;
    case "MEMORY_CRITICAL":
      return `Tip: Heap critically high — OOM imminent. Emergency prune large state or increase memory limit with --v8-flags=--max-old-space-size=N.`;
    case "BUDGET_REDUCE":
      return `Tip: Reducer took ${
        err.context.duration?.toFixed(0) ?? "?"
      }ms (budget: ${
        err.context.budget ?? 100
      }ms) — every client's actions waited that long. If it's I/O, make the ` +
        `method async so it suspends at the await; if it's COMPUTE, an await ` +
        `doesn't help (the isolate is still blocked) — move it off-thread with ` +
        `blocking("id", fn, arg).` + workerHint(err) +
        ` See docs/debugging/performance.md.`;
    case "BUDGET_EFFECT":
      // THE remedy for this code. The dispatcher states the facts and the
      // per-method escape hatch (it is the only thing that knows the method
      // key); everything about what to DO about it is here, once.
      return `Tip: Sync effect took ${
        err.context.duration?.toFixed(0) ?? "?"
      }ms (budget: ${
        err.context.budget ?? 5
      }ms). An effect must return immediately: kick off async I/O without ` +
        `awaiting it here, or hand CPU work to blocking("id", fn, ` +
        `arg).` + workerHint(err) + ` See docs/debugging/performance.md.`;
    case "PERSIST_ERROR": {
      // The disk advice only when the failure IS a disk-class failure: a
      // planner refusal ("bound to a state value that is not an array"), a
      // constraint, or a value the store cannot hold used to end with "check
      // disk space and file permissions" — the one thing the reader would
      // then check, and the one thing that was not wrong.
      const cause = `${err.message} ${err.original?.message ?? ""}`;
      const disk =
        // The DRIVER's words, not SQLite's symbol names. node:sqlite surfaces
        // SQLITE_FULL as the string "database or disk is full", which matched
        // nothing here — so the one message that means "you are out of disk"
        // was answered with "this does not look like a disk-space failure".
        // Measured on a real app with a page-count cap. The symbols stay
        // because a wrapper may pass them through; the strings are what
        // actually arrives.
        /os error|\bE(ACCES|NOSPC|ROFS|PERM|IO|BUSY|MFILE|DQUOT)\b|permission denied|no space|disk is full|read-?only|SQLITE_(FULL|READONLY|CANTOPEN|IOERR|BUSY|LOCKED)|disk i\/o|database is locked|unable to open database/i
          .test(cause);
      return disk
        ? "Tip: State persist failed — changes are in memory but will be lost on restart. Check disk space and file permissions."
        : "Tip: State persist failed — changes are in memory but will be lost on restart. The message names what the store refused (a row shape, a constraint, a value it cannot hold) — fix that at its source; this does not look like a disk-space or permissions failure.";
    }
    case "PERSIST_SCHEMA":
      return "Tip: Stored state and framework persistence-schema versions are incompatible. Upgrade aio (older store) or restore a backup (newer store); as a last resort clear the app's KV store.";
    case "UI_FREEZE":
      return "Tip: The UI thread stalled — look for synchronous heavy work in render paths or event handlers. Compute-bound work belongs off-thread (schedule.blocking on the server, a Worker in the browser); splitting it across frames only hides it.";
    case "TRANSPORT_STALL":
      return "Tip: The WebSocket made no progress under backpressure — the client can't keep up with broadcast volume. Reduce update frequency (debounce state writes), narrow `ui` filters so less state syncs, or check for a saturated network link.";
    case "LOOP_SATURATED":
      return "Tip: The event loop is saturated — work is queued faster than it drains. Look for tight dispatch loops, unbatched state writes, or schedules firing faster than their handlers finish (self-scheduling `after` chains beat rapid `every`).";
    default:
      return undefined;
  }
}

// ─── Console formatter ──────────────────────────────────────────────────────

/** The `file:line:col` a stack frame names, with the noise around it removed.
 *  `at addItem (file:///home/a/src/cell.ts:14:20)` → that path, 14, 20. */
export function frameLocation(
  frame: string,
): { file: string; line: number; col: number } | null {
  const m = /((?:file:\/\/)?\/?[^\s()]+?):(\d+):(\d+)\)?$/.exec(frame.trim());
  if (!m) return null;
  const file = m[1]!.startsWith("file://")
    ? decodeURIComponent(m[1]!.slice("file://".length))
    : m[1]!;
  return { file, line: Number(m[2]), col: Number(m[3]) };
}

/** The three lines around `line` of `file`, gutter-numbered, with the failing
 *  one painted and a caret under `col`.
 *
 *  This is the single biggest thing the old box was missing. It printed a
 *  path and a line number and left the reader to go open the file — while the
 *  build, the linter and every editor show the code. Best-effort by
 *  construction: no Deno (a browser), no read permission, a bundled or
 *  generated path, a file that changed since the stack was captured — all mean
 *  "no excerpt", never a throw inside an error reporter. */
export function sourceExcerpt(
  file: string,
  line: number,
  col: number,
  st: Style = style,
): string | null {
  try {
    // deno-lint-ignore no-explicit-any
    const D = (globalThis as any).Deno;
    if (!D?.readTextFileSync) return null;
    if (/(?:^|\/)(?:dep\/aio|node_modules)\//.test(file)) return null;
    const lines = D.readTextFileSync(file).split("\n") as string[];
    if (line < 1 || line > lines.length) return null;
    const from = Math.max(1, line - 1), to = Math.min(lines.length, line + 1);
    const w = String(to).length;
    const out: string[] = [];
    for (let n = from; n <= to; n++) {
      const text = lines[n - 1]!.replace(/\t/g, "  ");
      const gutter = st.dim(`${String(n).padStart(w)} │ `);
      out.push(n === line ? gutter + st.red(text) : gutter + st.dim(text));
      if (n === line && col > 0) {
        out.push(
          st.dim(`${" ".repeat(w)} │ `) + " ".repeat(col - 1) + st.red("^"),
        );
      }
    }
    return out.join("\n");
  } catch {
    return null; // aio-ok: an unreadable source is no excerpt, never a crash
  }
}

/** The error, in the house style: a red glyph, the code, the sentence, where
 *  it happened with the code around it, and the one thing to do about it.
 *
 *  It replaces a 60-column `┏━━ AIO ERROR ━━┓` frame whose every line began
 *  with `┃ Bold-Label:` — nine labelled rows for facts that are mostly absent,
 *  a fixed width that neither wrapped a long message nor used a wide terminal,
 *  and no sight of the code that failed. */
export function formatErrorBox(err: AioError): string {
  const isWarn = WARN_CODES.has(err.code);
  const tone: Tone = isWarn ? "warn" : "bad";
  const cols = termWidth();

  // Subject: what of the app's own vocabulary this happened in. Joined on
  // `·` as ONE dim line rather than one bold-labelled row each — five rows
  // that are usually four empties is a form, not a message.
  const c = err.context;
  const here = (() => {
    try {
      // deno-lint-ignore no-explicit-any
      return ((globalThis as any).Deno?.cwd?.() ?? "") + "/";
    } catch {
      return ""; // aio-ok: no cwd permission — paths stay absolute
    }
  })();
  /** A path as the reader knows it: relative to where they ran the command,
   *  with the `file://` a stack frame carries removed. */
  const short = (p: string) => p.replace(/file:\/\//g, "").replace(here, "");
  const subject = [
    c.cellName && `cell ${c.cellName}`,
    c.actionType && `action ${c.actionType}`,
    c.effectType && `effect ${c.effectType}`,
    c.hookName && `hook ${c.hookName}`,
    c.machineState && `machine ${c.machineState}`,
    c.duration != null && `${c.duration}ms`,
    // Joined PLAIN and dimmed once, at the end: a `dim(" · ")` between plain
    // parts emits a reset after each separator, so everything past the first
    // one lost its dim — the classic nested-escape bug.
  ].filter(Boolean).join(" · ");

  const parts: string[] = [];
  parts.push(
    `${mark(tone)} ${
      style.bold(isWarn ? style.yellow(err.code) : style.red(err.code))
    }` +
      (subject ? "  " + style.dim(subject) : ""),
  );
  parts.push(indent(wrap(err.message, cols - 2).join("\n")));

  const userFrames = extractUserFrames(err.original?.stack ?? err.stack);
  const loc = userFrames.length ? frameLocation(userFrames[0]!) : null;
  const excerpt = loc && sourceExcerpt(loc.file, loc.line, loc.col);
  if (loc) {
    const rel = short(loc.file);
    parts.push(
      indent(`${style.underline(rel)}${style.dim(`:${loc.line}:${loc.col}`)}`) +
        (excerpt ? "\n" + indent(excerpt, "    ") : ""),
    );
  }
  if (userFrames.length > 1) {
    parts.push(
      indent(userFrames.slice(1).map((f) => style.dim(short(f))).join("\n")),
    );
  }

  const tip = generateTip(err);
  if (tip) {
    const body = tip.replace(/^Tip: /, "");
    parts.push(
      indent(
        wrap(body, cols - 4).map((l, i) =>
          i === 0 ? style.cyan("→ " + l) : style.cyan("  " + l)
        ).join("\n"),
      ),
    );
  }

  // The footer: everything a reader needs only when they are filing a report.
  if (err.stateSnapshot) {
    // Guarded: the snapshot is the LIVE state, and a reducer that crashed on
    // unusual state (a BigInt, a cycle) is exactly when stringify dies too —
    // taking the whole report (onError hook, TT mark, error count, diag bus)
    // down with it. Same guard the action log and dispatch's tag() carry.
    let snap: string;
    try {
      snap = JSON.stringify(err.stateSnapshot) ?? "undefined";
    } catch {
      snap = "[unserializable: BigInt or circular structure]";
    }
    parts.push(
      indent(
        style.dim(
          "state  " + (snap.length > 200 ? snap.slice(0, 200) + "…" : snap),
        ),
      ),
    );
  }
  parts.push(indent(style.dim(`cid ${err.correlationId}`)));

  return "\n" + stack(...parts) + "\n";
}

export function formatErrorCompact(err: AioError): string {
  const parts = [`[${err.code}]`];
  if (err.context.cellName) parts.push(err.context.cellName);
  parts.push(err.message);
  if (err.correlationId !== "none") parts.push(`cid=${err.correlationId}`);
  // The FIX travels with the cause on the prod path too. This is the line a
  // production log keeps; dropping the remedy from it made the box-vs-compact
  // split a difference in how much you are TOLD, which is the one dev/prod
  // divergence class the project does allow — but in the wrong direction,
  // since prod is where nobody can re-run it in dev to see the box.
  const tip = generateTip(err);
  if (tip) parts.push(`| ${tip.replace(/^Tip: /, "fix: ")}`);
  return parts.join(" ");
}

// ─── reportError — single exit point ────────────────────────────────────────

export function reportError(err: AioError, opts: ReportErrorOpts = {}): void {
  try {
    const { onError, logger, tt, countError, prod } = opts;
    const isWarn = WARN_CODES.has(err.code);
    // Throttle repetitive perf/vitals noise from the console + logger (counts
    // and the diagnostic bus below still see every occurrence).
    const { suppress, coalesced } = _perfThrottle(err);

    // Console output
    if (!suppress) {
      const suffix = coalesced > 0
        ? ` (${coalesced} more suppressed in the last ${
          _perfThrottleMs / 1000
        }s)`
        : "";
      if (prod) {
        const compact = formatErrorCompact(err) + suffix;
        if (isWarn) log.warn(compact);
        else log.error(compact);
      } else {
        const box = formatErrorBox(err) + (suffix ? `\n${suffix.trim()}` : "");
        if (isWarn) log.warn(box);
        else log.error(box);
      }
    }

    // Logger — warn-level for WARN_CODES (a slow effect is not an error), and
    // suppressed while throttled so the structured log doesn't flood either.
    if (logger && !suppress) {
      const payload = err.toJSON() as Record<string, unknown>;
      const write = isWarn && logger.warn ? logger.warn : logger.error;
      write(formatErrorCompact(err), payload);
    }

    // onError hook (guarded)
    if (onError) {
      try {
        onError(err);
      } catch (hookErr) {
        log.error("onError hook threw:", { detail: String(hookErr) });
      }
    }

    // TT markError — with the action type, so the mark lands on the entry that
    // action really is (an async effect fails several actions later, and a
    // reduce that threw was never recorded at all).
    if (tt) {
      tt.markError({
        code: err.code,
        message: err.message,
        cellName: err.context.cellName,
        actionType: err.context.actionType,
      });
    }

    // countError
    if (countError) countError();

    // Diagnostic bus bridge — auto-surface in health overlay
    if (_diagEmitFn) {
      const isWarnForBus = WARN_CODES.has(err.code);
      _diagEmitFn({
        type: err.code.toLowerCase().replace(/_/g, "-"),
        severity: isWarnForBus ? "warning" : "error",
        source: err.source,
        message: err.message,
        detail: { code: err.code, ...err.context },
        hint: generateTip(err),
      });
    }
  } catch {
    // Fallback — never throw from reportError
    log.error("reportError failed, raw error:", { detail: String(err) });
  }
}
