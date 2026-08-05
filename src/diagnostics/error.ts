// ─── AioError Core — Types, Factory, Formatter, Reporter ─────────────────────

import type { DiagnosticEvent } from "./diagnostic-bus.ts";
import { randomUuid } from "../rand.ts";

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
  | "MACHINE_BLOCKED"
  | "QUEUE_OVERFLOW"
  | "DISPATCH_LOOP"
  | "DISPATCH_CLOSED"
  | "MEMORY_PRESSURE"
  | "MEMORY_CRITICAL"
  | "BUDGET_REDUCE"
  | "BUDGET_EFFECT"
  | "PERSIST_ERROR"
  | "PERSIST_SCHEMA"
  | "TX_CONFLICT"
  | "UI_FREEZE"
  | "TRANSPORT_STALL"
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
  MACHINE_BLOCKED: "machine",
  QUEUE_OVERFLOW: "dispatch",
  DISPATCH_LOOP: "dispatch",
  DISPATCH_CLOSED: "dispatch",
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

  /** Serialize to a plain object — suitable for JSON logging and diagnostic reports. */
  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      source: this.source,
      message: this.message,
      context: this.context,
      timestamp: this.timestamp,
      correlationId: this.correlationId,
      stack: this.stack ?? "",
      stateSnapshot: this.stateSnapshot,
    };
  }
}

// ─── Teachable errors ────────────────────────────────────────────

/** A framework error that TEACHES: what happened, the one-line fix, and
 *  (optionally) a doc link — the shape the credential refusal proved out,
 *  generalized so every boot/compose/config error follows one format:
 *
 *      [aio] <what>
 *        → fix: <fix>
 *        → docs: <doc>
 *
 *  Use for developer-facing framework errors (not user-facing app errors). */
export function teachMessage(what: string, fix: string, doc?: string): string {
  const lines = [`[aio] ${what}`, `  → fix: ${fix}`];
  if (doc) lines.push(`  → docs: ${doc}`);
  return lines.join("\n");
}

/** {@link teachMessage} as a throwable Error. */
export function teachableError(what: string, fix: string, doc?: string): Error {
  return new Error(teachMessage(what, fix, doc));
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

function generateTip(err: AioError): string | undefined {
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
    case "EFFECT_ERROR":
      return `Tip: Sync effect "${
        err.context.effectType ?? "?"
      }" threw. If doing I/O, move to an async method or return a promise.`;
    case "EFFECT_TIMEOUT":
      return `Tip: Effect "${err.context.effectType ?? "?"}" timed out after ${
        err.context.duration ?? "?"
      }ms. Check for network issues or increase effectTimeoutMs.`;
    case "EFFECT_ASYNC_ERROR":
      return `Tip: Async effect "${
        err.context.effectType ?? "?"
      }" rejected. Add error handling in your execute handler or use call({ retries }).`;
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
    case "MACHINE_BLOCKED":
      return `Tip: Machine in state "${
        err.context.machineState ?? "?"
      }" blocked this action. Check your machine config or add the transition.`;
    case "QUEUE_OVERFLOW":
      return `Tip: Action queue exceeded ${10_000} entries. You may have a dispatch loop — check effects that dispatch synchronously.`;
    case "DISPATCH_LOOP":
      return `Tip: 1000+ iterations detected. A reducer or effect is dispatching back to itself. Break the cycle.`;
    case "DISPATCH_CLOSED":
      return `Tip: Action dispatched after the app/cell was closed — it was not applied. Stop dispatching during/after shutdown, or guard awaited calls.`;
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
        `schedule.blocking("id", fn, arg). See docs/debugging/performance.md.`;
    case "BUDGET_EFFECT":
      return `Tip: Sync effect took ${
        err.context.duration?.toFixed(0) ?? "?"
      }ms (budget: ${
        err.context.budget ?? 5
      }ms). Return immediately: kick off async I/O, or hand CPU work to ` +
        `schedule.blocking("id", fn, arg).`;
    case "PERSIST_ERROR":
      return "Tip: State persist failed — changes are in memory but will be lost on restart. Check disk space and file permissions.";
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

// ─── ANSI helpers ────────────────────────────────────────────────────────────

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";

// ─── Console formatter ──────────────────────────────────────────────────────

export function formatErrorBox(err: AioError): string {
  const isWarn = WARN_CODES.has(err.code);
  const color = isWarn ? YELLOW : RED;
  const label = isWarn ? "WARN" : "ERROR";

  const lines: string[] = [];
  const bar = `${color}┃${RESET}`;

  lines.push(
    `${color}┏━━ AIO ${label} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`,
  );
  lines.push(`${bar} ${BOLD}Code:${RESET}    ${err.code}`);
  if (err.context.cellName) {
    lines.push(`${bar} ${BOLD}Cell:${RESET} ${err.context.cellName}`);
  }
  if (err.context.actionType) {
    lines.push(`${bar} ${BOLD}Action:${RESET}  ${err.context.actionType}`);
  }
  if (err.context.effectType) {
    lines.push(`${bar} ${BOLD}Effect:${RESET}  ${err.context.effectType}`);
  }
  if (err.context.hookName) {
    lines.push(`${bar} ${BOLD}Hook:${RESET}    ${err.context.hookName}`);
  }
  if (err.context.machineState) {
    lines.push(`${bar} ${BOLD}Machine:${RESET} ${err.context.machineState}`);
  }
  if (err.context.duration != null) {
    lines.push(`${bar} ${BOLD}Duration:${RESET} ${err.context.duration}ms`);
  }
  lines.push(`${bar} ${BOLD}Message:${RESET} ${err.message}`);

  // User stack frames
  const userFrames = extractUserFrames(err.original?.stack ?? err.stack);
  if (userFrames.length > 0) {
    lines.push(`${bar}`);
    lines.push(`${bar} ${DIM}Stack:${RESET}`);
    for (const frame of userFrames) {
      lines.push(`${bar}   ${DIM}${frame}${RESET}`);
    }
  }

  // Truncated state snapshot
  if (err.stateSnapshot) {
    const snap = JSON.stringify(err.stateSnapshot);
    const truncated = snap.length > 200 ? snap.slice(0, 200) + "…" : snap;
    lines.push(`${bar}`);
    lines.push(`${bar} ${DIM}State: ${truncated}${RESET}`);
  }

  // Tip
  const tip = generateTip(err);
  if (tip) {
    lines.push(`${bar}`);
    lines.push(`${bar} ${CYAN}${tip}${RESET}`);
  }

  // Correlation ID
  lines.push(`${bar}`);
  lines.push(`${bar} ${DIM}correlationId: ${err.correlationId}${RESET}`);
  lines.push(
    `${color}┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`,
  );

  return lines.join("\n");
}

export function formatErrorCompact(err: AioError): string {
  const parts = [`[${err.code}]`];
  if (err.context.cellName) parts.push(err.context.cellName);
  parts.push(err.message);
  if (err.correlationId !== "none") parts.push(`cid=${err.correlationId}`);
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
        if (isWarn) console.warn(compact);
        else console.error(compact);
      } else {
        const box = formatErrorBox(err) + (suffix ? `\n${suffix.trim()}` : "");
        if (isWarn) console.warn(box);
        else console.error(box);
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
        console.error("[aio] onError hook threw:", hookErr);
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
    console.error("[AIO] reportError failed, raw error:", err);
  }
}
