# Vital Signs — Client Diagnostic System

**Date:** 2026-03-24 **Status:** Approved (brainstorm) **Scope:** New
`src/vitals/` module (6 files), integration hooks into dispatch, server,
browser, logger

## Problem

AIO's server-side observability is strong: perf budgets with phase breakdown,
time-travel debugger, memory monitor, circuit breakers, action logs, correlation
IDs. But the **client side is in complete darkness**.

When the UI freezes, the developer cannot tell:

- Is the server dispatch loop overloaded?
- Is the WebSocket/UDS connection stalled?
- Is the client's main thread blocked?
- Or some combination of all three?

The developer sees logs rolling but buttons do nothing. No diagnostic data
exists to identify root cause.

## Design

### Three Probes, One Hint Engine

```
Client (Browser/Electron/CLI)          Server
┌──────────────────────────┐    ┌──────────────────────┐
│ RenderProbe              │    │ LoopProbe             │
│  setTimeout drift + rAF  │    │  hooks into dispatch()│
│                          │    │  queue depth, drain   │
│ TransportProbe (client)  │    │  rate, reduce timing  │
│  sends ping, measures RTT│    │                       │
│                          │    │ TransportProbe (server)│
│ HintEngine               │    │  tracks client pongs  │
│  correlates all layers   │    │  detects frozen client│
│  produces root cause     │    │  watchdog role        │
└──────────┬───────────────┘    └──────────┬────────────┘
           │      __vitals:ping/pong       │
           └───────────────────────────────┘
```

### Severity Model

```typescript
type VitalStatus = "healthy" | "degraded" | "warning" | "frozen" | "recovered";
```

| Status      | Meaning                                 |
| ----------- | --------------------------------------- |
| `healthy`   | All within budget                       |
| `degraded`  | Approaching threshold, still functional |
| `warning`   | Threshold breached, freeze imminent     |
| `frozen`    | Confirmed unresponsive (>2s default)    |
| `recovered` | Was frozen, now back                    |

Lifecycle: `healthy → degraded → warning → frozen → recovered → healthy` Any
state can return directly to `healthy` if it resolves early.

### Alert Shape

```typescript
interface VitalAlert {
  id: string; // 8-char hex, same as existing correlationId format
  layer: "render" | "transport" | "loop";
  status: VitalStatus;
  duration: number; // ms since first degradation
  measured: number; // actual value (e.g., 3200ms render gap)
  threshold: number; // threshold that was breached
  hint: VitalHint | null; // null in prod (hints disabled)
  ts: number;
  correlationId?: string;
}

interface VitalHint {
  cause: string; // "Main thread blocked by synchronous reduce in feature 'orders'"
  evidence: string[]; // ["reduce took 3100ms (budget: 100ms)"]
  suggestion: string; // "Break RECALC_ALL into batched async chunks"
  severity: "likely" | "possible" | "speculative";
}
```

### Severity Classification

```
2+ probes with direct measurement + cross-probe correlation → "likely"
1  probe  with direct measurement                           → "possible"
Inference without direct evidence                           → "speculative"
```

## Probes

### RenderProbe (Client-Side)

Detects main thread blocking.

**Mechanism:** `setTimeout(heartbeatInterval)` loop. If the callback fires late
beyond threshold, the thread was blocked. In browser/Electron with visible
window, `requestAnimationFrame` gap provides secondary confirmation (paint
stalled vs JS stalled).

**Visibility guard:** When `document.visibilityState === "hidden"`, switches to
setTimeout-only and suppresses freeze alerts (background tabs don't get reliable
timers). Debug-level log only.

**Non-browser fallback (CLI/headless):** setTimeout-only. No rAF, no DOM
metrics. Hint engine skips render-specific suggestions.

**Lifecycle:** RenderProbe starts on `VitalsSystem.init()`, stops on
`VitalsSystem.destroy()`. Clears all `setTimeout` and `rAF` handles. Also cleans
up on page `beforeunload` / `visibilitychange` to `hidden` (permanent).

**On freeze recovery, captures:**

- Duration of freeze
- Last action dispatched before freeze
- Which feature owned that action
- Unprocessed state deltas received during freeze
- Heap before/after (if available)

### TransportProbe (Client ↔ Server)

Detects connection stalls and measures latency.

**Wire protocol:** New `__vitals` message type (dedicated, not mixed into app
state):

```
Client → Server:  { type: "__vitals:ping", t1: number }
Server → Client:  { type: "__vitals:pong", t1: number, t2: number, loop: LoopVitals }
```

RTT = `now - t1`. Server processing = `t2 - t1`. Network =
`(RTT - processing) / 2`.

**Client-side:** Tracks RTT trend, last pong time. Alerts when RTT exceeds
thresholds or no pong received.

**Server-side (watchdog):** Maintains per-client liveness:

```typescript
interface ClientLiveness {
  clientId: string;
  lastPing: number; // last ping received
  lastSent: number; // last state update sent
  status: VitalStatus;
  frozenSince?: number;
}
```

When client hasn't pinged within `frozen` threshold:

1. Logs immediately server-side (real-time, not waiting for client)
2. Fires `onVitalAlert` on server
3. Activates backpressure: stops sending deltas to frozen client

**On client recovery:** Server sends single full state snapshot instead of
accumulated deltas. Prevents recovery death spiral (client recovers → processes
200 queued deltas → freezes again).

**Cleanup:** Liveness record removed on disconnect. Frozen detection handles
zombie connections — eventually WS close timeout fires.

**UDS (Electron IPC) support:** Same `__vitals:ping/pong` protocol over UDS. The
IPC bridge in `browser.ts` already handles message routing via `type` field —
`__vitals:*` messages follow the same path as `__tt:*` and other internal
messages. No special IPC-specific handling needed; the transport-probe abstracts
over WS vs UDS using the same send/receive interface.

### LoopProbe (Server-Side)

Detects dispatch queue overload.

**Mechanism:** Hooks into `dispatch()` via two existing hook points plus minor
extensions:

- **`onPerf` callback** — already receives `reduceDuration`, action type. Used
  for `lastReduceTime`, `lastReduceAction`, `p95ReduceTime`.
- **`afterAction` callback** — already receives prev/next state, action. Used
  for `lastReduceFeature` (via action routing).
- **New: expose `queueDepth` from dispatch loop** — the queue is currently a
  local variable inside `createDispatch`. Add a `getQueueDepth()` accessor to
  `DispatchDeps` or return it from `createDispatch`. Minimal change (~3 lines).
- **New: in-flight effect counter** — `dispatch.ts` fires-and-forgets async
  effects. Add an increment/decrement counter around effect execution (~5
  lines). Exposed as `effectBacklog`.
- **Circuit breaker state** — accessed from `feature-compose.ts` health system,
  which already tracks per-feature error counts and disabled status.

```typescript
interface LoopVitals {
  queueDepth: number; // actions waiting — from dispatch queue accessor
  drainRate: number; // actions/second (rolling 5s window) — computed by LoopProbe
  lastReduceTime: number; // ms — from onPerf
  lastReduceAction: string; // — from onPerf
  lastReduceFeature: string; // — from action routing in afterAction
  p95ReduceTime: number; // 95th percentile, last 100 actions — computed by LoopProbe
  effectBacklog: number; // async effects in flight — from new counter in dispatch
  circuitBreakers: string[]; // tripped features — from feature-compose health
}
```

**Required changes to `dispatch.ts`:** Expose queue depth accessor and add
effect in-flight counter. Both are ~3-5 line additions, no architectural change.

Broadcast to clients via `__vitals:pong` — no extra messages.

## Dual-Sided Detection

Both sides detect independently, serving different roles:

| Side   | Role            | When it fires                       | What it knows                                        |
| ------ | --------------- | ----------------------------------- | ---------------------------------------------------- |
| Server | **Watchdog**    | During freeze (server isn't frozen) | "Client X is unresponsive, last action I sent was Y" |
| Client | **Post-mortem** | After freeze resolves               | "I was blocked for 3.2s, here's what was running"    |

Together: **server knows immediately, client knows the root cause.**

### Cascade Directionality

Each probe tracks `firstDegradedAt` timestamp. The hint engine sorts
chronologically to identify cascade origin:

```
loop degraded T+0 → transport degraded T+0.3s → render frozen T+2.1s
→ Cascade origin: loop
```

## Hint Rules (6 Core Rules)

Pure functions: `(snapshot: VitalsSnapshot) → VitalHint | null`. Deterministic,
testable.

### Rule 1: Slow Reduce Freeze

```
IF render.frozen AND loop.lastReduceTime > budget
   AND loop.lastReduceAction === render.lastActionBefore
→ likely: "Reducer for '{feature}/{action}' took {X}ms (budget: {Y}ms).
   Fix: optimize the reduce, or split into smaller actions."
```

### Rule 2: Queue Saturation

```
IF loop.queueDepth > threshold AND loop.firstDegradedAt < transport.firstDegradedAt
→ likely: "Dispatch queue backed up to {depth} actions. Drain rate: {rate}/s.
   Fix: debounce rapid-fire dispatches, or batch related actions."
```

### Rule 3: Transport Stall

```
IF transport.frozen AND render.healthy AND loop.healthy
→ likely: "Network connection stalled. No pong in {X}s. Server and client both healthy.
   Fix: check network stability. Auto-reconnect triggers in {Z}ms."
```

### Rule 4: Client-Only Freeze

```
IF render.frozen AND transport.healthy (before freeze) AND loop.healthy
   AND no recent AIO action before freeze
→ possible: "Main thread blocked by non-AIO code.
   Fix: check third-party libraries, large DOM operations, synchronous I/O."
```

### Rule 5: Recovery Death Spiral

```
IF render.recovered AND previousFreezeCount > 1 in last 30s
→ likely: "Repeated freeze-recover cycle ({count} in {window}s).
   Recovery is triggering re-freeze.
   Fix: if backpressure is off, enable it. If on, check for expensive
   onVitalAlert handlers or post-recovery reconciliation in app code."
```

### Rule 6: Visibility Filter

```
IF render.frozen AND window.visibilityState === "hidden"
→ discard alert. Log at debug level only. Not a real freeze.
```

Additional rules are added when real usage reveals undiagnosed patterns.

## Freeze Timeline Summary

On recovery, one log line captures the full story:

```
[vitals:summary] freeze 3.2s | origin: loop | cascade: loop(T+0) → transport(T+0.3s) → render(T+2.1s) → recovered(T+3.2s) | cause(likely): orders/RECALC_ALL reduce 3100ms (budget 100ms) | fix: optimize reduce or split action
```

## Configuration

### Simple (90% of apps)

```typescript
aio.run({
  features: [...],
  diagnostics: {
    dev: { vitals: true },
    prod: { vitals: true }
  }
})
```

### With alert handler

```typescript
diagnostics: {
  dev: {
    vitals: {
      onVitalAlert: ((alert) => {
        if (alert.status === "frozen") pauseNonCritical();
        if (alert.status === "recovered") resumeAll();
      });
    }
  }
}
```

### Full config (power users)

```typescript
// Config entry: vitals?: boolean | VitalsConfig
// Follows same pattern as checkpoint?: boolean | { debounce?: number }
// vitals: true → all defaults
// vitals: false → disabled
// vitals: { ... } → custom config (all fields optional, merged with defaults)

interface VitalsConfig {
  heartbeatInterval?: number; // default: 1000ms
  thresholds?: Partial<{
    render: { degraded: 50; warning: 200; frozen: 2000 }; // ms
    transport: { degraded: 100; warning: 500; frozen: 2000 }; // ms RTT
    loop: { degraded: 100; warning: 500; frozen: 2000 }; // ms processing
    queue: { degraded: 50; warning: 200; frozen: 1000 }; // count
  }>;
  hints?: boolean; // default: true (dev), false (prod)
  backpressure?: boolean; // default: true — pause deltas to frozen clients
  onVitalAlert?: (alert: VitalAlert) => void;
}
```

**DiagnosticsOptions integration:** `vitals` is added as a new field to the
existing `DiagnosticsOptions` type in `src/diagnostics/types.ts`, alongside
`stateDiffs`, `actionLog`, `checkpoint`, etc. `DEV_DEFAULTS` sets
`vitals: true`, `PROD_DEFAULTS` sets `vitals: { hints: false }`.
`resolveOptions()` merges vitals config same as other options.

### Defaults by Mode

| Option            | Dev                   | Prod               |
| ----------------- | --------------------- | ------------------ |
| vitals            | `true` (all defaults) | `{ hints: false }` |
| heartbeatInterval | 1000ms                | 1000ms             |
| hints             | true                  | false              |
| backpressure      | true                  | true               |

Prod overhead: one setTimeout/s on client, ping/pong on transport, queue depth
counter on server. Negligible.

## Integration Points

Hooks into existing code, no parallel systems:

| File              | Integration                                                                                                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/aio.ts`      | Init VitalsSystem, pass config, wire to diagnostics hooks                                                                                                                                                |
| `src/dispatch.ts` | LoopProbe hooks into `onPerf` + `afterAction`. New: expose queue depth accessor, add effect in-flight counter (~8 lines total)                                                                           |
| `src/server.ts`   | TransportProbe server-side, ClientLiveness, backpressure (modify broadcast loop to skip frozen clients, send full snapshot on recovery via existing `fullStateThreshold` path), `/__aio/vitals` endpoint |
| `src/browser.ts`  | RenderProbe, TransportProbe client-side, hint engine                                                                                                                                                     |
| `src/logger.ts`   | Freeze events → perf.log, details → debug.log, summary → app.log                                                                                                                                         |
| `src/error.ts`    | Three new AioErrorCodes: `UI_FREEZE`, `TRANSPORT_STALL`, `LOOP_SATURATED`                                                                                                                                |

## New Files

```
src/vitals/
  mod.ts              — public API, VitalsSystem init/destroy
  render-probe.ts     — client heartbeat (setTimeout + rAF)
  transport-probe.ts  — ping/pong both sides, ClientLiveness
  loop-probe.ts       — dispatch hooks, LoopVitals
  hints.ts            — 6 pattern rules + cascade correlation (merged)
  types.ts            — VitalAlert, VitalHint, VitalStatus, VitalsConfig
```

## HTTP Endpoint

`GET /__aio/vitals` — alongside existing `/__aio/health`:

```json
{
  "server": {
    "loop": { "queueDepth": 2, "drainRate": 45, "p95ReduceTime": 12 }
  },
  "clients": [
    { "id": "client_7f2a", "status": "healthy", "rtt": 12 },
    { "id": "client_3b1c", "status": "frozen", "frozenFor": 3890 }
  ]
}
```

## Error Codes

Three additions to existing `AioErrorCode` enum:

| Code              | When                                                            |
| ----------------- | --------------------------------------------------------------- |
| `UI_FREEZE`       | Client render unresponsive beyond frozen threshold              |
| `TRANSPORT_STALL` | WS/UDS connection unresponsive beyond frozen threshold          |
| `LOOP_SATURATED`  | Dispatch queue depth or processing time beyond frozen threshold |

## Testing

Synthetic freeze injection (tree-shakeable, test-only):

```typescript
vitals.test.freezeRender(ms); // blocks main thread
vitals.test.stallTransport(ms); // delays pong
vitals.test.loadLoop(queueDepth); // simulates queue backup
```

Each hint rule = pure function, trivially unit-testable. Each correlation matrix
row (6 combinations) = one integration test.

## What This Does NOT Include

- No dashboard UI (future, built on same data)
- No React internals introspection
- No distributed tracing / OpenTelemetry
- No request rate limiting
- No custom hint rules API (add when needed)
