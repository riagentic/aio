# Errors

AioError format, error codes, correlation IDs, log files, and the onError hook.

## Debugging toolkit

| Tool                        | What it does                                                | When to use                               |
| --------------------------- | ----------------------------------------------------------- | ----------------------------------------- |
| **AioError console output** | Rich error boxes with cell, action, stack, state, tips      | First thing you see when something breaks |
| **Correlation IDs**         | Trace an action through its entire lifecycle                | Multi-step flows, cross-cell debugging    |
| **onError hook**            | Unified callback for ALL errors                             | Monitoring, alerting, Sentry/Datadog      |
| **Time-travel debugger**    | Walk through every action and state snapshot                | "How did state get into this shape?"      |
| **Log files**               | 5 plain text logs (app, debug, error, warning, perf)        | Post-incident forensics                   |
| **Memory pressure monitor** | Alerts before OOM with per-cell sizing                      | Long-running apps, memory leaks           |
| **Cell health audit**       | Per-cell error count, status, last action                   | Runtime inspection, ops dashboards        |
| **Client log forwarding**   | All client console output in `log/client.log`               | Client-side errors without devtools       |
| **Browser error overlay**   | Build Error / Runtime Error overlay with fix suggestions    | UI development                            |
| **DiagReporter**            | Structured console output for freeze/stale/slow + hints     | UI freezes, stale data, slow dispatch     |
| **Performance budgets**     | Warns when reducers/effects exceed time budgets             | Finding slow code                         |
| **Startup linter**          | Validates cell config on `aio.run()`                        | Catching config mistakes early            |
| **Diagnostics module**      | State diffs, action log, checkpoint recovery, crash handler | Full observability                        |

---

## AioError console output

Every AIO error produces a structured `AioError`. In dev mode, errors appear as
colored boxes:

```
+-  AIO ERROR -----------------------------------------+
| REDUCE_ERROR in cell 'orderer'                    |
| Action: orderer:placeOrder                           |
| Machine state: idle                                  |
|                                                      |
| Cannot read property 'price' of undefined            |
|                                                      |
| at orderer.reduce (src/cell/orderer.ts:47:12)    |
|                                                      |
| State at crash:                                      |
|   { status: 'idle', orders: [], lastPrice: null }    |
|                                                      |
| Tip: Check if the action payload has the expected    |
|      shape.                                          |
| Correlation: a1b2c3d4                                |
+------------------------------------------------------+
```

**Fields shown:** error code, cell name, action/effect/flow, filtered stack
trace (your code only), state snapshot, actionable tip, correlation ID.

In prod mode, errors are compact one-liners:

```
[ERROR] REDUCE_ERROR orderer:placeOrder -- Cannot read property 'price' of undefined (cid:a1b2c3d4)
```

### Error codes reference

| Code                 | Source      | What happened                                                 |
| -------------------- | ----------- | ------------------------------------------------------------- |
| `REDUCE_ERROR`       | Reducer     | Reducer threw or returned invalid shape                       |
| `EFFECT_ERROR`       | Effect      | Sync effect (executor) threw                                  |
| `EFFECT_TIMEOUT`     | Effect      | Async effect exceeded timeout (default 30s)                   |
| `EFFECT_ASYNC_ERROR` | Effect      | Async effect promise rejected                                 |
| `FLOW_STEP_ERROR`    | Flow        | A flow generator step threw (fed back to generator)           |
| `FLOW_UNCAUGHT`      | Flow        | Flow threw without user try/catch -- includes step history    |
| `HOOK_ERROR`         | Hook        | `beforeReduce`, `onAction`, or `onEffect` hook threw          |
| `INIT_ERROR`         | Lifecycle   | Cell `onInit` callback threw                                  |
| `DESTROY_ERROR`      | Lifecycle   | Cell `onDestroy` callback threw                               |
| `MACHINE_BLOCKED`    | Machine     | Action blocked by state machine (warn-level)                  |
| `QUEUE_OVERFLOW`     | Dispatch    | Dispatch queue exceeded 10,000 entries                        |
| `DISPATCH_LOOP`      | Dispatch    | 1,000 iterations detected -- dispatch recovers after draining |
| `MEMORY_PRESSURE`    | Memory      | Heap above warning threshold (default 75%)                    |
| `MEMORY_CRITICAL`    | Memory      | Heap above critical threshold (default 90%)                   |
| `BUDGET_REDUCE`      | Performance | Reducer exceeded time budget (default 100ms)                  |
| `BUDGET_EFFECT`      | Performance | Effect exceeded time budget (default 5ms)                     |

### Error layer identification

The error code prefix tells you which layer broke:

| Prefix                   | Layer           | Where to look                          |
| ------------------------ | --------------- | -------------------------------------- |
| `REDUCE_*`               | Cell reducer    | Your `reduce` or `methods` code        |
| `EFFECT_*`               | Cell executor   | Your `execute` handlers, async methods |
| `FLOW_*`                 | Generator flow  | Your `generators` code                 |
| `HOOK_*`                 | Lifecycle hooks | `beforeReduce`, `onAction`, `onEffect` |
| `INIT_*` / `DESTROY_*`   | Cell lifecycle  | `onInit`, `onDestroy` callbacks        |
| `MACHINE_*`              | State machine   | Machine config, transition guards      |
| `QUEUE_*` / `DISPATCH_*` | Dispatch loop   | Infinite dispatch cycles               |
| `MEMORY_*`               | Runtime         | Unbounded state growth                 |
| `BUDGET_*`               | Performance     | Slow reducer or effect                 |

### Action type prefix

All actions are prefixed: `counter:increment`, `wallet:transfer`. Format is
`cellName:actionKey`. The prefix (before `:`) is the cell name.

---

## Correlation IDs

Every dispatched action gets a unique 8-char correlation ID. All errors produced
during that action's lifecycle -- reduce, effects, cross-cell calls -- share the
same ID.

```
2026-03-23 14:22:35.123  ERROR  cell:orderer  placeOrder failed  code=REDUCE_ERROR cid=a1b2c3d4
2026-03-23 14:22:35.124  ERROR  cell:orderer  effect failed  code=EFFECT_ASYNC_ERROR cid=a1b2c3d4
```

Grep by correlation ID to see the full chain:

```bash
grep 'a1b2c3d4' log/error.log
```

---

## onError hook

Every error in AIO routes through the `onError` callback:

```ts
await aio.run({
  cells: [counter, wallet],
  onError(err) {
    console.log(err.code); // 'REDUCE_ERROR'
    console.log(err.source); // 'reduce'
    console.log(err.context.cellName); // 'orderer'
    console.log(err.context.actionType); // 'orderer:placeOrder'
    console.log(err.original?.stack); // full original stack trace
    console.log(err.correlationId); // 'a1b2c3d4'
    console.log(err.stateSnapshot); // state at moment of error

    sentry.captureException(err);
    metrics.increment(`aio.error.${err.code}`);
  },
});
```

### AioError fields

| Field           | Type                 | Description                                             |
| --------------- | -------------------- | ------------------------------------------------------- |
| `code`          | `AioErrorCode`       | Machine-readable error type                             |
| `source`        | `AioErrorSource`     | Layer: `'reduce'`, `'effect'`, `'flow'`, `'hook'`, etc. |
| `message`       | `string`             | Human-readable error message                            |
| `context`       | `AioErrorContext`    | Structured metadata (cell, action, effect, flow, etc.)  |
| `original`      | `Error \| undefined` | Original thrown Error with preserved `.stack`           |
| `correlationId` | `string`             | 8-char UUID tracing the action lifecycle                |
| `timestamp`     | `number`             | `Date.now()` at error creation                          |
| `stateSnapshot` | `unknown`            | Cell state at time of error (when available)            |

---

## Log files

AIO writes 5 plain text log files to `./log/` (configurable). Logging is enabled
by default.

| File          | Content                                                     | When to use                      |
| ------------- | ----------------------------------------------------------- | -------------------------------- |
| `app.log`     | State changes, flow completions, errors (info + error only) | Operational overview             |
| `debug.log`   | All actions dispatched (unless suppressed)                  | Action-by-action replay          |
| `error.log`   | Errors only                                                 | Incident investigation, alerting |
| `warning.log` | Warnings -- non-fatal issues                                | Performance tuning               |
| `perf.log`    | Budget violations with phase breakdown                      | Finding hot spots                |
| `client.log`  | All console output forwarded from AIR clients               | Client-side debugging            |

### Log format

```
2026-03-23 14:22:35.123  ERROR  cell:orderer  placeOrder failed  code=REDUCE_ERROR cid=a1b2c3d4
```

Columns: timestamp, level (padded to 5), category (padded to 10), message, data
(key=value), duration, source. All separated by 2 spaces.

### Configuration

```ts
await aio.run({
  logging: {
    level: "info", // 'trace' | 'debug' | 'info' | 'warn' | 'error'
    dir: "./log", // output directory
    console: true, // pretty-print to dev console (ANSI colors)
    heartbeat: 3600, // uptime summary every N seconds
    suppressTypes: ["timer:tick"], // hide noisy actions from debug.log
    backupLogs: true, // keep previous logs on restart
    backupKeep: 7, // backup archives to keep (default: 7)
  },
});
```

### Client log (`client.log`)

All `console.log/warn/error/info/debug` output from connected AIR clients is
forwarded to `log/client.log`. Uncaught errors and unhandled rejections are also
captured.

```
[2026-04-03T14:22:01.123Z] [ERROR] [client:0] TypeError: Cannot read 'x' of null
  at Dashboard.render (dashboard.ts:42)
[2026-04-03T14:22:01.200Z] [INFO]  [client:0] mounted OrderPanel
```

Forwarding is automatic in dev mode. Rate limited to 100 messages/sec per
client. Tail client logs: `deno task am log --client` or `--client -f` for live
stream.

### Forensics workflow

1. Check `error.log` first -- every error, never deduplicated
2. Find the correlation ID from the error
3. Grep `debug.log` for that correlation ID to see the full action chain
4. Check `perf.log` if the error might be performance-related
5. Check `app.log` for the broader narrative (state transitions, flow
   completions)

---

## Diagnostic bus event types

| Type                    | Severity | Meaning                                   |
| ----------------------- | -------- | ----------------------------------------- |
| `action-dropped`        | warning  | Action silently dropped (queue full)      |
| `state-sync-error`      | error    | Failed to parse state from server         |
| `state-key-stripped`    | warning  | Reserved key name removed from state      |
| `state-no-listeners`    | warning  | State updating but no UI subscribers      |
| `action-guarded`        | info     | Action blocked by machine state guard     |
| `action-filtered`       | info     | Action dropped by beforeReduce middleware |
| `effect-invalid`        | warning  | Effect missing .type string, skipped      |
| `transport-error`       | warning  | UDS/IPC write failed                      |
| `hook-start-failed`     | error    | onStart hook threw                        |
| `persist-error`         | error    | State persistence failed                  |
| `vitals-alert`          | varies   | Vital signs probe detected degradation    |
| `offline-storage-error` | info     | IndexedDB operation failed                |

## `TypeError: Cannot assign to read only property` in dev

In dev, every cell's state slice is deep-frozen when it arrives from the
server. A component that tries to mutate the value directly
(`counter.count = 99`) throws with this message — the dev hint
`[aio] state is read-only — call a cell method to change it (rule AIO2)`
fires once. Fix: call a cell method, or `useLocal()` for component-local
state that should be mutable.

In prod, slices are not frozen; stray mutations silently desync. The dev
freeze is your early warning.

