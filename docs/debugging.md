# Debugging

Error interpretation, state forensics, and common fix patterns.

For the docs index, see [manual.md](manual.md). For time-travel details, see
[ui.md](ui.md). For performance budgets, see [scaling.md](scaling.md). For the
diagnostics module (state diffs, action log, checkpoint recovery), see
[diagnostics.md](diagnostics.md).

## Debugging toolkit — all your options

| Tool                                                         | What it does                                                    | When to use                                               |
| ------------------------------------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------- |
| [**AioError console output**](#aioerror-console-output)      | Rich error boxes with feature, action, stack trace, state, tips | First thing you see when something breaks                 |
| [**Correlation IDs**](#correlation-ids)                      | Trace an action through its entire lifecycle                    | Multi-step flows, cross-feature debugging                 |
| [**onError hook**](#onerror-hook)                            | Unified callback for ALL errors                                 | Monitoring, alerting, Sentry/Datadog integration          |
| [**Time-travel debugger**](#time-travel-for-state-forensics) | Walk through every action and state snapshot                    | "How did state get into this shape?"                      |
| [**Log files**](#log-files)                                  | 5 plain text logs (app, debug, error, warning, perf)            | Post-incident forensics                                   |
| [**Memory pressure monitor**](#memory-pressure-monitor)      | Alerts before OOM with per-feature sizing                       | Long-running apps, memory leaks                           |
| [**Feature health audit**](#feature-health-audit)            | Per-feature error count, status, last action                    | Runtime inspection, ops dashboards                        |
| [**Health endpoint**](#feature-health-audit)                 | `GET /__aio/health` JSON API                                    | External monitoring, load balancers                       |
| [**Browser error overlay**](#browser-errors)                 | Build Error / Runtime Error overlay with fix suggestions        | UI development                                            |
| [**Performance budgets**](#performance-debugging)            | Warns when reducers/effects exceed time budgets                 | Finding slow code                                         |
| [**Startup linter**](#startup-linter-output)                 | Validates feature config on `aio.run()`                         | Catching config mistakes early                            |
| [**Diagnostics module**](diagnostics.md)                     | State diffs, action log, checkpoint recovery, crash handler     | Full observability — see [diagnostics.md](diagnostics.md) |

---

## AioError console output

Every error in AIO produces a structured `AioError` with rich context. In dev
mode, errors appear as colored boxes in the console:

```
┌─ AIO ERROR ──────────────────────────────────────────────────
│ REDUCE_ERROR in feature 'orderer'
│ Action: orderer:placeOrder
│ Machine state: idle
│
│ Cannot read property 'price' of undefined
│
│ at orderer.reduce (src/features/orderer.ts:47:12)
│
│ State at crash:
│   { status: 'idle', orders: [], lastPrice: null }
│
│ Tip: Check if the action payload has the expected shape.
│ Correlation: a1b2c3d4
└──────────────────────────────────────────────────────────────
```

**What you see:**

- **Error code** — machine-readable type (e.g., `REDUCE_ERROR`,
  `EFFECT_TIMEOUT`, `FLOW_UNCAUGHT`)
- **Feature name** — which feature produced the error
- **Action/effect/flow** — what was happening when it broke
- **Stack trace** — filtered to show YOUR code only (framework internals hidden)
- **State snapshot** — the state at the moment of error (truncated in console,
  full in debug.log)
- **Tip** — actionable suggestion based on the error pattern
- **Correlation ID** — unique per dispatch, traces the full action chain

In prod mode, errors are compact one-liners:

```
[ERROR] REDUCE_ERROR orderer:placeOrder — Cannot read property 'price' of undefined (cid:a1b2c3d4)
```

### Error codes reference

| Code                 | Source      | What happened                                             |
| -------------------- | ----------- | --------------------------------------------------------- |
| `REDUCE_ERROR`       | Reducer     | Reducer threw an exception or returned invalid shape      |
| `EFFECT_ERROR`       | Effect      | Sync effect (executor) threw                              |
| `EFFECT_TIMEOUT`     | Effect      | Async effect exceeded timeout (default 30s)               |
| `EFFECT_ASYNC_ERROR` | Effect      | Async effect promise rejected                             |
| `FLOW_STEP_ERROR`    | Flow        | A flow generator step threw (fed back to generator)       |
| `FLOW_UNCAUGHT`      | Flow        | Flow threw without user try/catch — includes step history |
| `HOOK_ERROR`         | Hook        | `beforeReduce`, `onAction`, or `onEffect` hook threw      |
| `INIT_ERROR`         | Lifecycle   | Feature `onInit` callback threw                           |
| `DESTROY_ERROR`      | Lifecycle   | Feature `onDestroy` callback threw                        |
| `MACHINE_BLOCKED`    | Machine     | Action blocked by state machine (warn-level)              |
| `QUEUE_OVERFLOW`     | Dispatch    | Dispatch queue exceeded 10,000 entries                    |
| `DISPATCH_LOOP`      | Dispatch    | 1,000 iterations detected — possible infinite loop        |
| `MEMORY_PRESSURE`    | Memory      | Heap above warning threshold (default 75%)                |
| `MEMORY_CRITICAL`    | Memory      | Heap above critical threshold (default 90%)               |
| `BUDGET_REDUCE`      | Performance | Reducer exceeded time budget (default 100ms)              |
| `BUDGET_EFFECT`      | Performance | Effect exceeded time budget (default 5ms)                 |

### Error layer identification

When you see an error, the **code** tells you exactly which layer:

| Error code prefix        | Layer             | Where to look                          |
| ------------------------ | ----------------- | -------------------------------------- |
| `REDUCE_*`               | Feature reducer   | Your `reduce` or `methods` code        |
| `EFFECT_*`               | Feature executor  | Your `execute` handlers, async methods |
| `FLOW_*`                 | Generator flow    | Your `generators` code                 |
| `HOOK_*`                 | Lifecycle hooks   | `beforeReduce`, `onAction`, `onEffect` |
| `INIT_*` / `DESTROY_*`   | Feature lifecycle | `onInit`, `onDestroy` callbacks        |
| `MACHINE_*`              | State machine     | Machine config, transition guards      |
| `QUEUE_*` / `DISPATCH_*` | Dispatch loop     | Infinite dispatch cycles               |
| `MEMORY_*`               | Runtime           | Unbounded state growth                 |
| `BUDGET_*`               | Performance       | Slow reducer or effect                 |

### Action type prefix tells you the feature

All actions are prefixed: `counter:increment`, `wallet:transfer`. The format is
`featureName:actionKey`. The prefix (before `:`) is the feature name. Use this
to find the relevant feature code.

---

## Correlation IDs

Every action dispatched through the framework gets a unique correlation ID
(8-char UUID). All errors produced during that action's lifecycle — reduce,
effects, cross-feature calls — share the same ID.

**In the console:**

```
│ Correlation: a1b2c3d4
```

**In log files:**

```
2026-03-23 14:22:35.123  ERROR  feature:orderer  placeOrder failed  code=REDUCE_ERROR cid=a1b2c3d4
2026-03-23 14:22:35.124  ERROR  feature:orderer  effect failed  code=EFFECT_ASYNC_ERROR cid=a1b2c3d4
```

**Grep by correlation ID to see the full chain:**

```bash
grep 'a1b2c3d4' log/error.log
```

This shows every error that happened as part of one user action — even if it
cascaded through multiple features.

---

## onError hook

Every error in AIO — reducers, effects, flows, hooks, init/destroy, memory
pressure, budget violations — routes through the `onError` callback:

```ts
await aio.run({
  features: [counter, wallet],
  onError(err) {
    // err is an AioError instance
    console.log(err.code); // 'REDUCE_ERROR'
    console.log(err.source); // 'reduce'
    console.log(err.context.featureName); // 'orderer'
    console.log(err.context.actionType); // 'orderer:placeOrder'
    console.log(err.original?.stack); // full original stack trace
    console.log(err.correlationId); // 'a1b2c3d4'
    console.log(err.stateSnapshot); // state at moment of error

    // Send to your monitoring
    sentry.captureException(err);
    metrics.increment(`aio.error.${err.code}`);
  },
});
```

**What changed:** Previously, only reducer and effect errors hit `onError`. Now
**everything** does — flows, hooks, lifecycle errors, memory warnings, and
budget violations.

### AioError fields

| Field           | Type                 | Description                                                                                                     |
| --------------- | -------------------- | --------------------------------------------------------------------------------------------------------------- |
| `code`          | `AioErrorCode`       | Machine-readable error type (see table above)                                                                   |
| `source`        | `AioErrorSource`     | Layer: `'reduce'`, `'effect'`, `'flow'`, `'hook'`, `'init'`, `'destroy'`, `'memory'`, `'dispatch'`, `'machine'` |
| `message`       | `string`             | Human-readable error message                                                                                    |
| `context`       | `AioErrorContext`    | Structured metadata (feature, action, effect, flow, hook, duration, budget, machine state)                      |
| `original`      | `Error \| undefined` | The original thrown Error with preserved `.stack`                                                               |
| `correlationId` | `string`             | 8-char UUID tracing the action lifecycle                                                                        |
| `timestamp`     | `number`             | `Date.now()` at error creation                                                                                  |
| `stateSnapshot` | `unknown`            | Feature state at time of error (when available)                                                                 |

---

## Time-travel for state forensics

Press **Ctrl+.** to open the time-travel panel. Walk through every action and
state snapshot to find where things went wrong.

**Error entries are flagged** — entries where an error occurred show a red
marker in the timeline. Click to see the error detail and the state _before_ the
error.

**Workflow:**

1. Reproduce the bug
2. Open the TT panel (Ctrl+.)
3. Look for red-flagged entries — these are errors
4. Click to see state at that point + error details
5. Step backwards to find where state diverged from expected

The panel shows timing data per action — red highlights indicate actions that
exceeded their performance budget.

For programmatic access, use `useTimeTravel()` — see
[ui.md](ui.md#usetimetravel).

---

## Log files

AIO writes 5 plain text log files to `./log/` (configurable). Logging is enabled
by default — set `logging: false` to disable.

| File          | Content                                                     | When to use                      |
| ------------- | ----------------------------------------------------------- | -------------------------------- |
| `app.log`     | State changes, flow completions, errors (info + error only) | Operational overview             |
| `debug.log`   | All actions dispatched (unless suppressed)                  | Action-by-action replay          |
| `error.log`   | Errors only                                                 | Incident investigation, alerting |
| `warning.log` | Warnings — non-fatal issues                                 | Performance tuning               |
| `perf.log`    | Budget violations                                           | Finding hot spots                |

### Log format

```
2026-03-23 14:22:35.123  ERROR  feature:orderer  placeOrder failed  code=REDUCE_ERROR cid=a1b2c3d4
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
    backupLogs: true, // keep previous logs on restart (default: false — wipe on start)
    backupKeep: 7, // backup archives to keep (default: 7, 0 = unlimited)
  },
});
```

### Forensics workflow

After an incident:

1. Check `error.log` first — every error, never deduplicated
2. Find the correlation ID from the error
3. Grep `debug.log` for that correlation ID to see the full action chain
4. Check `perf.log` if the error might be performance-related
5. Check `app.log` for the broader narrative (state transitions, flow
   completions)

---

## Memory pressure monitor

AIO monitors heap usage and alerts before your app hits OOM. This is especially
critical for long-running apps (trading bots, servers).

### What you see

When heap crosses the warning threshold:

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
│ Tip: barHistory state is growing — consider pruning old
│      entries or using external storage.
└──────────────────────────────────────────────────────────────
```

### Configuration

```ts
await aio.run({
  memory: {
    enabled: true, // default: true
    interval: 10_000, // sampling every 10s (default)
    warnThreshold: 0.75, // warn at 75% heap (default)
    criticalThreshold: 0.90, // critical at 90% (default)
    onMemoryPressure(report) {
      // report.level: 'warn' | 'critical'
      // report.heapUsed, report.heapTotal, report.heapPct
      // report.featureStates: sorted by size, largest first
      // report.trend: 'rising' | 'stable' | 'falling'

      if (report.level === "critical") {
        // Emergency prune — keep last 1000 candles only
        barHistory.pruneOldEntries(1000);
      }
    },
  },
});
```

### How it works

- Samples `Deno.memoryUsage()` every `interval` ms (near-zero cost)
- Below threshold: does nothing
- At/above threshold: measures per-feature state sizes, reports which feature is
  largest and which field is growing
- Trend detection: 3 consecutive rising samples = `'rising'`
- Memory pressure errors also hit `onError` as `MEMORY_PRESSURE` /
  `MEMORY_CRITICAL`
- Not available in standalone/browser mode (no `Deno.memoryUsage` API)

### Worker isolates and V8 heap limits

`--v8-flags=--max-old-space-size=16384` only applies to the **main V8 isolate**.
Deno Workers (used by AIO's async SQLite layer) get their own isolate with the
**default ~1.7 GB heap limit**. `DENO_V8_FLAGS` does **not** propagate to Worker
isolates.

**Note:** Workers can often allocate beyond the reported `heapTotal` — V8 grows
the heap lazily, so `heapTotal` is not the actual limit. The memory monitor now
uses `heap_size_limit` from `node:v8` as the correct denominator.

**Key points:**

- This is a Deno/V8 limitation, not an AIO bug
- AIO's DB Worker (`async-db.ts`) runs in a Worker isolate — heavy SQLite
  workloads can hit the default limit
- Keep Worker-resident data small — push bulk computation results back to the
  main isolate
- The memory monitor runs in the main isolate and reports main-isolate stats
  only

---

## Feature health audit

After `aio.run()`, inspect feature health at runtime:

```ts
const app = await aio.run({ features: [counter, wallet] });

// Check all features
app.features!.health();
// → [
//   { name: 'counter', status: 'idle', enabled: true, errors: 0, lastAction: 'counter:increment', lastActionAt: 1234567890 },
//   { name: 'wallet', status: 'saving', enabled: true, errors: 0, lastAction: 'wallet:save', lastActionAt: 1234567891 },
// ]

// Check specific feature
app.features!.status("counter"); // → 'idle'

// List all registered features
app.features!.list(); // → ['counter', 'wallet']

// Disable a broken feature at runtime
app.features!.disable("wallet"); // dispatches wallet:__destroy, stops routing
```

The health endpoint is also available over HTTP: `GET /__aio/health` returns
JSON with per-feature status.

---

## Flow debugging

Generator flows now track every step. When a flow fails, the error shows the
full step history:

```
┌─ AIO ERROR ──────────────────────────────────────────────────
│ FLOW_UNCAUGHT in feature 'orderer'
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
│ Correlation: a1b2c3d4
│ Tip: Unhandled in flow — wrap the failing step in try/catch
│      inside your generator.
└──────────────────────────────────────────────────────────────
```

### Handling flow errors

Flow step errors are fed back into the generator via `gen.throw()`. You can
catch them:

```ts
generators: {
  *placeOrder(ctx, item: string) {
    yield* ctx.call('validate', () => validateOrder(item))
    try {
      yield* ctx.call('submit', () => submitToExchange(item))
    } catch (e) {
      // Handle exchange rejection gracefully
      yield* ctx.fail(`Exchange rejected: ${e.message}`)
    }
  },
}
```

If you **don't** catch, the error becomes `FLOW_UNCAUGHT` and routes through
`onError` with the full step history.

---

## Browser errors

### Build Error

A TypeScript/transpile failure caught by esbuild before the code runs. The
overlay shows the exact file, line, column:

```
⚠ Build Error

App.tsx:15:8
Unexpected token ")"

 15 |   return (<div onClick={handleClick)}>
                                         ^
```

Fix the syntax error in your editor and save — live reload picks it up
automatically.

### Runtime Error

A JavaScript crash after successful transpilation — wrong import name, `null.x`,
a React render exception:

```
⚠ Runtime Error

TypeError: Cannot read properties of null (reading 'map')
  at App (App.tsx:23:18)
  at renderWithHooks (react-dom.development.js:...)
```

The error is also POSTed to `/__aio/client-error` and written to `debug.log`,
which is useful in Electron where DevTools isn't open by default.

---

## Performance debugging

Performance budget violations produce `BUDGET_REDUCE` or `BUDGET_EFFECT` errors
(warn-level). Check `log/perf.log` first — it records every violation, deduped
per action type.

### Slow reducer

```
┌─ AIO WARNING ────────────────────────────────────────────────
│ BUDGET_REDUCE in feature 'counter'
│ Action: counter:analyze
│ Duration: 250.0ms (budget: 100ms)
│
│ reduce exceeded budget: 250.0ms > 100ms
│
│ Tip: Possible infinite loop — check if reduce dispatches
│      to itself.
└──────────────────────────────────────────────────────────────
```

The reducer is synchronous and blocks the dispatch loop. Move heavy computation
to an effect:

```ts
// Bad — blocks for 250ms
methods: {
  analyze(s) {
    s.results = heavyComputation(s.data)  // slow!
  },
}

// Good — reducer sets flag, execute does work async
reduce: { analyze(state) { state.analyzing = true } },
execute: {
  async runAnalysis(app, payload) {
    const results = await heavyComputation(payload.data)
    app.dispatch(myFeature.analysisDone(results))
  },
},
```

### Slow effect (sync portion)

The _synchronous_ part of your effect is too slow. Return immediately and do
work asynchronously:

```ts
// Bad — blocking file read
execute: {
  load(app) {
    const data = JSON.parse(Deno.readTextFileSync('big.json'))
    app.dispatch(myFeature.done(data))
  },
}

// Good — async
execute: {
  load(app) {
    Deno.readTextFile('big.json')
      .then(text => app.dispatch(myFeature.done(JSON.parse(text))))
  },
}
```

### Configure budgets

```ts
await aio.run({
  features: [counter],
  perfCheck: "on", // 'on' = warn on violations (default), 'off' = disable
  perfBudget: { reduce: 50, effect: 10 }, // ms
});
```

See [scaling.md](scaling.md#performance-budgets) for the full reference.

---

## Common error patterns

### Machine-dropped actions

```
┌─ AIO WARNING ────────────────────────────────────────────────
│ MACHINE_BLOCKED in feature 'counter'
│ Action: counter:save
│ Machine state: error
│
│ 'save' blocked — machine is in 'error' state (allowed: retry, dismiss)
│
│ Tip: Machine was in 'error' — check if this action should
│      be guarded to a different state.
└──────────────────────────────────────────────────────────────
```

Either:

1. The UI dispatched the wrong action for the current state
2. The machine definition is missing a transition
3. A race condition dispatched an action after a state transition

### "state._status is reserved"

The `_status` key is auto-managed by the machine system. Rename your field
(e.g., `_status` → `currentStatus`).

### "already bound"

You passed the same feature instance to `aio.run()` twice, or called `aio.run()`
twice without creating new feature instances.

### "dispatch blocked" (cross-feature)

An executor tried to dispatch to another feature's actions. **In dev mode this
throws.** In prod it logs and drops the action.

Fix: add the target feature to `dispatchTo`:

```ts
const engine = feature("engine", {
  dispatchTo: [wallet],
  // ...
});
```

### "machine initial state not found"

The `initial` value in your machine config doesn't match any key in `states`.
Check for typos.

---

## Startup linter output

The linter runs automatically on `aio.run()` and reports issues:

```
[aio] ✓ state (3 keys) ✓ reduce ✓ execute ✓ App.tsx
      ⚠ state has reserved key(s): $p — rename (used internally for delta patches)
      ℹ App.tsx has `import React` — not needed, JSX transforms are automatic
```

Categories: `✓` ok, `⚠` warning, `ℹ` hint, `✗` fatal. Fatal issues prevent
startup.

---

## Production failure scenarios

What actually happens when things go wrong at runtime.

### DB Worker crashes mid-transaction

The Worker-backed SQLite runs in a separate thread. If it crashes (OOM, Deno
bug, corrupted WAL):

- **Callback transactions** (`db.transaction(fn)`): the Promise rejects. The
  write lock is released. State in memory is unaffected.
- **Batch transactions** (`db.transaction([stmts])`): atomic failure, nothing
  committed.
- **Auto-persist (Deno.Kv)**: fire-and-forget with error logging. A failed write
  means state restores from the last successful write on next restart.

**Recovery:** restart the process. SQLite WAL recovery handles partial writes
automatically.

### WebSocket drops during a generator step

Generators run server-side — a client disconnect doesn't affect them. The flow
continues, state updates accumulate, and the client gets the latest state on
reconnect via full-state sync.

If the _server_ crashes mid-generator: the generator is lost (in-memory). On
restart, features reinitialize to persisted state. Design generators to be
resumable — check state in `onInit` and re-trigger if needed.

### Electron process killed during state flush

Deno.Kv is crash-safe (SQLite internally). A kill during write either commits
fully or not at all. SQLite WAL mode has the same guarantees.

### `deno compile` binary can't find assets

Compiled binaries embed `dist/app.js` and `dist/style.css` at build time. If the
build step didn't run first, the binary serves empty responses.

**Fix:** always run the build task before compilation.

### Server restart while clients are connected

Each server start generates a boot ID sent to clients. If a client reconnects
and sees a different boot ID, it triggers a page reload to pick up fresh code.
Automatic.

### Generator waitFor hangs forever

A `ctx.waitFor(action)` with no timeout waits indefinitely. In dev mode, a
warning fires after 30 seconds. Check `am health` — the flow shows as active.

**Fix:** always pass a timeout: `ctx.waitFor(action, 30_000)`.

### Offline queue overflow

The offline queue (IndexedDB) caps at 100 actions. Beyond that, actions are
silently dropped. Intentional — stale actions from hours-offline shouldn't
replay.

### Feature error accumulation

Effect errors increment a per-feature counter visible via `health()`. The
feature keeps running — errors don't auto-disable. Use `onError` or periodic
health checks to detect high error counts and take action.

### Memory growth in long-running apps

Common causes:

- **Unbounded state arrays**: the memory monitor catches this — look for
  `MEMORY_PRESSURE` errors with per-feature sizing
- **Time-travel history**: capped at 200 entries (dev mode only, zero in prod)
- **Action listeners (`waitFor`)**: cleaned up on flow completion or
  cancellation. A stuck generator leaks one listener — the 30s dev warning
  catches this
- **WebSocket client state**: each connected client holds a delta cache.
  Disconnected clients are cleaned up on close. Check `am status` for connection
  count
