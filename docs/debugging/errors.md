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
| **Client log forwarding**   | All client console output in `~/.<appId>/logs/client.log`   | Client-side errors without devtools       |
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
| `HOOK_ERROR`         | Hook        | `beforeReduce`, `onAction`, or `onEffect` hook threw          |
| `INIT_ERROR`         | Lifecycle   | Cell `onInit` callback threw                                  |
| `DESTROY_ERROR`      | Lifecycle   | Cell `onDestroy` callback threw                               |
| `MACHINE_BLOCKED`    | Routing     | Action blocked by internal routing guard (warn-level)         |
| `QUEUE_OVERFLOW`     | Dispatch    | Dispatch queue exceeded 10,000 entries                        |
| `DISPATCH_LOOP`      | Dispatch    | 1,000 iterations detected -- dispatch recovers after draining |
| `DISPATCH_CLOSED`    | Dispatch    | Action dispatched after close() -- dropped, not applied       |
| `MEMORY_PRESSURE`    | Memory      | Heap above warning threshold (default 75%)                    |
| `MEMORY_CRITICAL`    | Memory      | Heap above critical threshold (default 90%)                   |
| `BUDGET_REDUCE`      | Performance | Reducer exceeded time budget (default 100ms)                  |
| `BUDGET_EFFECT`      | Performance | Effect exceeded time budget (default 5ms)                     |
| `PERSIST_ERROR`      | Persistence | State persist to SQLite failed -- in memory, lost on exit     |
| `PERSIST_SCHEMA`     | Persistence | Stored state's persistence-schema version is incompatible     |
| `TX_CONFLICT`        | Effect      | Transactional method's reads went stale -- commit refused     |
| `UI_FREEZE`          | Vitals      | UI/main thread stalled past the freeze threshold (warn)       |
| `TRANSPORT_STALL`    | Vitals      | WS transport made no progress under backpressure (warn)       |
| `LOOP_SATURATED`     | Vitals      | Event loop saturated -- work queued faster than it drains     |

### Error layer identification

The error code prefix tells you which layer broke:

| Prefix                   | Layer           | Where to look                          |
| ------------------------ | --------------- | -------------------------------------- |
| `REDUCE_*`               | Cell reducer    | Your sync `methods` code               |
| `EFFECT_*`               | Cell executor   | Your async methods                     |
| `HOOK_*`                 | Lifecycle hooks | `beforeReduce`, `onAction`, `onEffect` |
| `INIT_*` / `DESTROY_*`   | Cell lifecycle  | `onInit`, `onDestroy` callbacks        |
| `MACHINE_*`              | Action routing  | Internal routing guard (warn-level)    |
| `QUEUE_*` / `DISPATCH_*` | Dispatch loop   | Infinite dispatch cycles               |
| `MEMORY_*`               | Runtime         | Unbounded state growth                 |
| `BUDGET_*`               | Performance     | Slow reducer or effect                 |
| `PERSIST_*`              | Persistence     | SQLite write failures                  |

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
grep 'a1b2c3d4' ~/.<appId>/logs/error.log
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

AIO writes 5 plain text log files to `~/.<appId>/logs/` (configurable). Logging
is enabled by default.

| File          | Content                                                                         | When to use                      |
| ------------- | ------------------------------------------------------------------------------- | -------------------------------- |
| `app.log`     | State changes, flow completions, errors (info + error only)                     | Operational overview             |
| `debug.log`   | All actions dispatched — needs `level: "debug"` or `"trace"` (default `"info"`) | Action-by-action replay          |
| `error.log`   | Errors only                                                                     | Incident investigation, alerting |
| `warning.log` | Warnings -- non-fatal issues                                                    | Performance tuning               |
| `perf.log`    | Budget violations with phase breakdown                                          | Finding hot spots                |
| `client.log`  | All console output forwarded from AIR clients                                   | Client-side debugging            |

### Log format

```
2026-03-23 14:22:35.123  ERROR  cell:orderer  placeOrder failed  code=REDUCE_ERROR cid=a1b2c3d4
```

Columns: timestamp, level (padded to 5), category (padded to 10), message, data
(key=value), duration, source. All separated by 2 spaces.

**Every line aio prints carries a level, and the level is the instruction:**

| Level   | What it means for you                             |
| ------- | ------------------------------------------------- |
| `INFO`  | Nothing to do — this is the app narrating itself  |
| `WARN`  | Something should be fixed; the app keeps working  |
| `ERROR` | Something must be fixed; something did not happen |

The framework never prints an unlevelled line. The level also picks the console
stream and method, so `2>` separates warnings and errors from ordinary output,
and a host process watching `console.warn` sees warnings:

| Level           | Stream | Method          |
| --------------- | ------ | --------------- |
| `ERROR`         | stderr | `console.error` |
| `WARN`          | stderr | `console.warn`  |
| `INFO`          | stdout | `console.info`  |
| `DEBUG`/`TRACE` | stdout | `console.debug` |

### Colour

ANSI colour is decoration and never changes a character of the message. It is
emitted only when stdout is a terminal; `NO_COLOR=1` turns it off,
`FORCE_COLOR=1` forces it on for a pipe that renders escapes anyway. Log FILES
are never coloured.

### Configuration

```ts
await aio.run({
  logging: {
    level: "info", // 'trace'|'debug'|'info'|'warn'|'error' — default 'info'; 'trace' logs every dispatch
    dir: "/var/log/wallet", // override; default is `~/.<appId>/logs`
    console: true, // pretty-print to dev console (ANSI colors)
    heartbeat: 3600, // uptime summary every N seconds
    suppressTypes: ["timer:tick"], // hide noisy actions from debug.log
    backupLogs: true, // keep previous logs on restart (DEFAULT — false wipes on start)
    backupKeep: 7, // backup archives to keep (default: 7, 0 = unlimited)
    logBudget: 200 * 1024 * 1024, // byte ceiling for logs/ (default: 200MB, 0 = unlimited)
  },
});
```

### Retention

Logs are kept, not wiped: on every start the live files rotate to `.1`, older
archives shift up, and anything past `backupKeep` is removed. `.1` is always the
run that just ended — including the crash you restarted because of, and the dev
run a cell-file save just respawned.

Nothing rotates a log mid-run, so `logBudget` is what actually bounds the disk:
after rotating, archives are evicted **oldest run first** until `logs/` fits,
and every eviction is logged. Live files are counted but never evicted — if they
alone exceed the budget you get a warning, not a deleted log.

- `--no-backup-logs` — wipe on start (the old default), archives included.
- `--log-budget=500MB` (or bytes, or `0` for unlimited).
- `am start` applies the same policy to `stdout.log` before it spawns the app —
  it is the one log the app cannot rotate itself (the shell holds its fd).

### Client log (`client.log`)

All `console.log/warn/error/info/debug` output from connected AIR clients is
forwarded to `~/.<appId>/logs/client.log`. Uncaught errors and unhandled
rejections are also captured.

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

| Type                           | Severity | Meaning                                             |
| ------------------------------ | -------- | --------------------------------------------------- |
| `action-dropped`               | warning  | Action silently dropped (queue full)                |
| `state-sync-error`             | error    | Failed to parse state from server                   |
| `state-key-stripped`           | warning  | Reserved key name removed from state                |
| `state-no-listeners`           | warning  | State updating but no UI subscribers                |
| `action-guarded`               | info     | Action blocked by internal routing guard            |
| `action-filtered`              | info     | Action dropped by beforeReduce                      |
| `effect-invalid`               | warning  | Effect missing .type string, skipped                |
| `transport-error`              | warning  | UDS/IPC write failed                                |
| `hook-start-failed`            | error    | onStart hook threw                                  |
| `persist-error`                | error    | State persistence failed                            |
| `vitals-alert`                 | varies   | Vital signs probe detected degradation              |
| `offline-storage-error`        | info     | IndexedDB operation failed                          |
| `offline-storage-unavailable`  | warning  | No offline storage — queued actions are memory-only |
| `offline-action-not-persisted` | warning  | Action queued in memory only — lost on reload       |
| `degraded:<name>`              | error    | A best-effort operation has failed N times in a row |
| `degraded-recovered:<name>`    | info     | …and started working again                          |

## Subsystems that are allowed to fail

Every app has corners that degrade by design: a cache that refetches, a
best-effort write, a frame that will be retried. The failure nobody plans for is
the one where such a corner fails **forever** — each occurrence is individually
harmless, so it is logged or swallowed, and the app reports itself healthy while
a whole feature is dead.

`degraded()` makes that transition an event:

```ts
import { degraded } from "aio";

const cache = degraded("nft-cache"); // escalates after 5 in a row (default)

// Either wrap the call…
const rows = await cache.guard(() => db.query(sql)); // undefined on failure
// …or record the outcome yourself:
try {
  await refresh();
  cache.ok();
} catch (e) {
  cache.fail(e);
}
```

One structured event on the way down, one on the way back up, and nothing in
between — per-occurrence spam is what made the original invisible. While an
operation is degraded it appears in `degradedReport()` and in `/__aio/health`,
which reports `status: "degraded"` and names it:

```json
{
  "status": "degraded",
  "degraded": [{ "name": "nft-cache", "failures": 41, "lastError": "..." }]
}
```

The counter is CONSECUTIVE: one success ends the episode. An intermittent
failure never escalates, which is the point — you want to hear about the ones
that stopped recovering.

Scope: each runtime keeps its own registry, and **browser escalations travel**:
a connected client relays escalation/recovery over the wire (the `cdiag` frame),
so `/__aio/health` also reports client-side degradations, aggregated across
connected clients:

```json
{
  "status": "degraded",
  "clientDegraded": [{ "name": "sync-frame", "clients": 3, "lastError": "…" }]
}
```

A client's records are dropped when it disconnects — health reflects only live
signal. (The browser's own console and diagnostics overlay still report locally,
on the spot.)

## `TypeError: Cannot assign to read only property` in dev

In dev, every cell's state slice is deep-frozen when it arrives from the server.
A component that tries to mutate the value directly (`counter.count = 99`)
throws with this message — the dev hint
`[aio] state is read-only — call a cell method to change it (rule AIO2)` fires
once. Fix: call a cell method, or `useLocal()` for component-local state that
should be mutable.

In prod, slices are not frozen; stray mutations silently desync. The dev freeze
is your early warning.
