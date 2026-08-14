# Vitals

Client diagnostic system for detecting and diagnosing UI freezes. Three probes
measure different layers; a hint engine correlates signals into root-cause
diagnosis.

## Architecture

```
Client (Browser/Electron)              Server
+----------------------------+    +----------------------------+
| RenderProbe                |    | LoopProbe                  |
|  setTimeout drift + rAF    |    |  hooks into dispatch()     |
|                            |    |  queue depth, drain rate   |
| TransportProbe (client)    |    |  reduce timing, p95        |
|  sends ping, measures RTT  |    |                            |
|                            |    | TransportProbe (server)    |
|                            |    |  tracks client pongs       |
|                            |    |  detects frozen clients    |
|                            |    |                            |
|                            |    | HintEngine                 |
|                            |    |  correlates all layers     |
|                            |    |  produces root-cause hint  |
+----------------------------+    +----------------------------+
           vitals-ping/pong frames
```

## Severity model

| Status      | Meaning                                 |
| ----------- | --------------------------------------- |
| `healthy`   | All within budget                       |
| `degraded`  | Approaching threshold, still functional |
| `warning`   | Threshold breached, freeze imminent     |
| `frozen`    | Confirmed unresponsive (>2s default)    |
| `recovered` | Was frozen, now back                    |

Lifecycle: `healthy -> degraded -> warning -> frozen -> recovered -> healthy`.
Any state can return directly to `healthy`.

## Configuration

```ts
aio.run({
  cells: [...],
  diagnostics: {
    dev: {
      vitals: {
        heartbeatInterval: 1000,  // ms between checks (default: 1000)
        hints: true,              // enable hint engine (default: true in dev)
        backpressure: true,       // per-client send throttling (default: true)
        thresholds: {             // override per-layer thresholds (ms)
          render:    { degraded: 50,  warning: 200, frozen: 2000 },
          transport: { degraded: 100, warning: 500, frozen: 2000 },
          loop:      { degraded: 100, warning: 500, frozen: 2000 },
          queue:     { degraded: 50,  warning: 200, frozen: 1000 },
        },
        onVitalAlert: (alert) => {
          console.log(alert.layer, alert.status, alert.hint?.cause);
        },
      },
    },
    prod: { vitals: { hints: false } },  // hints off in prod
  },
})
```

Kill switch: `vitals: false`.

`backpressure: false` turns off the per-client send throttle: a client that
reports itself behind (staleness above the transport threshold) is no longer
sent state at a reduced rate. Leave it on unless you have measured that the
throttle is what is holding a client back — the hint engine says so by name when
it is.

---

## Three probes

### LoopProbe (server)

Monitors the dispatch loop -- reduce durations, queue depth, effect backlog,
circuit breaker state.

| Metric             | Description                              |
| ------------------ | ---------------------------------------- |
| `lastReduceTime`   | Duration of the most recent reduce (ms)  |
| `lastReduceAction` | Action type that triggered it            |
| `lastReduceCell`   | Cell that owned the reduce               |
| `p95ReduceTime`    | 95th percentile over last 100 reduces    |
| `queueDepth`       | Pending actions in dispatch queue        |
| `drainRate`        | Actions processed per second (5s window) |
| `effectBacklog`    | Pending effects awaiting execution       |
| `circuitBreakers`  | Names of tripped circuit breakers        |

Queue thresholds are checked first (higher priority than reduce-time).

### RenderProbe (client)

Detects main-thread freezes using `setTimeout` drift. Measures how late the
callback arrives -- drift beyond threshold means the main thread was blocked.

Tracks: drift time, last AIO action before freeze, unprocessed deltas during
freeze, freeze count in last 30s (death spiral detection).

### RenderMeter (client)

Frame-level measurement using `requestAnimationFrame`. Provides continuous
render health while RenderProbe detects freezes.

| Metric           | Description                                |
| ---------------- | ------------------------------------------ |
| `staleness`      | ms since last unpainted state update       |
| `frameTime`      | ms between consecutive rAF callbacks       |
| `pendingPatches` | Unprocessed delta patches waiting to paint |
| `paintRate`      | Frames per second (1s rolling window)      |
| `memory`         | JS heap usage gauge (Chrome/Edge only)     |

Staleness-based status: `< threshold` = healthy, `>= 1x` = degraded, `>= 2x` =
warning, `>= 5x` = frozen. Default staleness threshold: 300ms.

Frozen clients stop receiving deltas from server. Visibility pause: hidden tabs
suppress false alarms.

```ts
aio.run({
  renderBudget: { staleness: 500, pendingPatches: 20 },
});
```

### TransportProbe (client + server)

Measures RTT via `vitals-ping`/`vitals-pong` frames over WebSocket. Client sends
ping with `t1`, server responds with `t2` and loop vitals. Server-side watchdog
tracks `lastPing` per client, detects frozen clients.

IPC keepalive (UDS mode): lightweight `__ping` every 60s over IPC bridge. Full
vitals protocol runs over WebSocket only.

---

## Measurement pipeline

```
Server                              Client
+---------------------+    +--------------------------+
| dispatch() called   |    | RenderProbe              |
|   performance.now() |    |   setTimeout drift       |
|   LoopProbe collects|    | RenderMeter              |
|     reduceTime      |    |   rAF gap -> staleness   |
|     queueDepth      |    | TransportProbe (client)  |
|     drainRate       |    |   ping -> measure RTT    |
|          |          |    |         |                |
| vitals-pong --------+--->| VitalsSnapshot assembled |
|                     |    |         |                |
| DiagReporter        |    | HintEngine               |
|  (server console)   |    |   correlate all probes   |
|                     |    |   -> root-cause hint     |
| onDiagnostic hook <-+----| DiagReporter (client)    |
| GET /__aio/vitals   |    | onVitalAlert callback    |
+---------------------+    +--------------------------+
```

Pipeline runs on each heartbeat interval (default: 1000ms).

---

## Hint engine

Pure function: takes `VitalsSnapshot`, produces a `VitalHint` with cause,
evidence, and suggestion. Seven rules evaluated in priority order -- first match
wins:

| # | Rule                  | Trigger                                                | Severity   |
| - | --------------------- | ------------------------------------------------------ | ---------- |
| 6 | Visibility filter     | Render frozen but tab hidden -- discard                | --         |
| 5 | Recovery death spiral | Multiple freeze-recover cycles in 30s                  | `likely`   |
| 1 | Slow reduce freeze    | Render frozen + reduce time over budget + same action  | `likely`   |
| 2 | Queue saturation      | Queue depth over frozen threshold + loop degraded      | `likely`   |
| 3 | Transport stall       | Transport frozen + render/loop healthy                 | `possible` |
| 4 | Client-only freeze    | Render frozen + transport/loop healthy + no AIO action | `possible` |
| 7 | Re-render storm       | >30 subscribe callbacks/sec (client-side)              | `possible` |

Severity: **likely** = 2+ probes corroborate. **possible** = 1+ probe with
direct measurement. **speculative** = insufficient evidence.

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

Turns probe signals into actionable console output. Split by side:

- **Server reporter** -- loop + transport probes: slow, stale, disconnect
  events. Fires `onDiagnostic` hook.
- **Client reporter** -- render probe + pong loop data: freeze, recovered
  events.

### DiagEvent

```ts
type DiagEvent = {
  kind: "freeze" | "stale" | "slow" | "disconnect" | "recovered";
  severity: "likely" | "possible" | "speculative";
  summary: string;
  detail: {
    trigger?: string;
    reduceMs?: number;
    p95Ms?: number;
    queueDepth?: number;
    drainRate?: number;
    rtt?: number;
    skipCount?: number;
    frozenFor?: number;
    payloadBytes?: number;
    hint?: string;
  };
  timestamp: number;
};
```

### Console output

Structured block when severity is `likely`/`possible`:

```
[aio:vitals] RENDER FROZEN -- no update for 3.2s
  trigger:    portfolio.refresh reduce took 1847ms (p95: 45ms)
  queue:      12 actions pending, drain rate 2.1/s
  transport:  healthy (RTT 23ms)
  hint:       slow reducer blocking main thread
```

### Connection teardown diagnostics

```
[aio] teardown -- no listeners for 300ms (peak was 5). Closing connection.
[aio] teardown averted -- listeners dropped to 0 but recovered to 3 within 300ms
```

300ms grace period prevents transient listener gaps (component reconciliation,
page switches, hot reload) from triggering full teardown.

### onDiagnostic hook

```ts
aio.run({
  diagnostics: {
    onDiagnostic: (event) => {
      sentry.captureMessage(event.summary, { extra: event.detail });
    },
  },
});
```

Fires for every event with no throttling. Console output is throttled (same
kind+trigger suppressed for 2s).

### Re-render storm detection

Checks every 1s whether `_subscribe` callbacks exceeded 30. Runs independently
of probe status. Indicates expensive components or unstable selectors:
`[aio:vitals] RE-RENDER STORM -- 47 subscribe callbacks in last 1s`.

### Resource pressure warnings

| Source             | Where  | Default             | Warns about             |
| ------------------ | ------ | ------------------- | ----------------------- |
| Payload size       | Server | 500KB per broadcast | Large state deltas      |
| Broadcast rate     | Server | 30/sec              | High dispatch frequency |
| Render degradation | Client | 50ms drift          | Main thread under load  |

Configure: `vitals.pressure: { payloadThreshold, rateThreshold }`.
`pressure: false` disables. Default: on in dev, off in prod.

---

## VitalAlert

```ts
type VitalAlert = {
  id: string; // correlation ID
  layer: "render" | "transport" | "loop";
  status: VitalStatus;
  duration: number; // condition duration (ms)
  measured: number; // raw measurement value
  threshold: number; // threshold breached
  hint: VitalHint | null;
  ts: number;
  correlationId?: string;
};
```

## HTTP endpoint

`GET /__aio/vitals` returns JSON:

```json
{
  "server": {
    "loop": {
      "queueDepth": 0,
      "drainRate": 12.5,
      "lastReduceTime": 3.2,
      "p95ReduceTime": 8.1
    }
  },
  "clients": [{ "id": "abc123", "status": "healthy" }],
  "payloadStats": {
    "abc123": { "lastPayloadBytes": 1234, "totalBytes": 56789 }
  },
  "cellSizes": { "counter": 128, "wallet": 4096 }
}
```

## Key types

```ts
type VitalStatus = "healthy" | "degraded" | "warning" | "frozen" | "recovered";
type VitalLayer = "render" | "transport" | "loop";
type VitalsConfig = {
  heartbeatInterval?: number;
  thresholds?: Partial<VitalThresholds>;
  hints?: boolean;
  onVitalAlert?: (alert: VitalAlert) => void;
  onDiagnostic?: (event: DiagEvent) => void;
};
type LoopVitals = {
  queueDepth: number;
  drainRate: number;
  lastReduceTime: number;
  lastReduceAction: string;
  lastReduceCell: string;
  p95ReduceTime: number;
  effectBacklog: number;
  circuitBreakers: string[];
};
```

Default thresholds: render 50/200/2000ms, transport 100/500/2000ms, loop
100/500/2000ms, queue 50/200/1000 actions.
