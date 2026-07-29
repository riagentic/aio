# Troubleshooting

## Symptom → cause → where it's caught

Every failure class aio has actually hit in the field, and the guard that now
catches it **before you debug**:

| Symptom                             | Usual cause                                             | Caught by                                                                      |
| ----------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Blank white page (dev)**          | failed import / no default export / mount error         | diagnostic overlay + `BLANK SCREEN` warning — render errors name the component |
| Feature dead, tests green           | cell imported by UI but missing from `cells[]`          | loud "dispatch to unregistered cell" warning (once per cell)                   |
| Page stuck on "Loading…"            | state never arrives (WS blocked, auth, server error)    | 10s watchdog → overlay says "waiting for state"; check `am clients`            |
| Broken import in App.tsx            | typo'd path, server-only import in client code          | dev graph validator serves a Module Errors page instead of the app             |
| Deno/`@std/*` leaks into the bundle | plain import of a server helper from a cell file        | `aiol` lint + `*.server.ts` convention (docs/build/imports.md)                 |
| App boots then dies on config       | typo'd `aio.run` key                                    | `validateConfig` exits with the full key table (allowlists are gate-tested)    |
| Works in dev, blank when compiled   | bundling drift (ESM vs IIFE, module paths)              | bundle-smoke CI gate builds both shapes and asserts the invariants             |
| Server dies when a client connects  | Deno version behavior change (headers after WS upgrade) | covered by every WS test incl. real-chromium e2e                               |
| App won't start / "already running" | stale lock from a crashed process                       | lock liveness (pid + port) self-heals; `am status` shows the holder            |
| Doc example throws on paste         | docs drifted from the API                               | doc-imports gate: every `aio` import in docs must exist in the API snapshot    |
| Secret visible in a client          | `ui: "all"` default on a sensitive cell                 | boot warnings (secret-looking fields, filter typos); deep-path `exclude`       |
| Tests flake across files            | shared persisted state                                  | `testUI` is hermetic by default (persist off, unique key)                      |
| `deno.json` mystery failures        | missing jsx / nodeModulesDir lines                      | `deno task doctor`                                                             |

If a symptom you hit isn't here, that's a bug in this table — report it.

Symptom-based guide -- find what you're seeing, follow the fix path.

## Quick decision tree

```
Something wrong?
|
+-- Error box in console?      -> S1 Error Codes
+-- UI frozen / blank?         -> S2 Freezes
+-- Data stale / not updating? -> S3 Stale Data
+-- App slow but not frozen?   -> S4 Slow Actions
+-- Memory warning?            -> S5 Memory
+-- WebSocket disconnecting?   -> S6 Connection
+-- Re-renders too frequent?   -> S7 Re-renders
+-- Cell stopped working?   -> S8 Circuit Breaker
+-- "PRESSURE" warning?        -> S10 Pressure Warnings
+-- Nothing obvious?           -> S9 Silent Failures
```

---

## S1 -- Error box in console

| Code                 | What broke                                                                    | Fix                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `REDUCE_ERROR`       | Reducer threw                                                                 | Check payload shape, guard undefined fields                                                          |
| `EFFECT_ERROR`       | Sync effect threw                                                             | Move I/O to async, return promises                                                                   |
| `EFFECT_TIMEOUT`     | Async method still running at the ceiling (default 30s) — it is NOT cancelled | Raise `effectTimeoutMs` / `perfBudget.methods[...].timeout`, or move the long work off the call path |
| `EFFECT_ASYNC_ERROR` | Promise rejected                                                              | Add error handling in `execute`                                                                      |
| `FLOW_STEP_ERROR`    | Workflow step threw (legacy)                                                  | Wrap steps in try/catch                                                                              |
| `FLOW_UNCAUGHT`      | Flow threw without catch                                                      | Add try/catch, check step history in error                                                           |
| `MACHINE_BLOCKED`    | Action blocked by routing guard                                               | Check the cell's `status` field and guards                                                           |
| `QUEUE_OVERFLOW`     | Queue exceeded 10,000                                                         | Find dispatch loop -- see S4                                                                         |
| `DISPATCH_LOOP`      | 1000+ iterations detected                                                     | Effect dispatching to itself -- break cycle                                                          |
| `MEMORY_PRESSURE`    | Heap above 75%                                                                | See S5                                                                                               |
| `MEMORY_CRITICAL`    | Heap above 90%                                                                | See S5 (urgent)                                                                                      |
| `BUDGET_REDUCE`      | Reducer exceeded 100ms                                                        | Move heavy work to async effects                                                                     |
| `BUDGET_EFFECT`      | Effect exceeded 5ms                                                           | Return immediately, work async                                                                       |

**Tracing:** Every error has a correlation ID. Grep logs:

```bash
grep 'a1b2c3d4' ~/.<appId>/logs/error.log   # all errors in this dispatch
grep 'a1b2c3d4' ~/.<appId>/logs/debug.log   # full action chain
```

---

## S2 -- UI frozen / blank

**Console output:**

```
[aio:vitals] RENDER FROZEN -- no update for 3.2s
  trigger:    portfolio.refresh reduce took 1847ms (p95: 45ms)
  hint:       slow reducer blocking main thread
```

### Reducer blocking main thread

DiagReporter shows `trigger: <cell>.<action> reduce took Xms`.

```ts
// WRONG -- heavy sync work in a sync method
methods: { analyze(s) { s.results = heavyComputation(s.data) } }

// RIGHT -- async method: flag, then work off the sync path
methods: {
  async analyze(s) {
    s.analyzing = true
    s.results = await heavyComputationAsync(s.data)
    s.analyzing = false
  },
}
```

### Queue saturation

DiagReporter shows `queue: N actions pending, drain rate X/s`.

```ts
// WRONG -- rapid-fire dispatches
for (const item of items) app.dispatch(cell.process(item));

// RIGHT -- batch
app.dispatch(cell.processBatch(items));
```

### Non-AIO code blocking

DiagReporter shows `hint: Main thread blocked by non-AIO code`. Check:
third-party libraries, large DOM operations, synchronous I/O, heavy
`JSON.parse`.

### Blank page on load

UI mount racing against state arrival. Ensure you're using `aio.run()` and not
mounting manually before state arrives.

---

## S3 -- Stale data

UI shows old values. Data arrived on server but browser didn't update.

**Checklist:**

1. **WebSocket connected?** DevTools Network WS tab. If disconnected, see S6.
2. **Transport probe?** Look for `[aio:vitals] transport degraded`. High RTT =
   network latency.
3. **Delta issue?** If state changed but delta was `skip`, check
   `fullStateThreshold`.
4. **Reducer not mutating?** Verify with `[state-diff]` entries in
   `~/.<appId>/logs/debug.log`. No diff = no change.
5. **Reference issue?** Use direct cell access for scoped updates if component
   depends on parent object reference.
6. **Visibility?** Check the `cells: <name> ui=… persist=…` line printed at
   startup — is the field you expect actually exposed? See
   [cell-visibility](../state/cell-visibility.md).

---

## S4 -- Slow actions

App works but feels sluggish. Check `~/.<appId>/logs/perf.log`:

```
[BUDGET] wallet:transfer 450ms > 100ms budget
  produce: 420ms  clone: 15ms  spread: 5ms  routing: 2ms  listeners: 8ms
```

| Phase       | If slow                       |
| ----------- | ----------------------------- |
| `produce`   | Move computation to effect    |
| `clone`     | Large state -- prune          |
| `spread`    | Too many cells?               |
| `routing`   | Shouldn't be slow             |
| `listeners` | Too many cross-cell listeners |

HTTP check: `GET /__aio/vitals` returns live `queueDepth`, `drainRate`,
`lastReduceTime`, `p95ReduceTime`.

---

## S5 -- Memory pressure

```
MEMORY_PRESSURE -- heap at 78% (1.56 GB / 2.0 GB)
Top cells: 1. barHistory 847 MB  2. orderer 12 MB
```

| Trend     | Meaning                      | Fix                                        |
| --------- | ---------------------------- | ------------------------------------------ |
| `rising`  | Unbounded growth -- will OOM | Cap arrays, use ring buffers               |
| `stable`  | High but not growing         | Increase limit or move to external storage |
| `falling` | GC recovering                | Usually fine, monitor                      |

**Cap array growth:**

```ts
methods: {
  addCandle(s, candle: Candle) {
    s.candles.push(candle)
    if (s.candles.length > 10_000) s.candles = s.candles.slice(-10_000)
  }
}
```

For large datasets, move to SQLite. Increase V8 heap:
`deno run --v8-flags=--max-old-space-size=16384 main.ts`.

---

## S6 -- Connection issues

```
[aio:vitals] transport frozen (no pong in 3.2s)
[aio:vitals] DISCONNECT -- client abc123 unreachable for 5.1s
```

1. **Network issue?** Transport frozen but Loop/Render healthy = network
   problem. AIO auto-reconnects.
2. **Server overloaded?** LoopProbe also degraded = server can't process pings.
   Check queue depth.
3. **Client frozen?** RenderProbe also frozen = browser can't send pings. See
   S2.
4. **Connection indicator:** Browser colored dot bottom-left. Red =
   disconnected, yellow = reconnecting, green = connected.

---

## S7 -- Too many re-renders

```
[aio:vitals] RE-RENDER STORM -- 47 subscribe callbacks in last 1s
```

`useAio()` auto-tracks accessed paths via deep Proxy -- subscribes only to what
you read. If you still see storms, the issue is expensive components:

```ts
// FINE -- useAio() only subscribes to accessed paths
const { state, send } = useAio();
return <div>{state.counter.count}</div>;

// BETTER for hot components -- direct cell access scopes to one cell
return <div>{counter.count}</div>;
```

---

## S8 -- Cell stopped working

Circuit breaker may have tripped. Check: `curl localhost:3000/__aio/health`.
Look for `"enabled": false` or high error counts.

```ts
circuitBreaker: {
  maxErrors: 10,
  window: 60_000,  // rolling 60s
  onTrip: (name, count) => console.error(`${name} tripped: ${count} errors`),
}
```

Re-enable: fix root cause, restart app.

---

## S9 -- Silent failures

**Health overlay:** Bottom-right corner (dev mode). Green/yellow/red. Click to
expand diagnostic bus events.

**Check log files:**

| File                          | Look for                               |
| ----------------------------- | -------------------------------------- |
| `~/.<appId>/logs/error.log`   | Errors missed in console               |
| `~/.<appId>/logs/warning.log` | Stripped keys, dropped actions         |
| `~/.<appId>/logs/debug.log`   | Full action trace, unexpected patterns |
| `~/.<appId>/logs/perf.log`    | Budget violations                      |

**Common silent issues:**

| Diagnostic event     | Fix                             |
| -------------------- | ------------------------------- |
| `action-dropped`     | Debounce dispatches             |
| `state-key-stripped` | Rename field (avoid `$p`, `$v`) |
| `state-no-listeners` | Read cell state in a component  |
| `effect-invalid`     | Add `type: "effectName"`        |
| `persist-error`      | Check permissions, disk space   |

---

## S10 -- Pressure warnings

Early warnings before failure. Fire when resources approach limits.

**Payload pressure:** `PRESSURE -- broadcast payload 623KB`. Fix: reduce state
size, prune arrays, raise `pressure.payloadThreshold`.

**Rate pressure:** `PRESSURE -- 34 broadcasts/sec`. Fix: debounce dispatches,
batch actions, raise `pressure.rateThreshold`.

**Render pressure:** `PRESSURE -- render degraded (82ms drift)`. Fix: check
heavy sync work. See S2 if it escalates.

```ts
diagnostics: {
  dev: {
    vitals: {
      pressure: { payloadThreshold: 1_000_000, rateThreshold: 60 },
    },
  },
}
```

---

## Forensics workflow

1. `~/.<appId>/logs/error.log` -- find the first error
2. Grep `~/.<appId>/logs/debug.log` for the `cid` -- full action chain
3. `~/.<appId>/logs/perf.log` -- budget violations around the same time
4. `~/.<appId>/logs/actions.jsonl` -- replay the action sequence
5. `~/.<appId>/logs/checkpoint.json` -- state snapshot at last checkpoint
6. Time-travel (Ctrl+.) -- step through actions visually

## Useful commands

```bash
curl localhost:3000/__aio/vitals | jq .     # live vitals
curl localhost:3000/__aio/health | jq .     # cell health
grep 'a1b2c3d4' ~/.<appId>/logs/debug.log              # trace by correlation ID
tail -f ~/.<appId>/logs/perf.log                        # watch budget violations
grep -c 'cell:wallet' ~/.<appId>/logs/error.log      # count errors per cell
```
