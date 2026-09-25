# Vitals

Client diagnostic system for detecting and diagnosing UI freezes. Three probes
measure different layers; on the server, a hint engine correlates the loop and
transport signals into a root-cause diagnosis. The browser runs no hint engine:
it measures, reports its own render status with a one-line render hint, and
sends its staleness to the server.

## Architecture

```
Client (Browser/Electron)              Server
+----------------------------+    +----------------------------+
| RenderMeter                |    | LoopProbe                  |
|  rAF staleness             |    |  hooks into dispatch()     |
|  renderHint() one-liner    |    |  queue depth, drain rate   |
|                            |    |  reduce timing, p95        |
| TransportProbe (client)    |    |                            |
|  sends ping, measures RTT  |    | TransportProbe (server)    |
|                            |    |  tracks client pings       |
|                            |    |  detects frozen clients    |
|                            |    |                            |
|                            |    | HintEngine (server only)   |
|                            |    |  correlates loop+transport |
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

**Which signal gets which tiers.** `degraded` and `warning` need a measurement
with a scale -- render staleness, reduce time, queue depth, RTT. The server's
per-client liveness watchdog has no such measurement: all it knows is the age of
the last heartbeat, and a heartbeat that arrives every second is between 0 and
1000ms old whenever you look. So a client row in `/__aio/vitals` is only ever
`healthy`, `frozen` (nothing heard for `transport.frozen`, default 2s -- the
broadcaster skips these clients) or `recovered`. Grading it against the
transport tiers reported _every live client_ as `degraded` (measured on a real
tab: 83% degraded, 16% warning, 0.7% healthy), which is a field nobody can act
on. `transport.degraded` / `transport.warning` are the **RTT** tiers, applied
client-side to the `vitals-ping`/`vitals-pong` round trip.

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
        thresholds: {             // override per-layer thresholds
          transport: { degraded: 100, warning: 500, frozen: 2000 }, // only frozen is read
          loop:      { degraded: 100, warning: 500, frozen: 2000 }, // ms
          queue:     { degraded: 50,  warning: 200, frozen: 1000 }, // actions
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

Two threshold keys are accepted but read by nothing, and the server warns once
at boot when they are set: `thresholds.render` (the browser grades render
staleness against `renderBudget` — see RenderMeter below) and a custom
`transport.degraded` / `transport.warning` (the browser's RTT probe grades on
the built-in tiers; the server reads `transport.frozen` alone).

`backpressure: false` turns off the per-client send throttle: a client that
reports itself behind is no longer sent state at a reduced rate (2x above 100ms
of reported render staleness, 4x above 300ms — fixed, not the transport tiers).
Leave it on unless you have measured that the throttle is what is holding a
client back — the hint engine says so by name when it is.

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

Queue depth and reduce time are both graded and the worse status wins; on a tie
the queue drives the alert (its number is an action count, the loop's is ms).

### RenderMeter (client)

Frame-level measurement using `requestAnimationFrame` (it replaced the older
`setTimeout`-drift RenderProbe, which no longer exists).

| Metric           | Description                                |
| ---------------- | ------------------------------------------ |
| `staleness`      | ms since last unpainted state update       |
| `frameTime`      | ms between consecutive rAF callbacks       |
| `pendingPatches` | Unprocessed delta patches waiting to paint |
| `paintRate`      | Frames per second (1s rolling window)      |
| `memory`         | JS heap usage gauge (Chrome/Edge only)     |

Staleness-based status: `< threshold` = healthy, `>= 1x` = degraded, `>= 2x` =
warning, `>= 5x` = frozen. Default staleness threshold: 300ms.

Frozen clients stop receiving deltas from server, and are sent whole state the
moment they recover. Visibility pause: hidden tabs suppress false alarms.

The key is `renderBudget: { staleness, pendingPatches }` on `aio.run`. It
reaches the page through the shell (`__aioConfig`) and the `cfg` frame, and the
browser runtime (`src/browser/browser-vitals.ts`) reads it when the WebSocket
opens:

- every applied `state`/`patches` frame is recorded as an unpainted patch;
- a `requestAnimationFrame` loop measures how long the newest one stays
  unpainted (staleness), the frame gap, the pending count and the paint rate;
- a threshold crossing is reported once per status change — a `console.warn`
  with the render meter's one-line hint (`renderHint()`: expensive components
  vs. patch rate vs. a blocked main thread — not the hint engine, which runs
  only on the server) (prod and dev), and a `vitals:render-stale` /
  `vitals:render-frozen` / `vitals:render-recovered` event on the diagnostic bus
  (dev overlay, `am errors`, client-log);
- the heartbeat carries the staleness to the server (`vitals-ping {t1, ms}`,
  every second), which is what drives per-client backpressure and the `clients`
  rows of `/__aio/vitals`.

The heartbeat rides the WebSocket only; an Electron window on the IPC/UDS
transport has no ping (the envelope refuses `vitals-ping` there), so its render
meter runs but the server's client rows stay empty for it.

### TransportProbe (client + server)

Measures RTT via `vitals-ping`/`vitals-pong` frames over WebSocket. Client sends
ping with `t1` (and `ms`, its render staleness — see above), server responds
with `t2` and loop vitals.

Two different measurements, on purpose:

- **client** — RTT, `Date.now() - pong.t1`, both stamps from the browser's own
  clock. Graded against `transport.degraded / warning / frozen`.
- **server** — liveness only. It stamps `lastPing` with its OWN clock (a
  cross-clock subtraction is a latency plus a constant offset, not an elapsed
  time) and asks one question: has this client been silent for longer than
  `transport.frozen`? Answer: `healthy` / `frozen` / `recovered`. Only a client
  that has sent at least one `vitals-ping` is graded: a peer that never speaks
  the heartbeat protocol (a CLI client, the dev reload socket) is registered but
  never frozen — a silent socket is caught by the broadcaster's `bufferedAmount`
  check instead. Frozen clients are skipped by the broadcaster
  (`server-broadcast.ts`) and are what raises the `transport` alert.

The vitals protocol runs over WebSocket only. There is no IPC keepalive: the
envelope refuses `vitals-ping` on UDS and IPC by name, so the Electron bridge
never pings (`src/browser/browser-vitals.ts`).

---

## Measurement pipeline

```
Server                              Client
+---------------------+    +--------------------------+
| dispatch() called   |    | RenderMeter              |
|   performance.now() |    |   rAF gap -> staleness   |
|   LoopProbe collects|    |   status change ->       |
|     reduceTime      |    |     console.warn +       |
|     queueDepth      |    |     renderHint() line +  |
|     drainRate       |    |     diag bus (dev)       |
|          |          |    |                          |
| TransportProbe  <---+----| vitals-ping {t1, ms}     |
|  (liveness, ms)     |    |                          |
| vitals-pong --------+--->| TransportProbe (client)  |
|          |          |    |   pong -> RTT            |
| VitalsSnapshot      |    +--------------------------+
| HintEngine          |
|  -> root-cause hint |
| perf.log line       |
| onVitalAlert hook   |
| DiagReporter        |
|  (server console,   |
|   onDiagnostic hook)|
| GET /__aio/vitals   |
+---------------------+
```

The server pipeline runs on each heartbeat interval (default: 1000ms). The
snapshot, the hint engine, `onVitalAlert` and `onDiagnostic` are all
server-side; the client has none of them.

---

## Hint engine

Pure function: takes `VitalsSnapshot`, produces a `VitalHint` with cause,
evidence, and suggestion. It runs on the SERVER only (`src/vitals/mod.ts`, for
each alert and the timeline summary) — the browser never calls it. The server
has no render probe, so its snapshot always reads render `healthy`: of the six
rules below, only **2** (queue saturation) and **3** (transport stall) can fire
today. Rules 1, 4, 5 and 6 read the render layer and are kept for a snapshot
that carries one. Six rules evaluated in priority order -- first match wins:

| # | Rule                  | Trigger                                                | Severity   |
| - | --------------------- | ------------------------------------------------------ | ---------- |
| 6 | Visibility filter     | Render frozen but tab hidden -- discard                | --         |
| 5 | Recovery death spiral | Multiple freeze-recover cycles in 30s                  | `likely`   |
| 1 | Slow reduce freeze    | Render frozen + reduce time over budget + same action  | `likely`   |
| 2 | Queue saturation      | Queue depth over frozen threshold + loop degraded      | `likely`   |
| 3 | Transport stall       | Transport frozen + render/loop healthy                 | `possible` |
| 4 | Client-only freeze    | Render frozen + transport/loop healthy + no AIO action | `possible` |

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
- **Client** -- no reporter object and no `DiagEvent`: the browser's render
  meter reports its own status changes as a `console.warn` line and a
  `vitals:render-*` event on the dev diagnostic bus (see RenderMeter above).
  `onDiagnostic` never fires for a client-side render freeze.

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
[aio:vitals] SLOW DISPATCH -- portfolio.refresh took 1847ms (budget: 500ms)
  trigger:    portfolio.refresh reduce took 1847ms (p95: 45ms)
  queue:      12 actions pending, drain rate 2.1/s
```

This is the server reporter. A render freeze is a browser-side measurement and
prints the client's own one-liner instead
(`[aio:vitals] render FROZEN — …ms
behind (renderBudget.staleness …ms) — <render hint>`).

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

### Resource pressure warnings

| Source           | Where  | Default              | Warns about             |
| ---------------- | ------ | -------------------- | ----------------------- |
| Payload size     | Server | 500KB per broadcast  | Large state deltas      |
| Broadcast rate   | Server | 30/sec               | High dispatch frequency |
| Render staleness | Client | 300ms (renderBudget) | Main thread under load  |

Configure: `vitals.pressure: { payloadThreshold, rateThreshold }`.
`pressure: false` disables. Default: on in dev and prod (it is observe-only).

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
  "clients": [{ "id": "abc123", "status": "healthy", "gap": 412 }],
  "payloadStats": {
    "abc123": { "lastPayloadBytes": 1234, "totalBytes": 56789 }
  },
  "cellSizes": { "counter": 128, "wallet": 4096 }
}
```

A client row is liveness, not latency: `status` is `healthy` / `frozen` /
`recovered`, `gap` is ms since the server last heard from that client (0–1000 in
normal operation, one heartbeat interval), and `frozenFor` is that same gap,
present only while the row is frozen. RTT lives on the client that measured it.

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
