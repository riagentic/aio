# Diagnostics

AIO includes built-in diagnostics for state tracking, crash recovery, and error
monitoring. Everything works out of the box — zero config needed.

**Something broken?** Start with [troubleshooting.md](troubleshooting.md) —
symptom-based guide with fix paths.

For the docs index, see [manual.md](manual.md). For log file details, see
[debugging.md](debugging.md).

## What's On By Default

| Feature                        | Dev    | Prod              |
| ------------------------------ | ------ | ----------------- |
| Console logging                | on     | on (info + error) |
| Memory monitor                 | on     | off               |
| State diffs                    | on     | off               |
| Action log (JSONL)             | on     | off               |
| Checkpoint                     | on     | off               |
| Crash handler                  | on     | on                |
| Time-travel                    | on     | off               |
| Error counting                 | on     | on                |
| Vital signs (freeze detection) | on     | on (hints off)    |
| Resource pressure warnings     | on     | off               |
| Circuit breaker (auto-disable) | opt-in | opt-in            |

---

## Vitals Quick Reference

Everything below works out of the box — zero config. On first warning, the
browser console prints the `/__aio/vitals` dashboard URL.

### Browser Console (`console.warn`)

| Signal             | Fires when                                | Hint                                                                    |
| ------------------ | ----------------------------------------- | ----------------------------------------------------------------------- |
| STALENESS DEGRADED | UI 300ms+ behind                          | "components too expensive" / "too many patches" / "main thread blocked" |
| STALENESS WARNING  | UI 600ms+ behind                          | Same hints, higher urgency                                              |
| RENDER FROZEN      | UI 1.5s+ behind                           | Trigger action name                                                     |
| render recovered   | Freeze resolved                           | —                                                                       |
| useAio() warning   | `useAio()` used instead of `useFeature()` | "subscribes to full state tree" (once per site)                         |
| teardown           | All components unmounted 300ms            | Listener count                                                          |
| teardown-averted   | Components re-mounted within grace        | —                                                                       |
| action-dropped     | Queue full during disconnect              | Action type, queue size                                                 |

### Server Terminal (`console.warn`)

| Signal                 | Fires when                         | Detail                           |
| ---------------------- | ---------------------------------- | -------------------------------- |
| SLOW DISPATCH          | Reducer > 100ms                    | Action name, p95, queue depth    |
| DISCONNECTED           | Client ping gap > 2s               | Client ID, frozen duration       |
| STALE STATE            | Client RTT 100-500ms               | RTT, p95 reduce time             |
| PRESSURE — payload     | Broadcast > 500KB                  | Payload size, client ID          |
| PRESSURE — rate        | > 30 broadcasts/sec                | Count, threshold                 |
| PRESSURE — bandwidth   | Client avg > 1MB/s                 | MB/s, client ID                  |
| backpressure change    | Client staleness triggers throttle | Client ID, multiplier (1x→2x→4x) |
| backpressure recovered | Client catches up                  | Client ID, multiplier step-down  |

### Server Endpoint (`GET /__aio/vitals`)

| Data               | Description                                            |
| ------------------ | ------------------------------------------------------ |
| server.loop        | queueDepth, drainRate, lastReduceTime, p95ReduceTime   |
| server.gauges      | server.queueDepth (0-100%), server.reduceTime (0-100%) |
| clients[]          | ID, status, RTT, frozenFor                             |
| clientBackpressure | Per-client multiplier (1x/2x/4x)                       |
| featureSizes       | Bytes per state key                                    |
| payloadStats       | Total/avg/min/max broadcast bytes                      |

### Silent (automatic, no log output)

| What                    | Where   | Effect                                          |
| ----------------------- | ------- | ----------------------------------------------- |
| Notification coalescing | Browser | N patches/frame → 1 React render                |
| Skip-identical          | Browser | No-op patches skip React entirely               |
| Backpressure            | Server  | Throttles broadcasts to slow clients            |
| Visibility pause        | Browser | Hidden tab → meter paused, no false alarms      |
| Log suppression         | Browser | Max 5 warnings per incident, escalating backoff |

### Optional Config

```ts
aio.run({
  features: [...],
  renderBudget: { staleness: 500, pendingPatches: 20 }, // tune thresholds
  diagnostics: false, // disable everything (only explicit false)
});
```

Other performance options:

```ts
aio.run({
  perfCheck: "on", // enable perf.log violations (default)
  perfBudget: { reduce: 50, effect: 10 }, // ms thresholds
  effectTimeoutMs: 60_000, // async effect hard timeout (default: 30s)
});
```

---

## Customizing

Two-level config: built-in defaults + your overrides per mode.

```ts
aio.run({
  features: [...],
  diagnostics: {
    dev: {
      actionLog: { max: 5000 },   // increase action log size in dev
    },
    prod: {
      timeTravel: true,           // enable time-travel in prod
      console: false,             // silence console output in prod
      checkpoint: true,           // enable crash recovery in prod
    },
  },
})
```

Each field accepts:

- `true` — on with default options
- `false` — explicitly off
- `{ ...options }` — on with custom options
- omitted — use built-in default for that mode

**Kill switch:** `diagnostics: false` disables everything (useful for
benchmarks).

---

## State Diffs

Logs key-level changes to `debug.log` after each action. Only fires when state
actually changes.

```
[state-diff] counter: count 5→10, total 20→25
[state-diff] wallet: balance 1000→900, lastTx "transfer:abc123"
```

Values over 80 chars are truncated with `…`. Objects/arrays show a
`JSON.stringify` preview.

---

## Action Log

Rolling JSONL file at `log/actions.jsonl`. One line per action:

```jsonl
{"type":"counter:increment","payload":{"amount":5},"ts":1711152000000}
{"type":"wallet:transfer","payload":{"to":"0x...","amount":100},"ts":1711152001000}
```

Default cap: 1000 lines. When exceeded, the oldest half is truncated. Internal
framework actions are skipped.

To increase the cap:

```ts
diagnostics: {
  dev: { actionLog: { max: 5000 } },
}
```

---

## Checkpoint & Recovery

Debounced state snapshots written to `log/checkpoint.json` (default debounce:
5000ms). Atomic write via `.tmp` rename — no partial files.

On startup, AIO detects an existing checkpoint and logs:

```
[checkpoint] recovered state from 2026-03-23T14:30:00Z (age: 45s)
```

**Recovery is opt-in.** Use the `onCheckpointRestore` callback to decide whether
to restore:

```ts
aio.run({
  features: [...],
  onCheckpointRestore: (checkpoint) => {
    // checkpoint: CheckpointData — state + recent actions + feature health
    // return state to restore, or null to start fresh
    if (checkpoint.features.wallet.errors > 3) return null  // start fresh
    return checkpoint.state
  },
})
```

The checkpoint file is kept after reading — useful for post-mortem even if you
chose not to restore.

**Edge cases:**

- Corrupt or missing file → warning logged, `getRecoveredState()` returns null
- Checkpoint age > 1h → warning logged with age, restore still offered (app
  decides)

---

## Crash Handler

Installs global `unhandledrejection` and `error` listeners. On trigger:

1. Logs the error with full context via the structured logger
2. Logs per-feature error counts and enabled/disabled status
3. Writes an emergency checkpoint (synchronous — can't await during crash)
4. Re-throws — does not swallow the error

Active in both dev and prod with zero overhead until triggered. **Server-runtime
only** for file writes — in browser/Electron contexts, logs to console but skips
the file write.

---

## Vital Signs (Client Freeze Detection)

Three probes detect and diagnose UI freezes across the full stack:

- **LoopProbe** (server) — dispatch queue depth, reduce timing, effect backlog
- **RenderProbe** (client) — `setTimeout` drift freeze detection
- **RenderMeter** (client) — `requestAnimationFrame`-based continuous
  measurement (staleness, frame time, paint rate, memory)
- **TransportProbe** (client + server) — ping/pong RTT, client liveness watchdog

A **hint engine** correlates all probe signals into a root-cause diagnosis
(e.g., "Reducer for 'wallet/transfer' took 450ms" with severity and evidence).

Enabled by default. Dev mode enables hints; prod disables hints for lower
overhead. Kill switch: `vitals: false`.

```ts
diagnostics: {
  dev: {
    vitals: {
      heartbeatInterval: 1000,
      hints: true,
      onVitalAlert: (alert) => console.log(alert.layer, alert.status),
    },
  },
}
```

HTTP endpoint: `GET /__aio/vitals` — returns loop metrics + client liveness +
payload stats + per-feature state sizes.

**DiagReporter** — actionable console output when probes detect issues. Server
reporter handles slow dispatch, stale state, disconnects. Client reporter
handles render freezes. Structured blocks with root-cause hints in dev console.
Wire `onDiagnostic` for telemetry:

```ts
diagnostics: {
  dev: { vitals: true },
  onDiagnostic: (event) => sentry.captureMessage(event.summary),
}
```

For full configuration, types, thresholds, hint engine rules, and DiagReporter
details, see [vitals.md](vitals.md).

---

## Circuit Breaker

Error counting per feature is always on (feeds the health endpoint and
checkpoint data). Auto-disable is opt-in.

```ts
aio.run({
  features: [...],
  circuitBreaker: {
    maxErrors: 10,
    window: 60_000,   // rolling 60s window — errors older than this don't count
    onTrip: (name, count) => log.error(`feature ${name} tripped after ${count} errors`),
  },
})
```

Without `window`, errors are counted cumulatively since app start (legacy
behavior). With `window`, only errors within the last `window` ms count —
prevents stale errors tripping the breaker.

---

## Log Files

| File                  | Contents                                                                        |
| --------------------- | ------------------------------------------------------------------------------- |
| `log/app.log`         | Info + error — the main operational log                                         |
| `log/debug.log`       | Verbose: state diffs, action traces, framework internals                        |
| `log/error.log`       | Errors only — all `AioError` instances                                          |
| `log/warning.log`     | Warnings only                                                                   |
| `log/perf.log`        | Budget violations with phase breakdown (produce/clone/spread/routing/listeners) |
| `log/actions.jsonl`   | Rolling JSONL of all dispatched actions (dev only by default)                   |
| `log/checkpoint.json` | Latest state snapshot for crash recovery                                        |

---

## FAQ

**How do I enable time-travel in prod?**

```ts
diagnostics: {
  prod: {
    timeTravel: true;
  }
}
```

**How do I increase the action log size?**

```ts
diagnostics: {
  dev: {
    actionLog: {
      max: 5000;
    }
  }
}
```

**How do I disable diagnostics entirely?**

```ts
diagnostics: false;
```

This skips all diagnostics initialization — useful for benchmarks or profiling
the framework itself.
