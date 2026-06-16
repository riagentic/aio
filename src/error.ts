// ─── AioError Core — Types, Factory, Formatter, Reporter ─────────────────────

import type { DiagnosticEvent } from "./diagnostic-bus.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Discriminated error code — identifies the specific failure class (e.g. `'REDUCE_ERROR'`, `'EFFECT_TIMEOUT'`). */
export type AioErrorCode =
  | "REDUCE_ERROR"
  | "EFFECT_ERROR"
  | "EFFECT_TIMEOUT"
  | "EFFECT_ASYNC_ERROR"
  | "FLOW_STEP_ERROR"
  | "FLOW_UNCAUGHT"
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
  | "UI_FREEZE"
  | "TRANSPORT_STALL"
  | "LOOP_SATURATED";

/** Origin subsystem that raised the error — `'reduce'`, `'effect'`, `'flow'`, `'vitals'`, etc. */
export type AioErrorSource =
  | "reduce"
  | "effect"
  | "flow"
  | "hook"
  | "init"
  | "destroy"
  | "memory"
  | "dispatch"
  | "machine"
  | "vitals"
  | "persist";

/** Record of a single generator flow step — step number, action name, and execution status. */
export type FlowStepRecord = {
  step: number;
  action: string;
  status: "ok" | "error" | "pending";
};

/** Structured context attached to every `AioError` — cell name, action type, flow state, timing, etc. */
export type AioErrorContext = {
  cellName?: string;
  actionType?: string;
  effectType?: string;
  flowName?: string;
  flowStep?: number;
  flowHistory?: FlowStepRecord[];
  hookName?: string;
  duration?: number;
  budget?: number;
  machineState?: string;
  callStack?: string[];
};

export type ReportErrorOpts = {
  onError?: (err: AioError) => void;
  logger?: { error: (msg: string, data?: Record<string, unknown>) => void };
  tt?: {
    markError: (
      err: {
        code: AioErrorCode;
        message: string;
        cellName?: string;
        flowStep?: number;
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
  FLOW_STEP_ERROR: "flow",
  FLOW_UNCAUGHT: "flow",
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
  const id = crypto.randomUUID().slice(0, 8);
  _correlationId = id;
  return id;
}

// ─── AioError class ─────────────────────────────────────────────────────────

/** Structured error with code, source, context, correlation ID, and optional state snapshot. */
export class AioError extends Error {
  /** Error classification code (e.g. `'REDUCE_ERROR'`, `'EFFECT_TIMEOUT'`). */
  readonly code: AioErrorCode;
  /** Origin subsystem — `'reduce'`, `'effect'`, `'flow'`, `'vitals'`, etc. */
  readonly source: AioErrorSource;
  /** Structured context — cell name, action type, flow state, timing. */
  readonly context: AioErrorContext;
  /** Original error that caused this AioError, if wrapping. */
  readonly original: Error | undefined;
  /** Unix timestamp (ms) when the error was created. */
  readonly timestamp: number;
  /** Unique ID linking related errors across cells and flows. */
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
    case "FLOW_STEP_ERROR":
      return `Tip: Flow "${err.context.flowName ?? "?"}" step ${
        err.context.flowStep ?? "?"
      } threw. The error was fed back via gen.throw() — catch it in your generator.`;
    case "FLOW_UNCAUGHT":
      return `Tip: Uncaught error in flow "${
        err.context.flowName ?? "?"
      }". Wrap flow steps in try-catch inside your generator.`;
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
      }ms). Move heavy computation to an async effect.`;
    case "BUDGET_EFFECT":
      return `Tip: Sync effect took ${
        err.context.duration?.toFixed(0) ?? "?"
      }ms (budget: ${
        err.context.budget ?? 5
      }ms). Return immediately and do work asynchronously.`;
    case "PERSIST_ERROR":
      return "Tip: State persist failed — changes are in memory but will be lost on restart. Check disk space and file permissions.";
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
  if (err.context.flowName) {
    lines.push(
      `${bar} ${BOLD}Flow:${RESET}    ${err.context.flowName}${
        err.context.flowStep != null ? ` (step ${err.context.flowStep})` : ""
      }`,
    );
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

  // Flow history
  if (err.context.flowHistory && err.context.flowHistory.length > 0) {
    lines.push(`${bar}`);
    lines.push(`${bar} ${DIM}Flow history:${RESET}`);
    for (const rec of err.context.flowHistory) {
      const icon = rec.status === "ok"
        ? "✓"
        : rec.status === "error"
        ? "✗"
        : "…";
      lines.push(
        `${bar}   ${DIM}${icon} step ${rec.step}: ${rec.action} [${rec.status}]${RESET}`,
      );
    }
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

    // Console output
    if (prod) {
      const compact = formatErrorCompact(err);
      if (isWarn) console.warn(compact);
      else console.error(compact);
    } else {
      const box = formatErrorBox(err);
      if (isWarn) console.warn(box);
      else console.error(box);
    }

    // Logger
    if (logger) {
      logger.error(
        formatErrorCompact(err),
        err.toJSON() as Record<string, unknown>,
      );
    }

    // onError hook (guarded)
    if (onError) {
      try {
        onError(err);
      } catch (hookErr) {
        console.error("[aio] onError hook threw:", hookErr);
      }
    }

    // TT markError
    if (tt) {
      tt.markError({
        code: err.code,
        message: err.message,
        cellName: err.context.cellName,
        flowStep: err.context.flowStep,
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
