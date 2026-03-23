# AIO Error Infrastructure — Design Spec

**Date:** 2026-03-23 **Status:** Approved **Scope:** Phase 1 — First-class error
reporting, handling, and debugging

---

## Mission

Make debugging AIO applications a piece of cake. Every error must tell the
developer **where** it happened, **what** state the app was in, **why** it might
have happened, and **how** to fix it.

## Principles

1. **Errors are never swallowed** — every error flows through `reportError()`,
   hits `onError`, appears in logs, and flags time-travel
2. **Stack traces are sacred** — original `Error.stack` is always preserved,
   never stringified away
3. **Context over noise** — errors show feature name, action type, flow step,
   machine state. Framework internals are filtered from stack traces
4. **Correlation** — every action gets a correlation ID that traces through its
   entire lifecycle (reduce → effects → cross-feature calls)
5. **Progressive detail** — console shows the essential box, logs have full
   JSONL, browser overlay has interactive detail
6. **The error system never crashes the app** — `reportError` itself is guarded
   with fallback to raw console output

---

## 1. AioError Class Hierarchy

### Breaking Change: Replaces Existing `AioError` Type

The existing `AioError` type alias in `dispatch.ts:45-53` is a flat object
(`{ source, error?, actionType?, effectType?, duration?, budget?, message? }`).
It is re-exported from `aio.ts:39` and consumed by `onError` callbacks in
`AioConfig`.

**Migration:** The new `AioError` class replaces this type entirely. This is a
**breaking change** for `onError` consumers:

- `err.source` — preserved, expanded with new sources (`'flow'`, `'hook'`,
  `'init'`, `'destroy'`, `'memory'`, `'dispatch'`). Old `'performance'` maps to
  `source: 'reduce'` or `'effect'` with `code: 'BUDGET_REDUCE'` /
  `'BUDGET_EFFECT'`
- `err.error` → `err.original` (the raw thrown error)
- `err.actionType` → `err.context.actionType`
- `err.effectType` → `err.context.effectType`
- `err.duration` → `err.context.duration`
- `err.budget` → `err.context.budget`
- `err.message` — preserved (inherited from `Error`)
- New fields: `err.code`, `err.context`, `err.correlationId`,
  `err.stateSnapshot`, `err.timestamp`

This ships with v1.0.0-alpha3. Existing `onError` callbacks must update field
access patterns.

### Core Type

```ts
// src/error.ts

class AioError extends Error {
  readonly code: AioErrorCode;
  readonly source: AioErrorSource;
  readonly context: AioErrorContext;
  readonly original?: Error;
  readonly timestamp: number;
  readonly correlationId: string;
  readonly stateSnapshot?: unknown;
}
```

### Error Context

```ts
type AioErrorContext = {
  featureName?: string;
  actionType?: string;
  effectType?: string;
  flowName?: string;
  flowStep?: number;
  hookName?: string; // 'beforeReduce' | 'onAction' | 'onEffect'
  duration?: number;
  budget?: number;
  machineState?: string;
  callStack?: string[]; // async call chain
};
```

### Error Codes

```ts
type AioErrorCode =
  | "REDUCE_ERROR" // reducer threw
  | "EFFECT_ERROR" // sync effect threw
  | "EFFECT_TIMEOUT" // async effect exceeded timeout
  | "EFFECT_ASYNC_ERROR" // async effect rejected
  | "FLOW_STEP_ERROR" // flow generator step threw
  | "FLOW_UNCAUGHT" // flow threw without user catch
  | "HOOK_ERROR" // beforeReduce/onAction/onEffect threw
  | "INIT_ERROR" // feature onInit threw
  | "DESTROY_ERROR" // feature onDestroy threw
  | "MACHINE_BLOCKED" // action blocked by state machine (warn-level)
  | "QUEUE_OVERFLOW" // dispatch queue exceeded limit
  | "DISPATCH_LOOP" // infinite loop detected
  | "MEMORY_PRESSURE" // heap approaching limit
  | "MEMORY_CRITICAL" // heap critical, GC ineffective
  | "BUDGET_REDUCE" // reducer exceeded perf budget
  | "BUDGET_EFFECT"; // effect exceeded perf budget

type AioErrorSource =
  | "reduce"
  | "effect"
  | "flow"
  | "hook"
  | "init"
  | "destroy"
  | "memory"
  | "dispatch"
  | "machine";
```

Note: `MACHINE_BLOCKED` uses `source: 'machine'`. It is warn-level, not
error-level — routed through `reportError` but with `level: 'warn'` so it
doesn't trigger error-level alerting.

### Factory

```ts
function createAioError(
  code: AioErrorCode,
  raw: unknown,
  ctx: Partial<AioErrorContext>,
): AioError;
```

Responsibilities:

- Extract `.stack` from raw error (or synthesize one if raw is string/object)
- Attach correlation ID from current dispatch context
- Snapshot relevant state at moment of error
- Generate contextual "Tip" based on code + context pattern matching

---

## 2. Developer Experience — Error Output Examples

### Reducer Throw (dev console)

```
┌─ AIO ERROR ─────────────────────────────────────────────────
│ REDUCE_ERROR in feature 'orderer'
│ Action: orderer:placeOrder
│ Machine state: idle → (blocked, expected: ready)
│
│ Error: Cannot read property 'price' of undefined
│
│ at orderer.reduce (src/features/orderer.ts:47:12)
│
│ State at crash:
│   { status: 'idle', orders: [], lastPrice: null }
│
│ Correlation: abc-123
│ Tip: 'price' is undefined — check if the action payload
│      has the expected shape. Machine was in 'idle' state,
│      did you mean to guard this action to 'ready' only?
└──────────────────────────────────────────────────────────────
```

### Async Effect Timeout

```
┌─ AIO ERROR ─────────────────────────────────────────────────
│ EFFECT_TIMEOUT in feature 'orderer'
│ Action: orderer:placeOrder → effect: orderer:submitToExchange
│ Waiting: 30.0s (timeout: 30s)
│
│ Called from:
│   orderer.placeOrder() → orderer.submitToExchange()
│
│ Still pending — effect has NOT been cancelled.
│ Correlation: abc-123
│ Tip: If this is expected (slow API), increase timeout:
│      feature('orderer', { effectTimeout: 60_000, ... })
└──────────────────────────────────────────────────────────────
```

### Flow Step Failure

```
┌─ AIO ERROR ─────────────────────────────────────────────────
│ FLOW_STEP_ERROR in feature 'orderer'
│ Flow: executionFlow (step 3)
│ Step action: orderer:submitToExchange
│
│ Error: exchange rejected — insufficient margin
│
│ at executionFlow (src/features/orderer.ts:89:18)
│
│ Flow history (last 50 steps):
│   step 1: orderer:validateOrder ✓
│   step 2: orderer:lockFunds ✓
│   step 3: orderer:submitToExchange ✗ ← failed here
│
│ Correlation: abc-123
│ Tip: Unhandled in flow — wrap step 3 in try/catch inside
│      your generator to handle exchange rejections gracefully.
└──────────────────────────────────────────────────────────────
```

### Memory Pressure

```
┌─ AIO WARNING ────────────────────────────────────────────────
│ MEMORY_PRESSURE — heap at 78% (1.56 GB / 2.0 GB)
│ GC reclaimed only 2.1% on last cycle
│
│ Top features by state size:
│   1. barHistory  — 847 MB (state.candles: 1,240,000 entries)
│   2. orderer     — 12 MB
│   3. portfolio   — 3 MB
│
│ Tip: barHistory.state.candles is growing unbounded.
│      Consider pruning old entries or using external storage.
└──────────────────────────────────────────────────────────────
```

### Prod Console (compact)

```
[ERROR] REDUCE_ERROR orderer:placeOrder — Cannot read property 'price' of undefined (cid:abc-123)
```

### Log Files (JSONL)

```jsonl
{"ts":"14:22:35.1","code":"REDUCE_ERROR","feature":"orderer","action":"orderer:placeOrder","cid":"abc-123","msg":"Cannot read property 'price' of undefined","stack":"at orderer.reduce (src/features/orderer.ts:47:12)\n..."}
```

---

## 3. Error Capture & Wiring

### Single Exit Point — Replaces Existing `reportError` in `dispatch.ts`

`dispatch.ts:105-108` currently has a local `reportError()` that increments an
`errors` counter and calls `onError`. This is replaced by the new global
`reportError()` in `src/error.ts`, which absorbs its responsibilities:

```ts
function reportError(
  err: AioError,
  opts: { onError?; logger?; tt?; registry? },
): void {
  // 1. Console: pretty box (dev) or one-liner (prod)
  // 2. Logger: structured JSONL to error.log + app.log
  // 3. onError hook: user callback gets full AioError
  // 4. Time-travel: flag current entry as errored
  // 5. Health: increment feature error counter via registry
  // 6. Error counter: dispatch.errorCount() still works — counter lives in dispatch state, incremented by reportError via callback
}
```

The `errors` counter and `dispatch.errorCount()` API are preserved. The new
`reportError` receives a `countError` callback from the dispatch loop that
increments the counter, maintaining the existing public API.

`reportError` wraps itself in try-catch — if formatting fails, falls back to
`console.error(raw)`.

### Wiring Map

References use function/pattern names for stability (line numbers are
approximate and may drift):

| Location                                             | Current                                                               | After                                                                                                                                                             |
| ---------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dispatch.ts` — reduce try-catch                     | `console.error(\`reduce error...\`)`                                  | `createAioError('REDUCE_ERROR', e, { featureName, actionType, machineState })` → `reportError()`                                                                  |
| `dispatch.ts` — async effect `.catch()`              | `.catch(e => console.error(...))`                                     | `createAioError('EFFECT_ASYNC_ERROR', e, { featureName, actionType, effectType })` → `reportError()`                                                              |
| `dispatch.ts` — effect timeout warning               | `console.warn(\`timeout\`)`                                           | `createAioError('EFFECT_TIMEOUT', ...)` → `reportError()`                                                                                                         |
| `dispatch.ts` — `QUEUE_MAX` exceeded                 | `console.error(\`queue overflow\`)`                                   | `createAioError('QUEUE_OVERFLOW', ...)` → `reportError()`                                                                                                         |
| `dispatch.ts` — `DISPATCH_MAX` exceeded              | `console.error(\`dispatch loop\`)`                                    | `createAioError('DISPATCH_LOOP', ...)` → `reportError()`                                                                                                          |
| `dispatch.ts` — bad reduce return                    | `log.error(\`reduce() must return...\`)`                              | `createAioError('REDUCE_ERROR', null, { featureName, actionType })` → `reportError()` with tip: "reduce() must return { state, effects[] }"                       |
| `dispatch.ts` — `onDone` error                       | `reportError({ source: 'effect' })`                                   | `createAioError('EFFECT_ERROR', e, { featureName, actionType })` → new `reportError()`                                                                            |
| `dispatch.ts` — `reportPerf()` budget                | `perfLog()` only                                                      | Also `createAioError('BUDGET_REDUCE' / 'BUDGET_EFFECT', ...)` → `reportError()`                                                                                   |
| `flow.ts` — step execution try-catch                 | `gen.throw(e)`                                                        | Track `flowStep`, on uncaught → `createAioError('FLOW_UNCAUGHT', e, { flowName, flowStep, flowHistory })` → `reportError()`                                       |
| `flow.ts` — `createFlowExecutor` `.catch()`          | `.catch(e => console.error(...))`                                     | Route through `reportError()` with `FLOW_STEP_ERROR`                                                                                                              |
| `feature-compose.ts` — `rootExecute` flow `.catch()` | `.catch(e => console.error(...))`                                     | Route through `reportError()` with `FLOW_STEP_ERROR` (second call site, same treatment)                                                                           |
| `feature-compose.ts` — executor try-catch            | `console.error(\`executor threw\`)`                                   | `createAioError('EFFECT_ERROR', e, { featureName })` → `reportError()`                                                                                            |
| `feature-compose.ts` — onInit try-catch              | `console.error(\`init\`)`                                             | `createAioError('INIT_ERROR', e, { featureName })` → `reportError()`                                                                                              |
| `feature-compose.ts` — onDestroy try-catch           | `console.error(\`destroy\`)`                                          | `createAioError('DESTROY_ERROR', e, { featureName })` → `reportError()`                                                                                           |
| `feature-compose.ts` — cross-dispatch blocked        | `console.error(msg)`                                                  | `createAioError('MACHINE_BLOCKED', null, { featureName, actionType })` → `reportError()` (warn-level)                                                             |
| `feature-create.ts` — async method throw             | `console.error(\`[${name}] ${method}() threw\`)`+ dispatches`__error` | `createAioError('EFFECT_ASYNC_ERROR', e, { featureName, actionType: method })` → `reportError()`. Still dispatches `__error` action for state machine transitions |
| `aio.ts` — beforeReduce (NO try-catch)               | unguarded                                                             | **Add** try-catch → `createAioError('HOOK_ERROR', e, { hookName: 'beforeReduce' })`, action dropped                                                               |
| `aio.ts` — onAction hook catch                       | `log.error(\`hook onAction: ${e}\`)`                                  | `createAioError('HOOK_ERROR', e, { hookName: 'onAction' })` → `reportError()`                                                                                     |
| `aio.ts` — onEffect hook catch                       | `log.error(\`hook onEffect: ${e}\`)`                                  | `createAioError('HOOK_ERROR', e, { hookName: 'onEffect' })` → `reportError()`                                                                                     |

### Correlation ID Propagation

- Generated at dispatch queue entry:
  `correlationId = crypto.randomUUID().slice(0, 8)` (Deno built-in, no external
  dependency)
- Stored on queue entry, available via dispatch-scoped context
- Effects inherit parent's correlationId
- Cross-feature calls: child ID = `parentId.N` (e.g., `abc123.1`)
- `createAioError` reads current correlationId automatically

### Flow Step Tracking

```ts
let stepIndex = 0;
const flowHistory: FlowStepRecord[] = []; // ring buffer, cap 50

// On each yield:
flowHistory.push({ step: stepIndex, action: value.type, status: "pending" });
// On success: flowHistory[stepIndex].status = 'ok'
// On error:   flowHistory[stepIndex].status = 'error'
stepIndex++;
```

Flow history is attached to `AioError` on uncaught flow errors.

---

## 4. Memory Pressure Monitor

### Configuration

```ts
type MemoryConfig = {
  enabled?: boolean; // default: true (everywhere)
  interval?: number; // sampling interval ms, default: 10_000
  warnThreshold?: number; // % of heap, default: 0.75
  criticalThreshold?: number; // default: 0.90
  gcStressRatio?: number; // default: 0.05 (if freed < 5%, GC stressed)
  onMemoryPressure?: (report: MemoryReport) => void;
};
```

### Report

```ts
type MemoryReport = {
  level: "warn" | "critical";
  heapUsed: number;
  heapTotal: number;
  heapPct: number;
  gcReclaimed: number;
  gcReclaimedPct: number;
  featureStates: FeatureStateSize[]; // sorted largest first
  trend: "rising" | "stable" | "falling";
};

type FeatureStateSize = {
  name: string;
  bytes: number;
  largestField?: { key: string; entries?: number };
};
```

### Behavior

- Samples `Deno.memoryUsage()` every `interval` ms (near-zero cost)
- Below threshold: store sample, do nothing
- At/above warn threshold: measure feature state sizes, build report, call
  `reportError(MEMORY_PRESSURE)` + `onMemoryPressure` callback
- At/above critical threshold: `MEMORY_CRITICAL`, logged to error.log (never
  deduplicated)
- Trend: 3 consecutive rising samples = `rising`, 3 stable = `stable`, any drop
  = `falling`
- State sizing: recursive `sizeof` walk (counts keys + string lengths + typed
  array byte lengths). Avoids `JSON.stringify` which would allocate huge strings
  for large states. Handles circular refs (seen set). Reports
  `ArrayBuffer.byteLength` directly
- Cleanup: interval cleared on `aio.close()`

### User API

```ts
aio.run({
  memory: {
    warnThreshold: 0.70,
    onMemoryPressure(report) {
      if (report.level === "critical") {
        barHistory.pruneOldEntries(1000);
      }
    },
  },
});
```

---

## 5. Console Formatter

### Visual Hierarchy

| Level              | Format                          | Color    |
| ------------------ | ------------------------------- | -------- |
| CRITICAL / ERROR   | Box with `┌─ AIO ERROR ─┐`      | Red      |
| WARNING            | Box with `┌─ AIO WARNING ─┐`    | Yellow   |
| Machine block      | One-liner                       | Blue     |
| Action log         | One-liner                       | Dim gray |
| Framework internal | Hidden (shown with `--verbose`) | —        |

### Stack Frame Filtering

- **Show:** user code frames (anything not in `dep/aio/`, `node_modules/`,
  `deno:`)
- **Hide:** framework internals (available in `debug.log` and with `--verbose`)
- Top 5 user frames shown in console box

### State Snapshot

- Truncated to 200 chars in console
- Full in `debug.log`
- Referenced by TT entry ID

### Tips (v1 — 5 templates)

1. **Wrong machine state** — "Machine was in 'X', did you mean to guard this
   action?"
2. **Effect timeout** — "Increase timeout:
   `feature('name', { effectTimeout: N })`"
3. **Undefined property** — "Check if action payload has the expected shape"
4. **Queue overflow** — "Possible infinite loop — check if reduce dispatches to
   itself"
5. **Memory pressure** — "Feature X is growing unbounded, consider pruning"

---

## 6. Time-Travel Error Integration

### Extended HistoryEntry

```ts
type HistoryEntry<S, A> = {
  id: number;
  action: A;
  state: S;
  ts: number;
  perf?: PerfMetric;
  error?: { // NEW
    code: AioErrorCode;
    message: string;
    featureName?: string;
    flowStep?: number;
  };
};
```

### Wire Format — TTBroadcast Update

```ts
type TTBroadcast = {
  entries: {
    id: number;
    action: string;
    perf?: PerfMetric;
    error?: { code: AioErrorCode; message: string };
  }[];
  index: number;
  paused: boolean;
};
```

`toBroadcast()` includes error field when present. Browser panel:

- Error entries: red background / red dot
- Click error entry: shows error detail panel
- "Jump to last error" button
- Error count badge on TT panel icon

---

## 7. Unified `onError` Hook

**Everything** routes through `onError`:

| Error Source        | Today          | After                            |
| ------------------- | -------------- | -------------------------------- |
| Reduce errors       | ✓ onError      | ✓ onError (with richer AioError) |
| Effect errors       | ✓ onError      | ✓ onError (with richer AioError) |
| Flow errors         | ✗ console only | ✓ onError                        |
| Hook errors         | ✗ console only | ✓ onError                        |
| Init/destroy errors | ✗ console only | ✓ onError                        |
| Memory pressure     | ✗ didn't exist | ✓ onError + onMemoryPressure     |
| Perf violations     | ✗ perfLog only | ✓ onError (as BUDGET_* codes)    |

```ts
aio.run({
  onError(err: AioError) {
    sentry.captureException(err);
    slack.alert(`${err.code} in ${err.context.featureName}: ${err.message}`);
  },
});
```

---

## 8. Testing Strategy

### Test Files

| File                     | Covers                                                         |
| ------------------------ | -------------------------------------------------------------- |
| `error.test.ts`          | AioError creation, context, serialization, correlationId, tips |
| `error-dispatch.test.ts` | Reduce/effect/queue/loop errors through dispatch               |
| `error-flow.test.ts`     | Flow step errors, uncaught, flowHistory ring buffer            |
| `error-hooks.test.ts`    | beforeReduce/onAction/onEffect throw handling                  |
| `error-memory.test.ts`   | Thresholds, reports, callbacks, cleanup, edge cases            |
| `error-format.test.ts`   | Console box output, stack filtering, prod format, JSONL        |
| `error-tt.test.ts`       | TT error markers, wire format                                  |
| `error-e2e.test.ts`      | Full chain: action → error → onError → log → TT                |

### Test Principles

- Real dispatch loop, real features, real errors — no mocks for error paths
- Mock only: `Deno.memoryUsage()` (simulate pressure) and timers (test timeout)
- Assert structured fields, not string matching on console output
- Each test creates minimal feature to trigger specific error path
- `reportError` self-guard test: if formatter throws, degrades to raw
  `console.error`

---

## 9. New Files

| File                    | Purpose                                                                |
| ----------------------- | ---------------------------------------------------------------------- |
| `src/error.ts`          | AioError class, createAioError, reportError, formatters, tip generator |
| `src/memory-monitor.ts` | Memory pressure sampling, reporting, feature state sizing              |

## 10. Modified Files

| File                     | Changes                                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/dispatch.ts`        | Remove local `reportError` and `AioError` type. Replace all console.error/warn with createAioError → new reportError. Add correlationId to queue entries. Preserve `errors` counter via callback |
| `src/flow.ts`            | Add step counter, flowHistory ring buffer (cap 50), route errors through reportError                                                                                                             |
| `src/feature-compose.ts` | Replace console.error in executor/init/destroy/cross-dispatch with createAioError → reportError                                                                                                  |
| `src/feature-create.ts`  | Replace console.error in async method throw with createAioError → reportError. Keep `__error` action dispatch                                                                                    |
| `src/aio.ts`             | Remove old `AioError` re-export. Wrap beforeReduce in try-catch. Guard onEffect hook. Initialize memory monitor. Pass error infrastructure to dispatch/flow                                      |
| `src/time-travel.ts`     | Add error field to HistoryEntry, markError method, include in toBroadcast. Update TTBroadcast type to include error                                                                              |
| `src/logger.ts`          | Accept AioError objects, serialize with full context to JSONL                                                                                                                                    |
| `src/types.ts`           | Export AioError class, AioErrorCode, AioErrorContext, MemoryConfig, MemoryReport types                                                                                                           |
| `src/standalone.ts`      | Wire createAioError + reportError into standalone dispatch deps (browser/Android mode). Memory monitor not available in browser (no `Deno.memoryUsage`), gracefully skipped                      |

---

## Out of Scope (Future Phases)

- Configurable stack frame ignore patterns
- AI-powered tip generation
- Browser error overlay integration (existing overlay works, just gets richer
  data)
- Error rate dashboards / metrics export
- Distributed tracing (multi-process correlation)
- Error recovery strategies (auto-retry, circuit breaker)
