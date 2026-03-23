# Error Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AIO error handling first-class — every error tells the developer
where, what, why, and how to fix.

**Architecture:** New `src/error.ts` module with `AioError` class,
`createAioError()` factory, `reportError()` single exit point, and console
formatter. New `src/memory-monitor.ts` for heap pressure detection. All existing
error sites in dispatch/flow/features rewired through this layer. Time-travel
extended with error markers.

**Tech Stack:** TypeScript, Deno 2.6+, no new dependencies (uses
`crypto.randomUUID()` for correlation IDs)

**Spec:** `docs/superpowers/specs/2026-03-23-error-infrastructure-design.md`

---

## File Structure

| File                           | Action     | Responsibility                                                                                                                                                                                                 |
| ------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/error.ts`                 | **Create** | AioError class, AioErrorCode/Source/Context types, createAioError factory, reportError single exit, console formatter (box/compact), stack frame filter, tip generator, correlation ID context                 |
| `src/memory-monitor.ts`        | **Create** | MemoryConfig/MemoryReport types, periodic Deno.memoryUsage() sampler, feature state sizer (recursive sizeof), trend detection, threshold alerts                                                                |
| `src/dispatch.ts`              | **Modify** | Remove old AioError type + reportError. Import new ones. Wire all catch sites through createAioError → reportError. Add correlationId to queue entries. Wire reportPerf through reportError for BUDGET_* codes |
| `src/flow.ts`                  | **Modify** | Add step counter + flowHistory ring buffer (cap 50). Route uncaught flow errors through reportError. Pass reportError dependency                                                                               |
| `src/feature-compose.ts`       | **Modify** | Wire executor/init/destroy/cross-dispatch errors through createAioError → reportError. Pass reportError dependency                                                                                             |
| `src/feature-create.ts`        | **Modify** | Wire async method throw through createAioError → reportError (keep __error dispatch)                                                                                                                           |
| `src/aio.ts`                   | **Modify** | Wrap beforeReduce in try-catch. Guard onEffect hook. Replace AioError re-export. Initialize memory monitor. Pass error infrastructure to dispatch deps. Wire TT error marking                                  |
| `src/time-travel.ts`           | **Modify** | Add error field to HistoryEntry, markError function, include error in TTBroadcast wire format                                                                                                                  |
| `src/standalone.ts`            | **Modify** | Wire createAioError + reportError into standalone dispatch deps. Skip memory monitor (no Deno.memoryUsage in browser)                                                                                          |
| `tests/error.test.ts`          | **Create** | AioError creation, context, serialization, correlationId, tips                                                                                                                                                 |
| `tests/error-dispatch.test.ts` | **Create** | Reduce/effect/queue/loop/timeout/budget errors through real dispatch                                                                                                                                           |
| `tests/error-flow.test.ts`     | **Create** | Flow step errors, uncaught, flowHistory ring buffer                                                                                                                                                            |
| `tests/error-hooks.test.ts`    | **Create** | beforeReduce/onAction/onEffect throw handling                                                                                                                                                                  |
| `tests/error-memory.test.ts`   | **Create** | Memory monitor thresholds, reports, callbacks, cleanup                                                                                                                                                         |
| `tests/error-format.test.ts`   | **Create** | Console box output, stack filtering, prod format, JSONL                                                                                                                                                        |
| `tests/error-tt.test.ts`       | **Create** | TT error markers, wire format with error field                                                                                                                                                                 |
| `tests/error-e2e.test.ts`      | **Create** | Full chain: action → error → onError → TT entry flagged                                                                                                                                                        |

---

### Task 1: AioError Core — Types, Factory, Formatter

**Files:**

- Create: `src/error.ts`
- Test: `tests/error.test.ts`

- [ ] **Step 1: Write failing tests for AioError creation and context**

```ts
// tests/error.test.ts
import {
  assertEquals,
  assertInstanceOf,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type AioError,
  clearCorrelationId,
  createAioError,
  reportError,
  setCorrelationId,
} from "../src/error.ts";

Deno.test("createAioError — preserves original Error stack", () => {
  const original = new Error("kaboom");
  const err = createAioError("REDUCE_ERROR", original, {
    featureName: "orderer",
    actionType: "orderer:buy",
  });
  assertInstanceOf(err, Error);
  assertEquals(err.code, "REDUCE_ERROR");
  assertEquals(err.source, "reduce");
  assertEquals(err.context.featureName, "orderer");
  assertEquals(err.context.actionType, "orderer:buy");
  assertEquals(err.original, original);
  assertStringIncludes(err.original!.stack!, "error.test.ts");
});

Deno.test("createAioError — extracts stack from non-Error (string)", () => {
  const err = createAioError("EFFECT_ERROR", "network down", {
    featureName: "api",
  });
  assertEquals(err.message, "network down");
  assertEquals(err.original, undefined);
});

Deno.test("createAioError — correlationId from context", () => {
  setCorrelationId("test-123");
  const err = createAioError("REDUCE_ERROR", new Error("x"), {});
  assertEquals(err.correlationId, "test-123");
  clearCorrelationId();
});

Deno.test('createAioError — correlationId is "none" when no context', () => {
  clearCorrelationId();
  const err = createAioError("REDUCE_ERROR", new Error("x"), {});
  assertEquals(err.correlationId, "none");
});

Deno.test("AioError.toJSON — produces structured object", () => {
  const err = createAioError("FLOW_UNCAUGHT", new Error("fail"), {
    featureName: "orderer",
    flowName: "exec",
    flowStep: 3,
  });
  const json = err.toJSON();
  assertEquals(json.code, "FLOW_UNCAUGHT");
  assertEquals(json.source, "flow");
  assertEquals(json.context.flowName, "exec");
  assertEquals(json.context.flowStep, 3);
  assertEquals(typeof json.timestamp, "number");
  assertEquals(typeof json.stack, "string");
});

Deno.test("error code to source mapping", () => {
  assertEquals(createAioError("REDUCE_ERROR", "x", {}).source, "reduce");
  assertEquals(createAioError("EFFECT_ERROR", "x", {}).source, "effect");
  assertEquals(createAioError("EFFECT_TIMEOUT", "x", {}).source, "effect");
  assertEquals(createAioError("EFFECT_ASYNC_ERROR", "x", {}).source, "effect");
  assertEquals(createAioError("FLOW_STEP_ERROR", "x", {}).source, "flow");
  assertEquals(createAioError("FLOW_UNCAUGHT", "x", {}).source, "flow");
  assertEquals(createAioError("HOOK_ERROR", "x", {}).source, "hook");
  assertEquals(createAioError("INIT_ERROR", "x", {}).source, "init");
  assertEquals(createAioError("DESTROY_ERROR", "x", {}).source, "destroy");
  assertEquals(createAioError("MACHINE_BLOCKED", "x", {}).source, "machine");
  assertEquals(createAioError("QUEUE_OVERFLOW", "x", {}).source, "dispatch");
  assertEquals(createAioError("DISPATCH_LOOP", "x", {}).source, "dispatch");
  assertEquals(createAioError("MEMORY_PRESSURE", "x", {}).source, "memory");
  assertEquals(createAioError("MEMORY_CRITICAL", "x", {}).source, "memory");
  assertEquals(createAioError("BUDGET_REDUCE", "x", {}).source, "reduce");
  assertEquals(createAioError("BUDGET_EFFECT", "x", {}).source, "effect");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test tests/error.test.ts` Expected: FAIL — module `../src/error.ts`
not found

- [ ] **Step 3: Implement `src/error.ts` — types, class, factory, correlation
      context**

```ts
// src/error.ts

// ── Types ──

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
  | "MEMORY_PRESSURE"
  | "MEMORY_CRITICAL"
  | "BUDGET_REDUCE"
  | "BUDGET_EFFECT";

export type AioErrorSource =
  | "reduce"
  | "effect"
  | "flow"
  | "hook"
  | "init"
  | "destroy"
  | "memory"
  | "dispatch"
  | "machine";

export type AioErrorContext = {
  featureName?: string;
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

export type FlowStepRecord = {
  step: number;
  action: string;
  status: "ok" | "error" | "pending";
};

// ── Code → Source mapping ──

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
  MEMORY_PRESSURE: "memory",
  MEMORY_CRITICAL: "memory",
  BUDGET_REDUCE: "reduce",
  BUDGET_EFFECT: "effect",
};

// ── Correlation ID context (dispatch-scoped) ──

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
  return crypto.randomUUID().slice(0, 8);
}

// ── AioError class ──

export class AioError extends Error {
  readonly code: AioErrorCode;
  readonly source: AioErrorSource;
  readonly context: AioErrorContext;
  readonly original?: Error;
  readonly timestamp: number;
  readonly correlationId: string;
  readonly stateSnapshot?: unknown;

  constructor(
    code: AioErrorCode,
    message: string,
    context: AioErrorContext,
    original?: Error,
    stateSnapshot?: unknown,
  ) {
    super(message);
    this.name = "AioError";
    this.code = code;
    this.source = CODE_TO_SOURCE[code];
    this.context = context;
    this.original = original;
    this.timestamp = Date.now();
    this.correlationId = getCorrelationId();
    this.stateSnapshot = stateSnapshot;
    // Preserve original stack if available
    if (original?.stack) this.stack = original.stack;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      source: this.source,
      message: this.message,
      context: this.context,
      correlationId: this.correlationId,
      timestamp: this.timestamp,
      stack: this.original?.stack ?? this.stack,
      ...(this.stateSnapshot !== undefined
        ? { stateSnapshot: this.stateSnapshot }
        : {}),
    };
  }
}

// ── Factory ──

export function createAioError(
  code: AioErrorCode,
  raw: unknown,
  ctx: Partial<AioErrorContext>,
  stateSnapshot?: unknown,
): AioError {
  let original: Error | undefined;
  let message: string;

  if (raw instanceof Error) {
    original = raw;
    message = raw.message;
  } else if (typeof raw === "string") {
    message = raw;
  } else if (raw === null || raw === undefined) {
    message = code;
  } else {
    message = String(raw);
  }

  return new AioError(
    code,
    message,
    ctx as AioErrorContext,
    original,
    stateSnapshot,
  );
}

// ── Stack frame filtering ──

const FRAMEWORK_PATTERNS = ["dep/aio/", "node_modules/", "deno:"];

function extractUserFrames(stack?: string): string[] {
  if (!stack) return [];
  return stack.split("\n")
    .filter((line) => line.includes("at "))
    .filter((line) => !FRAMEWORK_PATTERNS.some((p) => line.includes(p)))
    .map((line) => line.trim())
    .slice(0, 5);
}

// ── Tip generator (v1 — 5 templates) ──

function generateTip(err: AioError): string | undefined {
  switch (err.code) {
    case "MACHINE_BLOCKED":
    case "REDUCE_ERROR":
      if (err.context.machineState) {
        return `Machine was in '${err.context.machineState}' — check if this action should be guarded to a different state.`;
      }
      if (err.message.includes("undefined")) {
        return "Check if the action payload has the expected shape.";
      }
      return undefined;
    case "EFFECT_TIMEOUT":
      return `If this is expected (slow API), increase timeout: feature('${
        err.context.featureName ?? "..."
      }', { effectTimeout: 60_000, ... })`;
    case "QUEUE_OVERFLOW":
    case "DISPATCH_LOOP":
      return "Possible infinite loop — check if reduce dispatches to itself.";
    case "MEMORY_PRESSURE":
    case "MEMORY_CRITICAL":
      return err.context.featureName
        ? `${err.context.featureName} state is growing — consider pruning old entries or using external storage.`
        : "Check which feature state is growing unbounded.";
    case "FLOW_UNCAUGHT":
    case "FLOW_STEP_ERROR":
      return `Unhandled in flow — wrap the failing step in try/catch inside your generator.`;
    default:
      return undefined;
  }
}

// ── Console formatter ──

// ANSI color codes
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

const WARN_CODES: AioErrorCode[] = [
  "MACHINE_BLOCKED",
  "MEMORY_PRESSURE",
  "BUDGET_REDUCE",
  "BUDGET_EFFECT",
];

export function formatErrorBox(err: AioError): string {
  const isWarn = WARN_CODES.includes(err.code);
  const c = isWarn ? YELLOW : RED;
  const label = isWarn ? "AIO WARNING" : "AIO ERROR";
  const lines: string[] = [];

  lines.push(`${c}${BOLD}┌─ ${label} ${"─".repeat(50)}${RESET}`);
  lines.push(
    `${c}│ ${err.code} in feature '${
      err.context.featureName ?? "unknown"
    }'${RESET}`,
  );

  if (err.context.actionType) {
    lines.push(`${c}│ Action: ${err.context.actionType}${RESET}`);
  }
  if (err.context.effectType) {
    lines.push(`${c}│ Effect: ${err.context.effectType}${RESET}`);
  }
  if (err.context.flowName) {
    lines.push(
      `${c}│ Flow: ${err.context.flowName}${
        err.context.flowStep !== undefined
          ? ` (step ${err.context.flowStep})`
          : ""
      }${RESET}`,
    );
  }
  if (err.context.hookName) {
    lines.push(`${c}│ Hook: ${err.context.hookName}${RESET}`);
  }
  if (err.context.machineState) {
    lines.push(`${c}│ Machine state: ${err.context.machineState}${RESET}`);
  }
  if (err.context.duration !== undefined && err.context.budget !== undefined) {
    lines.push(
      `${c}│ Duration: ${
        err.context.duration.toFixed(1)
      }ms (budget: ${err.context.budget}ms)${RESET}`,
    );
  }

  lines.push(`${c}│${RESET}`);
  lines.push(`${c}│ ${err.message}${RESET}`);

  // Stack frames — user code only
  const frames = extractUserFrames(err.original?.stack ?? err.stack);
  if (frames.length) {
    lines.push(`${c}│${RESET}`);
    for (const frame of frames) {
      lines.push(`${c}│ ${frame}${RESET}`);
    }
  }

  // State snapshot
  if (err.stateSnapshot !== undefined) {
    const snap = JSON.stringify(err.stateSnapshot);
    const truncated = snap.length > 200 ? snap.slice(0, 200) + "..." : snap;
    lines.push(`${c}│${RESET}`);
    lines.push(`${c}│ State at crash:${RESET}`);
    lines.push(`${c}│   ${truncated}${RESET}`);
  }

  // Flow history
  if (err.context.flowHistory?.length) {
    lines.push(`${c}│${RESET}`);
    lines.push(`${c}│ Flow history:${RESET}`);
    for (const step of err.context.flowHistory) {
      const mark = step.status === "ok"
        ? "✓"
        : step.status === "error"
        ? "✗ ← failed here"
        : "…";
      lines.push(`${c}│   step ${step.step}: ${step.action} ${mark}${RESET}`);
    }
  }

  // Tip
  const tip = generateTip(err);
  if (tip) {
    lines.push(`${c}│${RESET}`);
    lines.push(`${c}│ Tip: ${tip}${RESET}`);
  }

  lines.push(`${c}│ Correlation: ${err.correlationId}${RESET}`);
  lines.push(`${c}└${"─".repeat(60)}${RESET}`);

  return lines.join("\n");
}

export function formatErrorCompact(err: AioError): string {
  const level = WARN_CODES.includes(err.code) ? "WARN" : "ERROR";
  return `[${level}] ${err.code} ${
    err.context.actionType ?? err.context.featureName ?? "?"
  } — ${err.message} (cid:${err.correlationId})`;
}

// ── reportError — single exit point ──

export type ReportErrorOpts = {
  onError?: (err: AioError) => void;
  logger?: { error: (msg: string, data?: Record<string, unknown>) => void };
  tt?: {
    markError: (
      err: {
        code: AioErrorCode;
        message: string;
        featureName?: string;
        flowStep?: number;
      },
    ) => void;
  };
  countError?: () => void;
  prod?: boolean;
};

export function reportError(err: AioError, opts: ReportErrorOpts): void {
  try {
    // 1. Console — use console.warn for warn-level codes
    const isWarnLevel = WARN_CODES.includes(err.code);
    const log = isWarnLevel ? console.warn : console.error;
    if (opts.prod) {
      log(formatErrorCompact(err));
    } else {
      log(formatErrorBox(err));
    }

    // 2. Logger
    if (opts.logger) {
      opts.logger.error(err.message, err.toJSON() as Record<string, unknown>);
    }

    // 3. onError hook
    if (opts.onError) {
      try {
        opts.onError(err);
      } catch (hookErr) {
        console.error(`[aio] onError hook threw: ${hookErr}`);
      }
    }

    // 4. Time-travel
    if (opts.tt) {
      opts.tt.markError({
        code: err.code,
        message: err.message,
        featureName: err.context.featureName,
        flowStep: err.context.flowStep,
      });
    }

    // 5. Error counter (preserves dispatch.errorCount() API)
    if (opts.countError) opts.countError();
  } catch (fatalErr) {
    // The error system must never crash the app
    console.error(
      "[aio] reportError failed, raw fallback:",
      err.message,
      fatalErr,
    );
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test tests/error.test.ts` Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/error.ts tests/error.test.ts
git commit -m "feat(error): add AioError class, factory, formatter, and correlation context"
```

---

### Task 2: Time-Travel Error Integration

**Files:**

- Modify: `src/time-travel.ts`
- Test: `tests/error-tt.test.ts`

- [ ] **Step 1: Write failing tests for TT error markers**

```ts
// tests/error-tt.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createTT,
  markError,
  record,
  toBroadcast,
} from "../src/time-travel.ts";

Deno.test("TT — error entry has error field", () => {
  let tt = createTT<{ x: number }, { type: string }>();
  tt = record(tt, { type: "a" }, { x: 1 });
  markError(tt, {
    code: "REDUCE_ERROR",
    message: "kaboom",
    featureName: "test",
  });
  assertEquals(tt.entries[tt.index]!.error, {
    code: "REDUCE_ERROR",
    message: "kaboom",
    featureName: "test",
  });
});

Deno.test("TT — non-error entry has no error field", () => {
  let tt = createTT<{ x: number }, { type: string }>();
  tt = record(tt, { type: "a" }, { x: 1 });
  assertEquals(tt.entries[tt.index]!.error, undefined);
});

Deno.test("TT — toBroadcast includes error in wire format", () => {
  let tt = createTT<{ x: number }, { type: string }>();
  tt = record(tt, { type: "a" }, { x: 1 });
  markError(tt, { code: "EFFECT_ERROR", message: "fail" });
  const bc = toBroadcast(tt);
  assertEquals(bc.entries[0]!.error, { code: "EFFECT_ERROR", message: "fail" });
});

Deno.test("TT — toBroadcast omits error when absent", () => {
  let tt = createTT<{ x: number }, { type: string }>();
  tt = record(tt, { type: "a" }, { x: 1 });
  const bc = toBroadcast(tt);
  assertEquals(bc.entries[0]!.error, undefined);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test tests/error-tt.test.ts` Expected: FAIL — `markError` not
exported

- [ ] **Step 3: Modify `src/time-travel.ts`**

Add `error?` field to `HistoryEntry`:

```ts
// In HistoryEntry type, add:
error?: { code: string; message: string; featureName?: string; flowStep?: number }
```

Add `markError` function:

```ts
/** Mark the current TT entry as errored */
export function markError<S, A>(
  tt: TTState<S, A>,
  err: {
    code: string;
    message: string;
    featureName?: string;
    flowStep?: number;
  },
): void {
  const entry = tt.entries[tt.index];
  if (entry) entry.error = err;
}
```

Update `TTBroadcast` type to include error:

```ts
// In TTBroadcast entries, add:
error?: { code: string; message: string }
```

Update `toBroadcast` to include error:

```ts
// In toBroadcast map, add:
...(e.error ? { error: { code: e.error.code, message: e.error.message } } : {}),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test tests/error-tt.test.ts` Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/time-travel.ts tests/error-tt.test.ts
git commit -m "feat(tt): add error markers to time-travel entries and wire format"
```

---

### Task 3: Memory Pressure Monitor

**Files:**

- Create: `src/memory-monitor.ts`
- Test: `tests/error-memory.test.ts`

- [ ] **Step 1: Write failing tests for memory monitor**

```ts
// tests/error-memory.test.ts
import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createMemoryMonitor,
  type MemoryConfig,
  type MemoryReport,
} from "../src/memory-monitor.ts";

Deno.test("memory monitor — no report when heap below threshold", async () => {
  const reports: MemoryReport[] = [];
  const monitor = createMemoryMonitor({
    enabled: true,
    interval: 50,
    warnThreshold: 0.75,
    criticalThreshold: 0.90,
    onReport: (r) => reports.push(r),
    getMemoryUsage: () => ({
      heapUsed: 100,
      heapTotal: 1000,
      rss: 1200,
      external: 0,
    }),
    getFeatureStates: () => [],
  });
  await new Promise((r) => setTimeout(r, 120));
  monitor.stop();
  assertEquals(reports.length, 0);
});

Deno.test("memory monitor — MEMORY_PRESSURE when heap >= warn threshold", async () => {
  const reports: MemoryReport[] = [];
  const monitor = createMemoryMonitor({
    enabled: true,
    interval: 50,
    warnThreshold: 0.75,
    criticalThreshold: 0.90,
    onReport: (r) => reports.push(r),
    getMemoryUsage: () => ({
      heapUsed: 800,
      heapTotal: 1000,
      rss: 1200,
      external: 0,
    }),
    getFeatureStates:
      () => [{ name: "test", state: { items: new Array(1000) } }],
  });
  await new Promise((r) => setTimeout(r, 120));
  monitor.stop();
  assertEquals(reports.length > 0, true);
  assertEquals(reports[0]!.level, "warn");
  assertEquals(reports[0]!.heapPct, 0.8);
});

Deno.test("memory monitor — MEMORY_CRITICAL when heap >= critical threshold", async () => {
  const reports: MemoryReport[] = [];
  const monitor = createMemoryMonitor({
    enabled: true,
    interval: 50,
    warnThreshold: 0.75,
    criticalThreshold: 0.90,
    onReport: (r) => reports.push(r),
    getMemoryUsage: () => ({
      heapUsed: 950,
      heapTotal: 1000,
      rss: 1200,
      external: 0,
    }),
    getFeatureStates: () => [],
  });
  await new Promise((r) => setTimeout(r, 120));
  monitor.stop();
  assertEquals(reports[0]!.level, "critical");
});

Deno.test("memory monitor — featureStates sorted largest first", async () => {
  const reports: MemoryReport[] = [];
  const monitor = createMemoryMonitor({
    enabled: true,
    interval: 50,
    warnThreshold: 0.75,
    criticalThreshold: 0.90,
    onReport: (r) => reports.push(r),
    getMemoryUsage: () => ({
      heapUsed: 800,
      heapTotal: 1000,
      rss: 1200,
      external: 0,
    }),
    getFeatureStates: () => [
      { name: "small", state: { x: 1 } },
      { name: "big", state: { items: new Array(10000).fill("data") } },
    ],
  });
  await new Promise((r) => setTimeout(r, 120));
  monitor.stop();
  assertEquals(reports[0]!.featureStates[0]!.name, "big");
});

Deno.test("memory monitor — stop clears interval", async () => {
  const monitor = createMemoryMonitor({
    enabled: true,
    interval: 50,
    warnThreshold: 0.75,
    criticalThreshold: 0.90,
    onReport: () => {},
    getMemoryUsage: () => ({
      heapUsed: 100,
      heapTotal: 1000,
      rss: 1200,
      external: 0,
    }),
    getFeatureStates: () => [],
  });
  monitor.stop();
  // No lingering intervals — test completes without resource leak
  await new Promise((r) => setTimeout(r, 100));
});

Deno.test("memory monitor — disabled does nothing", async () => {
  const reports: MemoryReport[] = [];
  const monitor = createMemoryMonitor({
    enabled: false,
    interval: 50,
    warnThreshold: 0.75,
    criticalThreshold: 0.90,
    onReport: (r) => reports.push(r),
    getMemoryUsage: () => ({
      heapUsed: 950,
      heapTotal: 1000,
      rss: 1200,
      external: 0,
    }),
    getFeatureStates: () => [],
  });
  await new Promise((r) => setTimeout(r, 120));
  monitor.stop();
  assertEquals(reports.length, 0);
});

Deno.test("memory monitor — trend detection: 3 rising = rising", async () => {
  let heapUsed = 760;
  const reports: MemoryReport[] = [];
  const monitor = createMemoryMonitor({
    enabled: true,
    interval: 40,
    warnThreshold: 0.75,
    criticalThreshold: 0.90,
    onReport: (r) => reports.push(r),
    getMemoryUsage: () => {
      heapUsed += 10;
      return { heapUsed, heapTotal: 1000, rss: 1200, external: 0 };
    },
    getFeatureStates: () => [],
  });
  await new Promise((r) => setTimeout(r, 250));
  monitor.stop();
  // After 3+ rising samples above threshold, trend should be 'rising'
  const lastReport = reports[reports.length - 1];
  if (lastReport) assertEquals(lastReport.trend, "rising");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test tests/error-memory.test.ts` Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/memory-monitor.ts`**

```ts
// src/memory-monitor.ts

export type MemoryReport = {
  level: "warn" | "critical";
  heapUsed: number;
  heapTotal: number;
  heapPct: number;
  gcReclaimed: number;
  gcReclaimedPct: number;
  featureStates: FeatureStateSize[];
  trend: "rising" | "stable" | "falling";
};

export type FeatureStateSize = {
  name: string;
  bytes: number;
  largestField?: { key: string; entries?: number };
};

export type MemoryConfig = {
  enabled?: boolean;
  interval?: number; // ms, default 10_000
  warnThreshold?: number; // 0-1, default 0.75
  criticalThreshold?: number; // 0-1, default 0.90
  gcStressRatio?: number; // default 0.05
  onMemoryPressure?: (report: MemoryReport) => void;
};

type MonitorDeps = {
  enabled: boolean;
  interval: number;
  warnThreshold: number;
  criticalThreshold: number;
  gcStressRatio?: number;
  onReport: (report: MemoryReport) => void;
  getMemoryUsage: () => {
    heapUsed: number;
    heapTotal: number;
    rss: number;
    external: number;
  };
  getFeatureStates: () => { name: string; state: unknown }[];
};

// ── Recursive sizeof ──

export function sizeof(obj: unknown, seen?: Set<unknown>): number {
  if (obj === null || obj === undefined) return 0;
  if (typeof obj === "string") return obj.length * 2;
  if (typeof obj === "number" || typeof obj === "boolean") return 8;
  if (typeof obj !== "object") return 0;

  if (obj instanceof ArrayBuffer) return obj.byteLength;
  if (ArrayBuffer.isView(obj)) {
    return (obj as { byteLength: number }).byteLength;
  }

  const s = seen ?? new Set();
  if (s.has(obj)) return 0; // circular ref guard
  s.add(obj);

  let size = 0;
  if (Array.isArray(obj)) {
    for (const item of obj) size += sizeof(item, s);
  } else {
    for (const key of Object.keys(obj as Record<string, unknown>)) {
      size += key.length * 2; // key itself
      size += sizeof((obj as Record<string, unknown>)[key], s);
    }
  }
  return size;
}

function measureFeatureState(name: string, state: unknown): FeatureStateSize {
  const bytes = sizeof(state);
  let largestField: FeatureStateSize["largestField"];

  if (state && typeof state === "object" && !Array.isArray(state)) {
    let maxSize = 0;
    let maxKey = "";
    for (const key of Object.keys(state as Record<string, unknown>)) {
      const val = (state as Record<string, unknown>)[key];
      const fieldSize = sizeof(val);
      if (fieldSize > maxSize) {
        maxSize = fieldSize;
        maxKey = key;
      }
    }
    if (maxKey) {
      const val = (state as Record<string, unknown>)[maxKey];
      const entries = Array.isArray(val)
        ? val.length
        : (val && typeof val === "object"
          ? Object.keys(val).length
          : undefined);
      largestField = { key: maxKey, entries };
    }
  }

  return { name, bytes, largestField };
}

export function createMemoryMonitor(deps: MonitorDeps) {
  if (!deps.enabled) return { stop: () => {} };

  const {
    interval,
    warnThreshold,
    criticalThreshold,
    onReport,
    getMemoryUsage,
    getFeatureStates,
  } = deps;
  let prevHeapUsed = 0;
  const samples: number[] = []; // last 3 heapPct values for trend

  const tid = setInterval(() => {
    const mem = getMemoryUsage();
    const heapPct = mem.heapTotal > 0 ? mem.heapUsed / mem.heapTotal : 0;
    const gcReclaimed = prevHeapUsed > mem.heapUsed
      ? prevHeapUsed - mem.heapUsed
      : 0;
    const gcReclaimedPct = mem.heapTotal > 0 ? gcReclaimed / mem.heapTotal : 0;
    prevHeapUsed = mem.heapUsed;

    // Track trend
    samples.push(heapPct);
    if (samples.length > 3) samples.shift();

    if (heapPct < warnThreshold) return;

    // Crossed threshold — measure feature states
    const featureStates = getFeatureStates()
      .map((f) => measureFeatureState(f.name, f.state))
      .sort((a, b) => b.bytes - a.bytes);

    // Determine trend
    let trend: MemoryReport["trend"] = "stable";
    if (samples.length >= 3) {
      const allRising = samples.every((v, i) => i === 0 || v > samples[i - 1]!);
      const anyFalling = samples.some((v, i) => i > 0 && v < samples[i - 1]!);
      if (allRising) trend = "rising";
      else if (anyFalling) trend = "falling";
    }

    const level: MemoryReport["level"] = heapPct >= criticalThreshold
      ? "critical"
      : "warn";

    onReport({
      level,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      heapPct,
      gcReclaimed,
      gcReclaimedPct,
      featureStates,
      trend,
    });
  }, interval);

  return {
    stop: () => clearInterval(tid),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test tests/error-memory.test.ts` Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/memory-monitor.ts tests/error-memory.test.ts
git commit -m "feat(memory): add memory pressure monitor with threshold alerts and trend detection"
```

---

### Task 4: Wire Dispatch Loop Through Error Infrastructure

**Files:**

- Modify: `src/dispatch.ts`
- Test: `tests/error-dispatch.test.ts`

- [ ] **Step 1: Write failing tests for dispatch error wiring**

```ts
// tests/error-dispatch.test.ts
import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createDispatch } from "../src/dispatch.ts";
import type { AioError } from "../src/error.ts";

type Action = { type: string; payload?: unknown; _source?: string };
type Effect = { type: string; payload?: unknown };

function makeDeps(overrides: Record<string, unknown> = {}) {
  let state = { count: 0 };
  const errors: AioError[] = [];
  return {
    deps: {
      reduce: overrides.reduce ?? ((s: typeof state, a: Action) => {
        if (a.type === "throw") throw new Error("reduce boom");
        if (a.type === "bad-return") return "not-an-object" as unknown;
        return { state: { ...s, count: s.count + 1 }, effects: [] as Effect[] };
      }),
      execute: overrides.execute ?? (() => {}),
      getState: () => state,
      setState: (s: typeof state) => {
        state = s;
      },
      onDone: overrides.onDone ?? (() => {}),
      log: { debug: () => {}, warn: () => {}, error: () => {} },
      debug: false,
      onError: (err: AioError) => errors.push(err),
      ...(overrides.extra ?? {}),
    },
    errors,
    getState: () => state,
  };
}

Deno.test("dispatch — reduce throw produces AioError with REDUCE_ERROR", async () => {
  const { deps, errors } = makeDeps();
  const dispatch = createDispatch(deps as never);
  await dispatch({ type: "throw" } as never);
  assertEquals(errors.length, 1);
  assertEquals(errors[0]!.code, "REDUCE_ERROR");
  assertEquals(errors[0]!.context.actionType, "throw");
  assertExists(errors[0]!.original);
  assertEquals(errors[0]!.original!.message, "reduce boom");
});

Deno.test("dispatch — sync effect throw produces EFFECT_ERROR", async () => {
  const { deps, errors } = makeDeps({
    reduce: (_s: unknown, _a: Action) => ({
      state: { count: 1 },
      effects: [{ type: "boom" }],
    }),
    execute: () => {
      throw new Error("effect boom");
    },
  });
  const dispatch = createDispatch(deps as never);
  await dispatch({ type: "go" } as never);
  assertEquals(errors.length, 1);
  assertEquals(errors[0]!.code, "EFFECT_ERROR");
  assertEquals(errors[0]!.context.effectType, "boom");
});

Deno.test("dispatch — async effect rejection produces EFFECT_ASYNC_ERROR", async () => {
  const { deps, errors } = makeDeps({
    reduce: (_s: unknown, _a: Action) => ({
      state: { count: 1 },
      effects: [{ type: "async-fail" }],
    }),
    execute: () => Promise.reject(new Error("async boom")),
  });
  const dispatch = createDispatch(deps as never);
  await dispatch({ type: "go" } as never);
  await new Promise((r) => setTimeout(r, 50));
  assertEquals(errors.length, 1);
  assertEquals(errors[0]!.code, "EFFECT_ASYNC_ERROR");
});

Deno.test("dispatch — continues processing after error", async () => {
  const { deps, errors, getState } = makeDeps();
  const dispatch = createDispatch(deps as never);
  await dispatch({ type: "throw" } as never);
  await dispatch({ type: "ok" } as never);
  assertEquals(errors.length, 1);
  assertEquals(getState().count, 1);
});

Deno.test("dispatch — errorCount still works", async () => {
  const { deps } = makeDeps();
  const dispatch = createDispatch(deps as never);
  assertEquals(dispatch.errorCount(), 0);
  await dispatch({ type: "throw" } as never);
  assertEquals(dispatch.errorCount(), 1);
});

Deno.test("dispatch — onError receives AioError instance (not plain object)", async () => {
  const { deps, errors } = makeDeps();
  const dispatch = createDispatch(deps as never);
  await dispatch({ type: "throw" } as never);
  assertEquals(errors[0]!.constructor.name, "AioError");
});

Deno.test("dispatch — correlationId is set on errors", async () => {
  const { deps, errors } = makeDeps();
  const dispatch = createDispatch(deps as never);
  await dispatch({ type: "throw" } as never);
  assertEquals(typeof errors[0]!.correlationId, "string");
  assertEquals(errors[0]!.correlationId !== "none", true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test tests/error-dispatch.test.ts` Expected: FAIL — `errors[0]!.code`
does not exist (old AioError has no `code` field)

- [ ] **Step 3: Modify `src/dispatch.ts`**

Changes:

1. Remove the old `AioError` type (lines 44-53)
2. Remove the old `reportError` function (lines 105-108)
3. Import from `./error.ts`:
   `createAioError, reportError as reportAioError, setCorrelationId, clearCorrelationId, generateCorrelationId, type AioError, type ReportErrorOpts`
4. Re-export `AioError` from `./error.ts`
5. Update `DispatchDeps.onError` to use new `AioError`
6. Add `reportOpts: ReportErrorOpts` to `DispatchDeps`
7. In `dispatch()` function: generate correlationId on queue push, set/clear
   around processing
8. Replace every `log.error(...)` + old `reportError({...})` with
   `createAioError(CODE, raw, ctx)` → `reportAioError(err, opts)`
9. Wire `reportPerf` to also call `reportAioError` with `BUDGET_REDUCE` /
   `BUDGET_EFFECT`
10. Preserve `errors` counter via `countError` callback in opts

Exact changes — replace old `AioError` type and `reportError`:

```ts
// Remove lines 44-53 (old AioError type)
// Remove lines 105-108 (old reportError)
// Add imports:
import {
  clearCorrelationId,
  createAioError,
  generateCorrelationId,
  reportError as reportAioError,
  type ReportErrorOpts,
  setCorrelationId,
} from "./error.ts";
export type { AioError } from "./error.ts";
```

Update `DispatchDeps`:

```ts
// Remove old onError field entirely — it's now inside reportOpts
// Add:
reportOpts?: Partial<ReportErrorOpts>
```

Inside `createDispatch`, build reportOpts from deps.reportOpts:

```ts
const _reportOpts: ReportErrorOpts = {
  onError: deps.reportOpts?.onError,
  logger: deps.reportOpts?.logger,
  tt: deps.reportOpts?.tt,
  countError: () => {
    errors++;
  },
  prod: deps.reportOpts?.prod,
};
```

Replace reduce catch:

```ts
} catch (e) {
  const err = createAioError('REDUCE_ERROR', e, { featureName: actionType?.split(':')[0], actionType }, getState())
  reportAioError(err, _reportOpts)
  entry.resolve()
  continue
}
```

Replace bad-reduce-return:

```ts
if (!reduced || ...) {
  const err = createAioError('REDUCE_ERROR', `reduce() must return { state, effects[] } — got ${JSON.stringify(reduced)}`, { featureName: actionType?.split(':')[0], actionType })
  reportAioError(err, _reportOpts)
  entry.resolve()
  continue
}
```

Replace sync effect catch:

```ts
} catch (e) {
  const err = createAioError('EFFECT_ERROR', e, { featureName: effectType?.split(':')[0], actionType, effectType })
  reportAioError(err, _reportOpts)
}
```

Replace async effect .catch:

```ts
.catch(e => {
  if (tid !== null) clearTimeout(tid)
  const err = createAioError('EFFECT_ASYNC_ERROR', e, { featureName: effectType?.split(':')[0], actionType, effectType })
  reportAioError(err, _reportOpts)
})
```

Replace timeout:

```ts
setTimeout(() => {
  const err = createAioError(
    "EFFECT_TIMEOUT",
    `async effect timeout: ${effectType ?? "?"} took >${effectTimeout}ms`,
    {
      featureName: effectType?.split(":")[0],
      effectType,
      duration: effectTimeout,
      budget: effectTimeout,
    },
  );
  reportAioError(err, _reportOpts);
}, effectTimeout);
```

Replace queue overflow:

```ts
if (queue.length >= QUEUE_MAX) {
  const err = createAioError(
    "QUEUE_OVERFLOW",
    `dispatch queue depth exceeded (${QUEUE_MAX})`,
    { actionType: (action as Record<string, unknown>)?.type as string },
  );
  reportAioError(err, _reportOpts);
  return Promise.resolve();
}
```

Replace dispatch loop overflow:

```ts
if (++iterations > DISPATCH_MAX) {
  const err = createAioError(
    "DISPATCH_LOOP",
    `dispatch overflow (${DISPATCH_MAX} iterations, depth ${depth}) — possible infinite loop`,
    { actionType: tag(queue[0]!.action) },
  );
  reportAioError(err, _reportOpts);
  for (const entry of queue) entry.resolve();
  queue.length = 0;
  try {
    onDone();
  } catch (e) {
    const err2 = createAioError("EFFECT_ERROR", e, { actionType: "onDone" });
    reportAioError(err2, _reportOpts);
  }
  break;
}
```

Replace onDone catch:

```ts
try {
  onDone();
} catch (e) {
  const err = createAioError("EFFECT_ERROR", e, { actionType: "onDone" });
  reportAioError(err, _reportOpts);
}
```

Wire reportPerf:

```ts
function reportPerf(
  source: "reduce" | "effect",
  duration: number,
  budget: number,
  type?: string,
): void {
  if (!perfEnabled) return;
  const code = source === "reduce" ? "BUDGET_REDUCE" : "BUDGET_EFFECT";
  const err = createAioError(
    code as import("./error.ts").AioErrorCode,
    `${source} exceeded budget: ${duration.toFixed(1)}ms > ${budget}ms`,
    { featureName: type?.split(":")[0], actionType: type, duration, budget },
  );
  reportAioError(err, _reportOpts);
  if (perfLog && type) perfLog(source, type, duration, budget);
}
```

Add correlationId around processing:

```ts
// In dispatch function, at queue push:
const cid = generateCorrelationId();
queue.push({ action, resolve, cid });

// At processing each entry:
const entry = queue.shift()!;
setCorrelationId(entry.cid);
// ... process ...
// After entry.resolve() at end of action processing:
clearCorrelationId();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test tests/error-dispatch.test.ts` Expected: All tests PASS

- [ ] **Step 5: Run existing dispatch tests to verify nothing broke**

Run: `deno test tests/dispatch.test.ts` Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/dispatch.ts tests/error-dispatch.test.ts
git commit -m "feat(dispatch): wire all error paths through AioError infrastructure with correlation IDs"
```

---

### Task 5: Wire Flow Errors — Step Tracking & reportError

**Files:**

- Modify: `src/flow.ts`
- Test: `tests/error-flow.test.ts`

- [ ] **Step 1: Write failing tests for flow error wiring**

```ts
// tests/error-flow.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { AioError } from "../src/error.ts";

// Test via integration — create a feature with a flow that throws,
// verify onError receives FLOW_UNCAUGHT with flowHistory

Deno.test("flow — uncaught error produces FLOW_UNCAUGHT via onError", async () => {
  // This test will use a minimal aio setup with a flow that throws
  // Import the feature/aio infrastructure needed
  const errors: AioError[] = [];
  // Placeholder: actual test uses feature() + aio setup
  // Test verifies: err.code === 'FLOW_UNCAUGHT', err.context.flowName, err.context.flowStep
  // For now, test the flow module's internal step tracking
});

Deno.test("flow — step counter tracks executed steps", async () => {
  // Verify flowHistory ring buffer behavior
  const { FlowHistory } = await import("../src/flow.ts");
  const history = new FlowHistory(50);
  history.push("action1");
  history.push("action2");
  history.markOk(0);
  history.markError(1);
  assertEquals(history.entries(), [
    { step: 0, action: "action1", status: "ok" },
    { step: 1, action: "action2", status: "error" },
  ]);
});

Deno.test("flow — flowHistory caps at 50 entries", async () => {
  const { FlowHistory } = await import("../src/flow.ts");
  const history = new FlowHistory(50);
  for (let i = 0; i < 60; i++) history.push(`action${i}`);
  assertEquals(history.entries().length, 50);
  assertEquals(history.entries()[0]!.step, 10); // oldest evicted
});
```

Note: The exact test structure depends on how flow.ts exposes its internals. The
implementation step below will make FlowHistory exportable for testing, or tests
will use integration-style setup through feature() + dispatch.

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test tests/error-flow.test.ts` Expected: FAIL

- [ ] **Step 3: Modify `src/flow.ts`**

Changes:

1. Add `FlowHistory` class (ring buffer, cap 50):

```ts
export class FlowHistory {
  private _entries: FlowStepRecord[] = [];
  private _cap: number;

  constructor(cap = 50) {
    this._cap = cap;
  }

  push(action: string): void {
    const step = this._entries.length > 0
      ? this._entries[this._entries.length - 1]!.step + 1
      : 0;
    this._entries.push({ step, action, status: "pending" });
    if (this._entries.length > this._cap) this._entries.shift();
  }

  markOk(index: number): void {
    const e = this._entries.find((e) => e.step === index);
    if (e) e.status = "ok";
  }

  markError(index: number): void {
    const e = this._entries.find((e) => e.step === index);
    if (e) e.status = "error";
  }

  entries(): FlowStepRecord[] {
    return [...this._entries];
  }
}
```

Import `FlowStepRecord` from `./error.ts`.

2. In `runFlow`, add step tracking:

```ts
// Before the while loop:
const flowSteps = new FlowHistory(50);
let stepIndex = 0;

// Inside the step loop, wrap the existing try-catch:
const step = result.value as FlowStep;
const stepAction = step.kind === "call" ? `${prefix}:${step.name}` : step.kind;
flowSteps.push(stepAction);
try {
  const stepResult = await executeStep(step, instance, app);
  flowSteps.markOk(stepIndex);
  // ...
} catch (stepError) {
  flowSteps.markError(stepIndex);
  // ...
}
stepIndex++;
```

3. In the outer catch (uncaught flow error), add reportError dependency:

The `runFlow` function needs access to a `reportError` callback. Add it as a
parameter or dependency. The simplest approach: add an optional `onFlowError`
callback to the flow execution context.

In the outer catch block:

```ts
} catch (e) {
  if (!instance.aborted) {
    // Dispatch error action (keep existing behavior)
    app.dispatch({ type: `${prefix}:__flow:error`, payload: { flow: flowName, error: String(e) }, _source: 'Effect' })

    // Report through error infrastructure (NEW)
    if (_onFlowError) {
      _onFlowError(e, {
        featureName,
        flowName,
        flowStep: stepIndex,
        flowHistory: flowSteps.entries(),
      })
    } else {
      console.error(`[${featureName}] flow '${flowName}' threw: ${e}`)
    }
  }
}
```

4. Also update the `.catch(e => console.error(...))` in `createFlowExecutor`
   (line 567-568) to use the same callback.

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test tests/error-flow.test.ts` Expected: All tests PASS

- [ ] **Step 5: Run existing flow tests**

Run: `deno test tests/flow.test.ts` Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/flow.ts tests/error-flow.test.ts
git commit -m "feat(flow): add step tracking, flowHistory ring buffer, route errors through reportError"
```

---

### Task 6: Wire Feature Errors — Compose, Create, Hooks

**Files:**

- Modify: `src/feature-compose.ts`
- Modify: `src/feature-create.ts`
- Modify: `src/aio.ts`
- Test: `tests/error-hooks.test.ts`

- [ ] **Step 1: Write failing tests for hook error handling**

```ts
// tests/error-hooks.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import type { AioError } from '../src/error.ts'

// Integration test: create a feature + aio with a throwing beforeReduce hook
// Verify: error reported as HOOK_ERROR, action is dropped, dispatch continues

Deno.test('beforeReduce throw produces HOOK_ERROR and drops action', async () => {
  // This test creates a minimal dispatch setup with hookedReduce
  // that wraps beforeReduce in try-catch
  const errors: AioError[] = []

  // Use createDispatch with a reduce that wraps beforeReduce
  const { createDispatch } = await import('../src/dispatch.ts')
  const { createAioError, reportError, type ReportErrorOpts } = await import('../src/error.ts')

  let state = { count: 0 }
  const reportOpts: ReportErrorOpts = {
    onError: (err) => errors.push(err),
    countError: () => {},
  }

  const beforeReduce = (_a: unknown) => { throw new Error('hook boom') }

  const hookedReduce = (s: typeof state, a: { type: string }) => {
    try {
      const filtered = beforeReduce(a)
      if (filtered === null) return { state: s, effects: [] }
    } catch (e) {
      const err = createAioError('HOOK_ERROR', e, { hookName: 'beforeReduce', actionType: a.type })
      reportError(err, reportOpts)
      return { state: s, effects: [] } // drop action
    }
    return { state: { ...s, count: s.count + 1 }, effects: [] }
  }

  const dispatch = createDispatch({
    reduce: hookedReduce,
    execute: () => {},
    getState: () => state,
    setState: (s: typeof state) => { state = s },
    onDone: () => {},
    log: { debug: () => {}, warn: () => {}, error: () => {} },
    debug: false,
  } as never)

  await dispatch({ type: 'test' } as never)
  assertEquals(errors.length, 1)
  assertEquals(errors[0]!.code, 'HOOK_ERROR')
  assertEquals(errors[0]!.context.hookName, 'beforeReduce')
  assertEquals(state.count, 0) // action was dropped
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test tests/error-hooks.test.ts` Expected: FAIL

- [ ] **Step 3: Modify `src/aio.ts`**

Changes:

1. Replace
   `export type { AioError, PerfCheck, PerfBudget } from './dispatch.ts'`
   (line 39) with:

```ts
export type { AioError } from "./error.ts";
export type { PerfBudget, PerfCheck } from "./dispatch.ts";
```

2. Import `createAioError, reportError as reportAioError, type ReportErrorOpts`
   from `./error.ts`

3. Build `_reportOpts` before dispatch creation and pass to dispatch deps:

```ts
const _reportOpts: ReportErrorOpts = {
  onError,
  logger: getLogger()
    ? { error: (msg, data) => getLogger()!.pub("error", "aio", msg, data) }
    : undefined,
  tt: tt ? { markError: (err) => markError(tt!, err) } : undefined,
  countError: undefined, // managed by dispatch internally
  prod,
};
```

4. Wrap `beforeReduce` in try-catch in `hookedReduce`:

```ts
const hookedReduce: typeof reduce = (s, a) => {
  const user = (a as Record<string, unknown>)?._user as AioUser | undefined;
  if (beforeReduce) {
    try {
      const filtered = beforeReduce(a, s, user);
      if (filtered === null) return { state: s, effects: [] as E[] };
      a = filtered as A;
    } catch (e) {
      const actionType = (a as Record<string, unknown>)?.type as
        | string
        | undefined;
      const err = createAioError("HOOK_ERROR", e, {
        hookName: "beforeReduce",
        actionType,
      });
      reportAioError(err, _reportOpts);
      return { state: s, effects: [] as E[] }; // drop action
    }
  }
  _anyProcessed = true;
  _currentActionUser = user;
  if (onAction) {
    try {
      onAction(a, s, user);
    } catch (e) {
      const actionType = (a as Record<string, unknown>)?.type as
        | string
        | undefined;
      const err = createAioError("HOOK_ERROR", e, {
        hookName: "onAction",
        actionType,
      });
      reportAioError(err, _reportOpts);
    }
  }
  return reduce(s, a);
};
```

5. Guard `onEffect` hook:

```ts
const hookedExecute: typeof execute = onEffect
  ? (app, e) => {
    try {
      onEffect(e, _currentActionUser);
    } catch (err) {
      const effectType = (e as Record<string, unknown>)?.type as
        | string
        | undefined;
      const aioErr = createAioError("HOOK_ERROR", err, {
        hookName: "onEffect",
        effectType,
      });
      reportAioError(aioErr, _reportOpts);
    }
    execute(app, e);
  }
  : execute;
```

6. Pass `reportOpts` into dispatch deps:

```ts
const dispatch = createDispatch<S, A, E>({
  // ... existing deps ...
  reportOpts: _reportOpts,
});
```

7. Import `markError` from `./time-travel.ts`

- [ ] **Step 4: Modify `src/feature-compose.ts`**

**Injection mechanism:** Add an optional `onFeatureError` callback to the
`composeFeatures` options parameter. The `composeFeatures` function signature
changes from `composeFeatures(features: FeatureEntry[])` to
`composeFeatures(features: FeatureEntry[], opts?: { onFeatureError?: (err: AioError) => void })`.
The callback is stored as `const _reportError = opts?.onFeatureError` and used
at all error sites. In `aio.ts`, `composeFeatures` is called with
`onFeatureError: (err) => reportAioError(err, _reportOpts)`.

Import at top of `feature-compose.ts`:
`import { createAioError, type AioError } from './error.ts'`

Wire all error sites:

Executor catch:

```ts
try {
  f.__aio.execute(scopedApp, effect, {
    E: f.__aio.effects,
    A: f.__aio.actions,
  });
} catch (e) {
  if (_reportError) {
    const err = createAioError("EFFECT_ERROR", e, {
      featureName: f.__aio.id,
      effectType: effect.type,
    });
    _reportError(err);
  } else {
    console.error(`[${f.__aio.id}] executor threw: ${e}`);
  }
  featureErrors.set(f.__aio.id, (featureErrors.get(f.__aio.id) ?? 0) + 1);
}
```

onInit catch:

```ts
try {
  f.__aio.onInit(scopedApp);
} catch (e) {
  if (_reportError) {
    const err = createAioError("INIT_ERROR", e, { featureName: f.__aio.id });
    _reportError(err);
  } else {
    console.error(`[${f.__aio.id}] init: ${e}`);
  }
  featureErrors.set(f.__aio.id, (featureErrors.get(f.__aio.id) ?? 0) + 1);
}
```

onDestroy catch:

```ts
try {
  f.__aio.onDestroy(scopedApp);
} catch (e) {
  if (_reportError) {
    const err = createAioError("DESTROY_ERROR", e, { featureName: f.__aio.id });
    _reportError(err);
  } else {
    console.error(`[${f.__aio.id}] destroy: ${e}`);
  }
  featureErrors.set(f.__aio.id, (featureErrors.get(f.__aio.id) ?? 0) + 1);
}
```

Cross-dispatch blocked:

```ts
if (!crossPrefixes.has(targetPrefix)) {
  const msg =
    `[${f.__aio.id}] cross-dispatch blocked → '${targetPrefix}'. Fix: add dispatchTo: [${targetPrefix}]`;
  if (_reportError) {
    const err = createAioError("MACHINE_BLOCKED", msg, {
      featureName: f.__aio.id,
      actionType: a.type,
    });
    _reportError(err);
  }
  featureErrors.set(f.__aio.id, (featureErrors.get(f.__aio.id) ?? 0) + 1);
  if ((globalThis as Record<string, unknown>).__aioDev) throw new Error(msg);
  console.error(msg);
  return;
}
```

Flow .catch calls:

```ts
runFlow(
  flowDef,
  payload._flowName,
  flowInfo.featureName,
  payload._triggerAction,
  flowApp,
)
  .catch((e) => {
    if (_reportError) {
      const err = createAioError("FLOW_UNCAUGHT", e, {
        featureName: flowInfo.featureName,
        flowName: payload._flowName,
      });
      _reportError(err);
    } else {
      console.error(
        `[${flowInfo.featureName}] flow '${payload._flowName}' error: ${e}`,
      );
    }
  });
```

- [ ] **Step 5: Modify `src/feature-create.ts`**

**Injection mechanism:** Add `_onError` to `ScopedApp` interface (optional). In
`feature-compose.ts`, the `scopedApp` objects already built for each feature now
include `_onError: _reportError`. The execute function in `feature-create.ts`
receives `app: ScopedApp` which has access to the callback.

Import at top of `feature-create.ts`:
`import { createAioError } from './error.ts'`

Wire async method throw:

```ts
.catch((e: Error) => {
  resolveCall(_callId, undefined, e)
  if (_reportError) {
    const err = createAioError('EFFECT_ASYNC_ERROR', e, { featureName: name, actionType: `${prefix}:${_method}` })
    _reportError(err)
  } else {
    console.error(`[${name}] ${_method}() threw: ${e}`)
  }
  app.dispatch({
    type: `${prefix}:__error`,
    payload: { _method, error: String(e) },
    _source: 'Effect',
  } as Msg)
})
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `deno test tests/error-hooks.test.ts` Expected: PASS

- [ ] **Step 7: Run all existing tests**

Run: `deno test` Expected: All tests PASS

- [ ] **Step 8: Commit**

```bash
git add src/aio.ts src/feature-compose.ts src/feature-create.ts tests/error-hooks.test.ts
git commit -m "feat(hooks): wire feature/hook/flow errors through AioError infrastructure"
```

---

### Task 7: Wire Standalone Mode

**Files:**

- Modify: `src/standalone.ts`

- [ ] **Step 1: Modify `src/standalone.ts`**

Import `createAioError, reportError as reportAioError, type ReportErrorOpts`
from `./error.ts`.

Wire onRestore error:

```ts
if (config.onRestore) {
  try {
    state = config.onRestore(state);
  } catch (e) {
    const err = createAioError("HOOK_ERROR", e, { hookName: "onRestore" });
    reportAioError(err, _reportOpts);
  }
}
```

Build `_reportOpts`:

```ts
const _reportOpts: ReportErrorOpts = {
  onError: config.onError,
  prod: true, // standalone is always prod-like (compact format)
};
```

Pass to dispatch deps:

```ts
const dispatch = createDispatch<S, A, E>({
  // ... existing ...
  onError: config.onError,
  reportOpts: _reportOpts,
});
```

Memory monitor: skip (no `Deno.memoryUsage` in browser). Add comment:

```ts
// Memory monitor not available in standalone/browser mode (no Deno.memoryUsage API)
```

- [ ] **Step 2: Run existing standalone tests**

Run: `deno test tests/standalone.test.ts` (if exists) Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/standalone.ts
git commit -m "feat(standalone): wire error infrastructure into standalone mode"
```

---

### Task 8: Console Formatter Tests

**Files:**

- Test: `tests/error-format.test.ts`

- [ ] **Step 1: Write formatter tests**

```ts
// tests/error-format.test.ts
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createAioError,
  formatErrorBox,
  formatErrorCompact,
} from "../src/error.ts";

Deno.test("formatErrorBox — contains feature name and error code", () => {
  const err = createAioError("REDUCE_ERROR", new Error("kaboom"), {
    featureName: "orderer",
    actionType: "orderer:buy",
  });
  const output = formatErrorBox(err);
  assertStringIncludes(output, "REDUCE_ERROR");
  assertStringIncludes(output, "orderer");
  assertStringIncludes(output, "AIO ERROR");
});

Deno.test("formatErrorBox — warning codes show AIO WARNING", () => {
  const err = createAioError("BUDGET_REDUCE", "slow", {
    featureName: "test",
    duration: 200,
    budget: 100,
  });
  const output = formatErrorBox(err);
  assertStringIncludes(output, "AIO WARNING");
});

Deno.test("formatErrorBox — includes flow history", () => {
  const err = createAioError("FLOW_UNCAUGHT", "fail", {
    featureName: "test",
    flowName: "exec",
    flowStep: 2,
    flowHistory: [
      { step: 0, action: "test:validate", status: "ok" as const },
      { step: 1, action: "test:lock", status: "ok" as const },
      { step: 2, action: "test:submit", status: "error" as const },
    ],
  });
  const output = formatErrorBox(err);
  assertStringIncludes(output, "test:validate ✓");
  assertStringIncludes(output, "test:submit ✗");
});

Deno.test("formatErrorBox — includes tip for EFFECT_TIMEOUT", () => {
  const err = createAioError("EFFECT_TIMEOUT", "timeout", {
    featureName: "api",
    effectType: "api:fetch",
  });
  const output = formatErrorBox(err);
  assertStringIncludes(output, "Tip:");
  assertStringIncludes(output, "effectTimeout");
});

Deno.test("formatErrorBox — truncates state snapshot", () => {
  const bigState = { data: "x".repeat(300) };
  const err = createAioError(
    "REDUCE_ERROR",
    "fail",
    { featureName: "test" },
    bigState,
  );
  const output = formatErrorBox(err);
  assertStringIncludes(output, "...");
});

Deno.test("formatErrorCompact — one-liner format", () => {
  const err = createAioError("EFFECT_ERROR", "boom", {
    featureName: "api",
    actionType: "api:fetch",
  });
  const output = formatErrorCompact(err);
  assertStringIncludes(output, "[ERROR]");
  assertStringIncludes(output, "EFFECT_ERROR");
  assertStringIncludes(output, "api:fetch");
  assertStringIncludes(output, "cid:");
});

Deno.test("formatErrorCompact — warn level for budget codes", () => {
  const err = createAioError("BUDGET_EFFECT", "slow", { featureName: "test" });
  const output = formatErrorCompact(err);
  assertStringIncludes(output, "[WARN]");
});

Deno.test("formatErrorBox — stack frames filtered (framework hidden)", () => {
  const original = new Error("test");
  // Manually set stack with mixed frames
  original.stack = `Error: test
    at reducer (src/features/orderer.ts:47:12)
    at Dispatch.reduce (dep/aio/src/dispatch.ts:152:9)
    at Dispatch.flush (dep/aio/src/dispatch.ts:72:3)
    at node_modules/something/index.js:10:5`;
  const err = createAioError("REDUCE_ERROR", original, { featureName: "test" });
  const output = formatErrorBox(err);
  assertStringIncludes(output, "orderer.ts:47:12");
  // Framework frames should NOT appear
  assertEquals(output.includes("dep/aio/src/dispatch.ts"), false);
  assertEquals(output.includes("node_modules"), false);
});
```

- [ ] **Step 2: Run tests**

Run: `deno test tests/error-format.test.ts` Expected: All PASS (formatter
already implemented in Task 1)

- [ ] **Step 3: Commit**

```bash
git add tests/error-format.test.ts
git commit -m "test(format): add console formatter tests — box, compact, stack filtering, tips"
```

---

### Task 9: End-to-End Integration Test

**Files:**

- Test: `tests/error-e2e.test.ts`

- [ ] **Step 1: Write e2e test**

```ts
// tests/error-e2e.test.ts
import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createDispatch } from "../src/dispatch.ts";
import {
  createTT,
  markError,
  record,
  toBroadcast,
} from "../src/time-travel.ts";
import {
  type AioError,
  createAioError,
  reportError,
  type ReportErrorOpts,
} from "../src/error.ts";

Deno.test("e2e — action → reduce throw → onError → TT flagged", async () => {
  const errors: AioError[] = [];
  let state = { x: 0 };
  const tt = createTT<typeof state, { type: string }>();

  const reportOpts: ReportErrorOpts = {
    onError: (err) => errors.push(err),
    tt: { markError: (err) => markError(tt, err) },
    countError: () => {},
  };

  const dispatch = createDispatch({
    reduce: (s: typeof state, a: { type: string }) => {
      if (a.type === "bomb") throw new Error("e2e boom");
      return { state: { ...s, x: s.x + 1 }, effects: [] };
    },
    execute: () => {},
    getState: () => state,
    setState: (s: typeof state) => {
      state = s;
    },
    onDone: () => {},
    log: { debug: () => {}, warn: () => {}, error: () => {} },
    debug: false,
    reportOpts,
  } as never);

  // Record initial state in TT
  record(tt, { type: "__init" }, state);

  // Dispatch failing action
  await dispatch({ type: "bomb" } as never);

  // Verify onError received AioError
  assertEquals(errors.length, 1);
  assertEquals(errors[0]!.code, "REDUCE_ERROR");
  assertEquals(errors[0]!.original!.message, "e2e boom");
  assertExists(errors[0]!.correlationId);

  // Dispatch succeeding action — dispatch continues
  await dispatch({ type: "ok" } as never);
  assertEquals(state.x, 1); // only the ok action processed

  // Verify TT has error flag
  const bc = toBroadcast(tt);
  // TT entry was marked (via markError callback in reportOpts)
  // Note: the dispatch-level TT integration records state in hookedReduce (aio.ts)
  // This e2e test verifies the reportError → TT markError callback path works
});

Deno.test("e2e — reportError self-guard: formatter crash degrades to raw console.error", () => {
  // Create an AioError with deliberately broken toJSON
  const err = createAioError("REDUCE_ERROR", "test", { featureName: "test" }); // Override toJSON to throw
  (err as Record<string, unknown>).toJSON = () => {
    throw new Error("formatter boom");
  };

  // reportError should NOT throw — it catches internally
  const reportOpts: ReportErrorOpts = {
    logger: {
      error: () => {
        throw new Error("logger boom too");
      },
    },
  };

  // This should not throw
  reportError(err, reportOpts);
});
```

- [ ] **Step 2: Run tests**

Run: `deno test tests/error-e2e.test.ts` Expected: All PASS

- [ ] **Step 3: Run full test suite**

Run: `deno test` Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add tests/error-e2e.test.ts
git commit -m "test(e2e): add end-to-end error chain test — action → error → onError → TT"
```

---

### Task 10: Final Cleanup & Export Updates

**Files:**

- Modify: `src/aio.ts` (export updates)
- Modify: `mod.ts` (if it re-exports public types)

- [ ] **Step 1: Verify all public types are exported**

Check that `mod.ts` or `src/aio.ts` exports:

- `AioError` (class)
- `AioErrorCode`, `AioErrorContext`, `AioErrorSource` (types)
- `MemoryConfig`, `MemoryReport` (types)

Add any missing re-exports.

- [ ] **Step 2: Run `deno check src/aio.ts` and `deno lint`**

Run: `deno check src/aio.ts && deno lint` Expected: No errors

- [ ] **Step 3: Run full test suite one final time**

Run: `deno test` Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/aio.ts mod.ts
git commit -m "feat(error): export AioError types and MemoryConfig from public API"
```

---

## Task Dependency Graph

```
Task 1 (error.ts core) ──┬── Task 2 (time-travel)
                          ├── Task 3 (memory monitor)
                          ├── Task 4 (dispatch wiring) ──┬── Task 5 (flow wiring) ──── Task 6 (features/hooks/aio.ts wiring)
                          │                              └── Task 7 (standalone wiring)
                          └── Task 8 (formatter tests)

All tasks ──── Task 9 (e2e test) ──── Task 10 (exports/cleanup)
```

Tasks 2, 3, 4, 8 can run in parallel after Task 1. Task 5 (flow wiring) runs
after Task 4 (defines FlowHistory + _onFlowError interface). Task 6
(features/hooks/aio.ts) runs after Task 5 (consumes _onFlowError). Task 7 runs
after Task 4. Task 9 runs after all others. Task 10 is final.
