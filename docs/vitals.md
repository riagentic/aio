# Vital Signs

Client diagnostic system for detecting and diagnosing UI freezes. Three probes
measure different layers of the stack; a hint engine correlates their signals
into a root-cause diagnosis.

For the docs index, see [manual.md](manual.md). For server-side diagnostics, see
[diagnostics.md](diagnostics.md).

## Architecture

```
Client (Browser/Electron)              Server
┌──────────────────────────┐    ┌──────────────────────────┐
│ RenderProbe              │    │ LoopProbe                 │
│  setTimeout drift + rAF  │    │  hooks into dispatch()    │
│                          │    │  queue depth, drain rate  │
│ TransportProbe (client)  │    │  reduce timing, p95       │
│  sends ping, measures RTT│    │                           │
│                          │    │ TransportProbe (server)   │
│                          │    │  tracks client pongs      │
│                          │    │  detects frozen clients   │
│                          │    │                           │
│                          │    │ HintEngine                │
│                          │    │  correlates all layers    │
│                          │    │  produces root-cause hint │
└──────────┬───────────────┘    └──────────┬────────────────┘
           │      __vitals:ping/pong       │
           └───────────────────────────────┘
```

## Severity Model

Every probe classifies its measurement into a status:

| Status      | Meaning                                 |
| ----------- | --------------------------------------- |
| `healthy`   | All within budget                       |
| `degraded`  | Approaching threshold, still functional |
| `warning`   | Threshold breached, freeze imminent     |
| `frozen`    | Confirmed unresponsive (>2s default)    |
| `recovered` | Was frozen, now back                    |

Lifecycle: `healthy -> degraded -> warning -> frozen -> recovered -> healthy`.
Any state can return directly to `healthy` if it resolves early.

## Configuration

Vitals is part of the diagnostics subsystem. Enabled by default in both dev and
prod (prod disables hints for lower overhead).

```ts
aio.run({
  features: [...],
  diagnostics: {
    dev: {
      vitals: {
        heartbeatInterval: 1000,  // ms between probe checks (default: 1000)
        hints: true,              // enable hint engine (default: true in dev)
        backpressure: false,      // reserved for future use
        thresholds: {             // override per-layer thresholds (ms)
          render:    { degraded: 50,  warning: 200, frozen: 2000 },
          transport: { degraded: 100, warning: 500, frozen: 2000 },
          loop:      { degraded: 100, warning: 500, frozen: 2000 },
          queue:     { degraded: 50,  warning: 200, frozen: 1000 },
        },
        onVitalAlert: (alert) => {
          // Called when any probe status changes
          console.log(alert.layer, alert.status, alert.hint?.cause);
        },
      },
    },
    prod: {
      vitals: { hints: false },  // default: hints off in prod
    },
  },
})
```

**Kill switch:** `vitals: false` disables the entire subsystem.

---

## Three Probes

### LoopProbe (Server)

Monitors the server-side dispatch loop. Hooks into `dispatch()` performance
timing to track reduce durations, queue depth, effect backlog, and circuit
breaker state.

**What it measures:**

| Metric              | Description                                 |
| ------------------- | ------------------------------------------- |
| `lastReduceTime`    | Duration of the most recent reduce (ms)     |
| `lastReduceAction`  | Action type that triggered it               |
| `lastReduceFeature` | Feature that owned the reduce               |
| `p95ReduceTime`     | 95th percentile over last 100 reduces       |
| `queueDepth`        | Number of pending actions in dispatch queue |
| `drainRate`         | Actions processed per second (5s window)    |
| `effectBacklog`     | Pending effects awaiting execution          |
| `circuitBreakers`   | Names of tripped circuit breakers           |

**Status evaluation:** Checks queue thresholds first (higher priority), then
reduce-time thresholds. Queue saturation is a more immediate threat than slow
reduces.

### RenderProbe (Client)

Detects main-thread freezes using `setTimeout` drift. Fires a timer at a fixed
interval and measures how late the callback arrives — drift beyond the threshold
means the main thread was blocked.

**What it measures:**

- Elapsed time between scheduled and actual tick (the drift)
- Last AIO action dispatched before the freeze (correlation)
- Number of unprocessed state deltas during freeze
- Freeze count in last 30 seconds (detects death spirals)

**Status changes** fire via `onStatusChange` callback, which the browser client
logs to console as `[aio:vitals] render <status>`.

### RenderMeter (Client)

Frame-level measurement using `requestAnimationFrame`. While RenderProbe detects
freezes via `setTimeout` drift, RenderMeter provides continuous render health
metrics — staleness, frame time, paint rate, and memory.

**What it measures:**

| Metric           | Description                                                      |
| ---------------- | ---------------------------------------------------------------- |
| `staleness`      | ms since last unpainted state update (`now - lastPatchAt`)       |
| `frameTime`      | ms between consecutive `requestAnimationFrame` callbacks         |
| `pendingPatches` | Unprocessed delta patches waiting to be painted                  |
| `paintRate`      | Frames per second (1-second rolling window)                      |
| `memory`         | JS heap usage gauge (Chrome/Edge only, via `performance.memory`) |

**Status classification (staleness-based):**

| Staleness       | Status     |
| --------------- | ---------- |
| < threshold     | `healthy`  |
| >= threshold    | `degraded` |
| >= 2× threshold | `warning`  |
| >= 5× threshold | `frozen`   |

Default staleness threshold: 300ms (configurable via `renderBudget.staleness`).

**Frozen client behavior:** When a client is classified as `frozen`, the server
skips sending deltas to it entirely — no point pushing data that won't be
painted. When the client recovers, it resumes receiving deltas from the next
broadcast cycle (accumulated state changes are captured in the next delta).

**Visibility pause:** When the browser tab is hidden (`document.hidden`), the
meter pauses measurement and suppresses false alarms. Hidden tabs don't receive
`requestAnimationFrame` callbacks, which would otherwise trigger false freeze
detection.

**Configuration:**

```ts
aio.run({
  renderBudget: {
    staleness: 500, // ms — default: 300
    pendingPatches: 20, // count — default: 10
  },
});
```

### TransportProbe (Client + Server)

Measures round-trip time between client and server using a `__vitals:ping/pong`
protocol over WebSocket.

**Client side:**

- Sends `__vitals:ping` with timestamp `t1` at each heartbeat interval
- Receives `__vitals:pong` with server timestamp `t2` and loop vitals
- Computes RTT as `now - t1`
- Classifies RTT against transport thresholds

**Server side (watchdog):**

- Tracks `lastPing` timestamp per connected client
- Periodically checks all clients against thresholds
- Fires `onClientFrozen` / `onClientRecovered` callbacks when status changes
- Frozen detection: `now - lastPing >= transport.frozen` threshold

**Wire protocol:**

```ts
// Client -> Server (WebSocket text frame)
"__vitals:ping:" + JSON.stringify({ t1: number });

// Server -> Client (WebSocket text frame)
"__vitals:pong:" + JSON.stringify({ t1, t2, loop: LoopVitals | null });
```

The pong includes server-side loop vitals so the client has full-stack context
without a separate request.

### IPC keepalive (UDS mode)

In Electron/UDS mode, the full `__vitals:ping/pong` protocol is not used (it
runs over WebSocket only). Instead, a lightweight `__ping` message is sent every
60 seconds over the IPC bridge to keep the connection visibly alive. The server
silently ignores these messages. This prevents passive viewing sessions
(dashboards, monitoring) from appearing idle. See [electron.md](electron.md) for
UDS connection lifecycle details.

---

## Measurement Pipeline

How diagnostic data flows from measurement to developer console:

```
Server                              Client
┌─────────────────────┐    ┌──────────────────────────┐
│ dispatch() called   │    │                          │
│   ↓                 │    │ RenderProbe              │
│ performance.now()   │    │   setTimeout drift → status │
│   ↓                 │    │                          │
│ LoopProbe collects: │    │ RenderMeter              │
│   reduceTime        │    │   rAF gap → staleness    │
│   queueDepth        │    │   frameTime, paintRate   │
│   drainRate         │    │                          │
│   effectBacklog     │    │ TransportProbe (client)  │
│   p95ReduceTime     │    │   ping → measure RTT     │
│         │           │    │         │                │
│         ↓           │    │         ↓                │
│ __vitals:pong ──────────→│ VitalsSnapshot assembled │
│  (includes LoopVitals)   │         │                │
│                     │    │         ↓                │
│ DiagReporter        │    │ HintEngine               │
│  (server console)   │    │   correlate all probes   │
│   SLOW DISPATCH     │    │   → root-cause hint      │
│   DISCONNECTED      │    │         │                │
│   PRESSURE          │    │         ↓                │
│                     │    │ DiagReporter (client)    │
│ onDiagnostic hook ←─────←│   [aio:vitals] console  │
│   (telemetry sink)  │    │   block with hint        │
│                     │    │                          │
│ GET /__aio/vitals   │    │ onVitalAlert callback    │
│   (HTTP endpoint)   │    │                          │
└─────────────────────┘    └──────────────────────────┘
```

**Timing:** The pipeline runs on each heartbeat interval (default: 1000ms).
Client sends `__vitals:ping`, server responds with `__vitals:pong` containing
current `LoopVitals`. Client assembles a `VitalsSnapshot` from all three layers
and runs the hint engine.

**Data lifecycle:**

| Data point      | Window / Reset                                                       |
| --------------- | -------------------------------------------------------------------- |
| `p95ReduceTime` | Sliding window of last 100 reduces, sorted percentile                |
| `drainRate`     | 5-second tumbling window of action timestamps                        |
| `effectBacklog` | Live counter: +1 on async effect start, −1 on resolve/reject/timeout |
| `queueDepth`    | Live: current `queue.length` in dispatch loop                        |
| `paintRate`     | 1-second rolling window of rAF frame count                           |
| `staleness`     | Instantaneous: `now - lastPatchAt`                                   |

## Hint Engine

Pure function that takes a `VitalsSnapshot` (all three probes) and produces a
diagnostic `VitalHint` with cause, evidence, and suggestion. Seven pattern rules
evaluated in priority order — first match wins:

| # | Rule                  | Trigger                                                          | Severity   |
| - | --------------------- | ---------------------------------------------------------------- | ---------- |
| 6 | Visibility filter     | Render frozen but tab hidden — discard (not a real freeze)       | —          |
| 5 | Recovery death spiral | Multiple freeze-recover cycles in 30s                            | `likely`   |
| 1 | Slow reduce freeze    | Render frozen + reduce time over budget + same action            | `likely`   |
| 2 | Queue saturation      | Queue depth over frozen threshold + loop degraded first          | `likely`   |
| 3 | Transport stall       | Transport frozen + render healthy + loop healthy                 | `possible` |
| 4 | Client-only freeze    | Render frozen + transport healthy + loop healthy + no AIO action | `possible` |
| 7 | Re-render storm       | >30 subscribe callbacks/sec (client-side only)                   | `possible` |

### Severity Classification

- **`likely`** — 2+ probes corroborate, direct measurement, cross-probe
  correlation
- **`possible`** — 1+ probe with direct measurement
- **`speculative`** — insufficient evidence for confident diagnosis

### VitalHint Shape

```ts
type VitalHint = {
  cause: string; // "Reducer for 'wallet/transfer' took 450ms"
  evidence: string[]; // ["reduce took 450ms (budget: 100ms)", "render frozen for 2100ms"]
  suggestion: string; // "Optimize the reduce, or split into smaller actions."
  severity: "likely" | "possible" | "speculative";
};
```

---

## DiagReporter

The DiagReporter turns probe signals into actionable console output. Split into
two halves because probes run on different sides of the wire:

- **Server reporter** — correlates loop + transport probes → `slow`, `stale`,
  `disconnect` events. Outputs to server console. Fires `onDiagnostic` hook.
- **Client reporter** — correlates render probe + pong loop data → `freeze`,
  `recovered` events. Outputs to browser console.

### DiagEvent

```ts
type DiagEvent = {
  kind: "freeze" | "stale" | "slow" | "disconnect" | "recovered";
  severity: "likely" | "possible" | "speculative";
  summary: string;
  detail: {
    trigger?: string; // action/feature that triggered it
    reduceMs?: number; // last reduce duration
    p95Ms?: number; // p95 reduce time
    queueDepth?: number; // pending actions
    drainRate?: number; // actions/sec
    rtt?: number; // transport round-trip
    skipCount?: number; // skipped broadcasts
    frozenFor?: number; // freeze duration (ms)
    payloadBytes?: number; // broadcast size
    hint?: string; // root-cause suggestion
  };
  timestamp: number;
};
```

### Console output format

Structured block when severity is `likely`/`possible` and 2+ data points:

```
[aio:vitals] RENDER FROZEN — no update for 3.2s
  trigger:    portfolio.refresh reduce took 1847ms (p95: 45ms)
  queue:      12 actions pending, drain rate 2.1/s
  transport:  healthy (RTT 23ms)
  hint:       slow reducer blocking main thread — consider async
```

One-liner for recoveries or low-confidence events:

```
[aio:vitals] transport recovered (was degraded for 1.2s, RTT back to 28ms)
```

### Connection teardown diagnostics

The subscription system emits dual-channel diagnostics (`console.warn` +
`_diagEmit`) for connection lifecycle events. These are always visible in
browser/Electron devtools — no opt-in required.

```
[aio] teardown — no listeners for 300ms (peak was 5). Closing connection, clearing state.
[aio] teardown averted — listeners dropped to 0 but recovered to 3 within 300ms
```

| Event            | `_diagEmit` type   | When                                                |
| ---------------- | ------------------ | --------------------------------------------------- |
| Full teardown    | `teardown`         | Grace period expired, no listeners — full cleanup   |
| Teardown averted | `teardown-averted` | Listeners dropped to 0 but re-attached within 300ms |

The 300ms grace period prevents transient listener gaps (React reconciliation,
page switches, hot reload) from triggering full teardown. If you see "teardown
averted" in your console, it means the system survived a subscription
instability — investigate the cause.

### `onDiagnostic` hook

Wire to your telemetry from `aio.run()`:

```ts
aio.run({
  features: [...],
  diagnostics: {
    dev: { vitals: true },
    prod: { vitals: false },
    onDiagnostic: (event) => {
      // event: DiagEvent — send to Sentry, Datadog, etc.
      sentry.captureMessage(event.summary, { extra: event.detail });
    },
  },
})
```

The hook fires for every event with no throttling — your sink, your rules.
Console output is throttled (same kind+trigger suppressed for 2s).

### Re-render storm detection

Timer-based detection: checks every 1s whether `_subscribe` notification
callbacks exceeded 30 in the last window. Runs independently of probe status
changes — storms are detected even when all probes report healthy. Since
`useAio()` now uses a deep Proxy to auto-track accessed paths, subscriptions are
always narrowed — a storm indicates expensive components or unstable selectors,
not over-subscription:

```
[aio:vitals] RE-RENDER STORM — 47 subscribe callbacks in last 1s
  hint:               check for expensive components or unstable selectors — useFeature(ref) can scope re-renders
```

### Resource pressure warnings

Detects when resources approach limits before things break. Three sources:

| Source             | Where  | Default                     | What it warns           |
| ------------------ | ------ | --------------------------- | ----------------------- |
| Payload size       | Server | 500KB per broadcast         | Large state deltas      |
| Broadcast rate     | Server | 30/sec                      | High dispatch frequency |
| Render degradation | Client | 50ms drift (existing probe) | Main thread under load  |

Pressure events use kind `"pressure"` and fire via console + `onDiagnostic`
(server-side). Client render pressure outputs to console only.

Configure via `vitals.pressure`:

```ts
diagnostics: {
  dev: {
    vitals: {
      pressure: {
        payloadThreshold: 1_000_000,  // 1MB for heavy app
        rateThreshold: 60,            // real-time data
      },
    },
  },
}
```

`pressure: false` disables. Default: on in dev, off in prod.

### `useAio()` Proxy tracking

`useAio()` returns a deep recursive Proxy that automatically tracks which state
paths each component reads. Only deltas for subscribed paths are sent from the
server — no full-state subscription is possible. Active instances are
ref-counted for accurate storm diagnostics. `useAio()` is the recommended API;
`useFeature(ref)` is a React re-render optimization for scoping re-renders to a
single feature.

---

## VitalAlert

Emitted via `onVitalAlert` callback when any probe's status changes:

```ts
type VitalAlert = {
  id: string; // correlation ID (same format as AioError)
  layer: "render" | "transport" | "loop";
  status: VitalStatus; // "degraded" | "warning" | "frozen" | "recovered"
  duration: number; // how long the condition has lasted (ms)
  measured: number; // raw measurement value
  threshold: number; // threshold that was breached
  hint: VitalHint | null; // diagnostic hint (null if hints disabled)
  ts: number; // timestamp
  correlationId?: string; // optional correlation with AioError
};
```

---

## HTTP Endpoint

When vitals is enabled, the server exposes `GET /__aio/vitals` returning JSON:

```json
{
  "server": {
    "loop": {
      "queueDepth": 0,
      "drainRate": 12.5,
      "lastReduceTime": 3.2,
      "lastReduceAction": "counter:increment",
      "lastReduceFeature": "counter",
      "p95ReduceTime": 8.1,
      "effectBacklog": 0,
      "circuitBreakers": []
    }
  },
  "clients": [
    { "id": "abc123", "status": "healthy" }
  ]
}
```

Useful for external monitoring, dashboards, or alerting systems.

---

## Default Thresholds

| Layer       | Degraded | Warning | Frozen |
| ----------- | -------- | ------- | ------ |
| `render`    | 50ms     | 200ms   | 2000ms |
| `transport` | 100ms    | 500ms   | 2000ms |
| `loop`      | 100ms    | 500ms   | 2000ms |
| `queue`     | 50       | 200     | 1000   |

Queue thresholds are action counts, not milliseconds. Render thresholds measure
`setTimeout` drift — the difference between expected and actual callback time.

---

## Types

```ts
type VitalStatus = "healthy" | "degraded" | "warning" | "frozen" | "recovered";
type VitalLayer = "render" | "transport" | "loop";

type VitalsConfig = {
  heartbeatInterval?: number; // ms between checks (default: 1000)
  thresholds?: Partial<VitalThresholds>; // override per-layer thresholds
  hints?: boolean; // enable hint engine (default: true)
  backpressure?: boolean; // reserved
  onVitalAlert?: (alert: VitalAlert) => void;
  onDiagnostic?: (event: DiagEvent) => void;
};

type VitalThresholds = {
  render: LayerThreshold;
  transport: LayerThreshold;
  loop: LayerThreshold;
  queue: LayerThreshold;
};

type LayerThreshold = {
  degraded: number;
  warning: number;
  frozen: number;
};

type LoopVitals = {
  queueDepth: number;
  drainRate: number;
  lastReduceTime: number;
  lastReduceAction: string;
  lastReduceFeature: string;
  p95ReduceTime: number;
  effectBacklog: number;
  circuitBreakers: string[];
};

type ClientLiveness = {
  clientId: string;
  lastPing: number;
  lastSent: number;
  status: VitalStatus;
  frozenSince?: number;
};

type VitalsSnapshot = {
  render: {
    status;
    measured;
    lastActionBefore;
    firstDegradedAt;
    frozenFor?;
    memoryBefore?;
    memoryAfter?;
    previousFreezeCount?;
    visible?;
  };
  transport: { status; measured; firstDegradedAt };
  loop: LoopVitals & { status; firstDegradedAt };
};
```

---

## HTTP Endpoint (updated)

`GET /__aio/vitals` now returns additional fields:

```json
{
  "server": { "loop": { ... } },
  "clients": [ { "id": "abc123", "status": "healthy" } ],
  "payloadStats": {
    "abc123": { "lastPayloadBytes": 1234, "totalBytes": 56789, "count": 42 }
  },
  "featureSizes": {
    "counter": 128,
    "wallet": 4096
  }
}
```

- `payloadStats` — broadcast payload size per client (UTF-8 bytes via
  `TextEncoder`)
- `featureSizes` — serialized state size per feature (UTF-8 bytes via
  `TextEncoder`)

---

## Exports

All vitals exports are available from `aio`:

```ts
import {
  classifySeverity,
  createLoopProbe,
  createRenderProbe,
  createTransportProbeClient,
  createTransportProbeServer,
  createVitalsSystem,
  DEFAULT_HEARTBEAT_INTERVAL,
  DEFAULT_THRESHOLDS,
  detectCascadeOrigin,
  evaluateHints,
  formatDiagEvent,
} from "aio";

import type { DiagEvent, DiagEventDetail, VitalAlert, VitalsConfig } from "aio";
```

For most apps, you don't import these directly — `aio.run()` creates and wires
the vitals system automatically. Direct imports are for custom monitoring setups
or testing.
