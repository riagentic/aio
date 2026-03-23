# Diagnostics

AIO includes built-in diagnostics for state tracking, crash recovery, and error
monitoring. Everything works out of the box — zero config needed.

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
| Circuit breaker (auto-disable) | opt-in | opt-in            |

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

| File                  | Contents                                                      |
| --------------------- | ------------------------------------------------------------- |
| `log/app.log`         | Info + error — the main operational log                       |
| `log/debug.log`       | Verbose: state diffs, action traces, framework internals      |
| `log/error.log`       | Errors only — all `AioError` instances                        |
| `log/warning.log`     | Warnings only                                                 |
| `log/perf.log`        | Reducer/effect timings that exceeded their budget             |
| `log/actions.jsonl`   | Rolling JSONL of all dispatched actions (dev only by default) |
| `log/checkpoint.json` | Latest state snapshot for crash recovery                      |

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
