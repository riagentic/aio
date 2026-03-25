# Troubleshooting

Symptom-based guide — find what you're seeing, follow the fix path. For
reference docs, see [diagnostics.md](diagnostics.md),
[debugging.md](debugging.md), and [vitals.md](vitals.md).

---

## Quick Decision Tree

```
Something wrong?
│
├─ Error box in console?     → §1 Error Codes
├─ UI frozen / blank?        → §2 Freezes
├─ Data stale / not updating? → §3 Stale Data
├─ App slow but not frozen?  → §4 Slow Actions
├─ Memory warning?           → §5 Memory
├─ WebSocket disconnecting?  → §6 Connection
├─ Re-renders too frequent?  → §7 Re-renders
├─ Feature stopped working?  → §8 Circuit Breaker
├─ "PRESSURE" warning?       → §10 Pressure Warnings
└─ Nothing obvious?          → §9 Silent Failures
```

---

## §1 — Error Box in Console

AIO errors appear as structured boxes in dev, one-liners in prod:

```
┌─ AIO ERROR ──────────────────────────────────
│ REDUCE_ERROR in feature 'orderer'
│ Action: orderer:placeOrder
│ Cannot read property 'price' of undefined
│ Tip: Check if the action payload has the expected shape.
│ Correlation: a1b2c3d4
└──────────────────────────────────────────────
```

**By error code:**

| Code                 | What broke                      | Fix                                         |
| -------------------- | ------------------------------- | ------------------------------------------- |
| `REDUCE_ERROR`       | Reducer threw                   | Check payload shape, guard undefined fields |
| `EFFECT_ERROR`       | Sync effect threw               | Move I/O to async, return promises          |
| `EFFECT_TIMEOUT`     | Async effect exceeded 30s       | Optimize or increase `effectTimeoutMs`      |
| `EFFECT_ASYNC_ERROR` | Promise rejected                | Add error handling in `execute`             |
| `FLOW_STEP_ERROR`    | Flow generator step threw       | Wrap steps in try/catch                     |
| `FLOW_UNCAUGHT`      | Flow threw without catch        | Add try/catch, check step history in error  |
| `MACHINE_BLOCKED`    | Action blocked by state machine | Check transitions, verify machine state     |
| `QUEUE_OVERFLOW`     | Queue exceeded 10,000           | Find dispatch loop — see §4                 |
| `DISPATCH_LOOP`      | 1000+ iterations detected       | Effect dispatching to itself — break cycle  |
| `MEMORY_PRESSURE`    | Heap above 75%                  | See §5                                      |
| `MEMORY_CRITICAL`    | Heap above 90%                  | See §5 (urgent)                             |
| `BUDGET_REDUCE`      | Reducer exceeded 100ms          | Move heavy work to async effects            |
| `BUDGET_EFFECT`      | Effect exceeded 5ms             | Return immediately, work async              |

**Tracing the full chain:** Every error has a correlation ID (`cid`). Grep logs:

```bash
grep 'a1b2c3d4' log/error.log   # all errors in this dispatch
grep 'a1b2c3d4' log/debug.log   # full action chain
```

---

## §2 — UI Frozen / Blank

**What you'll see in console (DiagReporter):**

```
[aio:vitals] RENDER FROZEN — no update for 3.2s
  trigger:    portfolio.refresh reduce took 1847ms (p95: 45ms)
  queue:      12 actions pending, drain rate 2.1/s
  transport:  healthy (RTT 23ms)
  hint:       slow reducer blocking main thread — consider async
```

**By root cause:**

### Reducer blocking main thread

DiagReporter shows `trigger: <feature>.<action> reduce took Xms`.

```ts
// WRONG — heavy work in reducer
reduce: { analyze(s) { s.results = heavyComputation(s.data) } }

// RIGHT — move to async effect
reduce: { analyze(s) { s.analyzing = true } },
execute: {
  async runAnalysis(app, payload) {
    const results = await heavyComputation(payload.data)
    app.dispatch(myFeature.analysisDone(results))
  }
}
```

### Queue saturation

DiagReporter shows `queue: N actions pending, drain rate X/s`.

```ts
// WRONG — rapid-fire dispatches
for (const item of items) app.dispatch(feature.process(item));

// RIGHT — batch
app.dispatch(feature.processBatch(items));
```

### Non-AIO code blocking

DiagReporter shows `hint: Main thread blocked by non-AIO code`. No AIO action
correlated with the freeze.

Check: third-party libraries, large DOM operations, synchronous I/O, heavy
`JSON.parse` calls.

### Blank page on load

If the page is blank with no errors, the React mount may be racing against state
arrival. AIO handles this automatically — if you see it, check that you're using
`aio.run()` and not mounting React manually before state arrives.

---

## §3 — Stale Data

UI shows old values. Data arrived on server but browser didn't update.

**What you'll see:**

```
[aio:vitals] STALE — client abc123 missed 3 broadcasts
  last sent:  2.4s ago
  skip count: 3
  hint:       check client connection
```

**Checklist:**

1. **WebSocket connected?** Check browser DevTools → Network → WS tab. Green =
   connected. If disconnected, see §6.

2. **Transport probe status?** Look for `[aio:vitals] transport degraded` in
   browser console. High RTT means network latency — data arrives late.

3. **Delta compression issue?** If state changed but delta was `skip` (no
   changed keys), the full-state threshold may be too high. Check
   `fullStateThreshold` in config.

4. **Reducer not mutating?** If your reducer returns without changing state, no
   broadcast fires. Verify with state diffs in `log/debug.log`:
   ```
   [state-diff] counter: count 5→10
   ```
   No diff entry = reducer didn't change state.

5. **`_applyPatch` reference issue?** Shallow-equal comparison preserves
   references for unchanged keys. If your component depends on a parent object
   reference changing, use `useFeature(ref)` with a specific selector.

---

## §4 — Slow Actions

App works but feels sluggish. No freeze, just lag.

**What you'll see:**

```
[aio:vitals] SLOW DISPATCH — wallet:transfer took 450ms (p95: 12ms)
  trigger:    wallet:transfer reduce took 450ms
  queue:      0 actions pending
  hint:       slow reducer — optimize or split into smaller actions
```

**Also check `log/perf.log`:**

```
[BUDGET] wallet:transfer 450ms > 100ms budget
  produce: 420ms  clone: 15ms  spread: 5ms  routing: 2ms  listeners: 8ms
```

The phase breakdown tells you where time is spent:

| Phase       | What it is                              | If slow                          |
| ----------- | --------------------------------------- | -------------------------------- |
| `produce`   | Your reducer function (Immer)           | Move computation to effect       |
| `clone`     | `structuredClone` for effect detachment | Large state — prune              |
| `spread`    | State object construction               | Too many features?               |
| `routing`   | Owner feature lookup                    | Normal, shouldn't be slow        |
| `listeners` | Foreign action listener fan-out         | Too many cross-feature listeners |

**HTTP check:** `GET /__aio/vitals` returns live metrics:

```json
{
  "server": {
    "loop": {
      "queueDepth": 0,
      "drainRate": 12.5,
      "lastReduceTime": 3.2,
      "p95ReduceTime": 8.1
    }
  }
}
```

---

## §5 — Memory Pressure

**What you'll see:**

```
┌─ AIO WARNING ────────────────────────────────
│ MEMORY_PRESSURE — heap at 78% (1.56 GB / 2.0 GB)
│
│ Top features by state size:
│   1. barHistory — 847 MB (state.candles: 1,240,000 entries)
│   2. orderer   — 12 MB
│
│ Tip: barHistory state is growing — consider pruning.
└──────────────────────────────────────────────
```

**By trend:**

| Trend     | Meaning                     | Fix                                        |
| --------- | --------------------------- | ------------------------------------------ |
| `rising`  | Unbounded growth — will OOM | Cap arrays, use ring buffers               |
| `stable`  | High but not growing        | Increase limit or move to external storage |
| `falling` | GC recovering               | Usually fine, monitor                      |

**Common fix — cap array growth:**

```ts
reduce: {
  addCandle(s, payload) {
    s.candles.push(payload.candle)
    if (s.candles.length > 10_000) s.candles = s.candles.slice(-10_000)
  }
}
```

**For large datasets:** Move to SQLite (`sqldb` feature) instead of keeping
everything in state.

**Increase V8 heap limit:**

```bash
deno run --v8-flags=--max-old-space-size=16384 main.ts
```

---

## §6 — Connection Issues

**WebSocket disconnecting repeatedly:**

```
[aio:vitals] transport frozen (no pong in 3.2s)
[aio:vitals] DISCONNECT — client abc123 unreachable for 5.1s
```

**Checklist:**

1. **Network issue?** TransportProbe shows frozen but LoopProbe and RenderProbe
   are healthy → network problem, not app problem. AIO auto-reconnects.

2. **Server overloaded?** If LoopProbe is also degraded, the server can't
   process pings fast enough. Check queue depth and reduce times.

3. **Client frozen?** If RenderProbe is also frozen, the browser can't send
   pings. See §2.

4. **Connection indicator:** Browser shows a colored dot (bottom-left). Red =
   disconnected, yellow = reconnecting, green = connected.

---

## §7 — Too Many Re-renders

**What you'll see:**

```
[aio:vitals] RE-RENDER STORM — 47 subscribe callbacks in last 1s
  useAio() detected:  yes (full-state subscription active)
  hint:               switch from useAio() to useFeature(ref)
```

**Root causes:**

### Using `useAio()` instead of `useFeature(ref)`

`useAio()` subscribes to the entire state tree — re-renders on every change from
any feature. Use `useFeature(ref)` for scoped subscriptions:

```ts
// WRONG — re-renders on every state change
const { state } = useAio();

// RIGHT — re-renders only when this feature's state changes
const { state, send } = useFeature(counterRef);
```

### Selector returning new object every time

If your selector creates a new object on every call, React sees it as changed:

```ts
// WRONG — new object every render
useFeature(ref, (s) => ({ a: s.a, b: s.b }));

// RIGHT — return stable value (or use separate hooks)
const a = useFeature(ref, (s) => s.a);
const b = useFeature(ref, (s) => s.b);
```

**`useAio()` warning:** In dev mode, a one-time warning fires per call site.
Active instances are ref-counted — accurately reports whether `useAio()` is
still mounted.

---

## §8 — Feature Stopped Working

If a feature stops responding to actions, the circuit breaker may have tripped.

**Check feature health:**

```bash
curl localhost:3000/__aio/health
```

Look for `"enabled": false` or high error counts.

**Circuit breaker config:**

```ts
circuitBreaker: {
  maxErrors: 10,
  window: 60_000,  // rolling 60s — errors older than this don't count
  onTrip: (name, count) => console.error(`${name} tripped: ${count} errors`),
}
```

**To re-enable:** Fix the root cause, then restart the app. Circuit breaker
resets on restart.

---

## §9 — Silent Failures

Nothing obvious in console but something is off.

**Check the health overlay:** Bottom-right corner of browser (dev mode). Green =
healthy, yellow = warnings, red = errors. Click to expand and see recent
diagnostic bus events.

**Check log files:**

| File              | What to look for                             |
| ----------------- | -------------------------------------------- |
| `log/error.log`   | Any errors you missed in console             |
| `log/warning.log` | Warnings (stripped keys, dropped actions)    |
| `log/debug.log`   | Full action trace — find unexpected patterns |
| `log/perf.log`    | Budget violations you didn't notice          |

**Check vitals endpoint:**

```bash
curl localhost:3000/__aio/vitals
```

Returns queue depth, client liveness, payload sizes, and per-feature state sizes
(UTF-8 bytes). Large feature sizes may indicate bloated state.

**Common silent issues:**

| Diagnostic bus event | Meaning                         | Fix                             |
| -------------------- | ------------------------------- | ------------------------------- |
| `action-dropped`     | Queue full, action lost         | Debounce dispatches             |
| `state-key-stripped` | Reserved key name removed       | Rename field (avoid `$p`, `$v`) |
| `state-no-listeners` | State updated, nobody listening | Add `useFeature()` in component |
| `effect-invalid`     | Effect missing `.type`          | Add `type: "effectName"`        |
| `persist-error`      | Disk write failed               | Check permissions, disk space   |

---

## §10 — Pressure Warnings

Early warnings before things break. These fire when resources approach limits
but haven't failed yet.

**Payload pressure (server console):**

```
[aio:vitals] PRESSURE — broadcast payload 623KB to client abc12345
  payload:    623.0KB
  hint:       large state delta — check feature sizes at /__aio/vitals
```

Fix: Reduce feature state size, prune large arrays, or raise
`pressure.payloadThreshold`. Check `/__aio/vitals` for per-feature sizes.

**Rate pressure (server console):**

```
[aio:vitals] PRESSURE — 34 broadcasts/sec (threshold: 30/sec)
  hint:       high dispatch frequency — debounce or batch actions
```

Fix: Debounce rapid dispatches, batch related actions. Real-time apps: raise
`pressure.rateThreshold` or set `pressure: false`.

**Render pressure (browser console):**

```
[aio:vitals] PRESSURE — render degraded (82ms drift)
  hint:       main thread under load — may freeze if sustained
```

Fix: Check for heavy synchronous work. See §2 if it escalates to frozen.

**Configuration:**

```ts
diagnostics: {
  dev: {
    vitals: {
      pressure: {
        payloadThreshold: 1_000_000,  // 1MB
        rateThreshold: 60,            // 60/sec
      },
    },
  },
}
```

---

## Forensics Workflow

When investigating after the fact:

1. **`log/error.log`** — Start here. Find the first error.
2. **Correlation ID** — Grep `log/debug.log` for the `cid` to see the full
   action chain.
3. **`log/perf.log`** — Check for budget violations around the same time.
4. **`log/actions.jsonl`** — Replay the action sequence.
5. **`log/checkpoint.json`** — State snapshot at last checkpoint.
6. **Time-travel (Ctrl+.)** — If reproducible, step through actions visually.

---

## Useful Commands

```bash
# Live vitals
curl localhost:3000/__aio/vitals | jq .

# Feature health
curl localhost:3000/__aio/health | jq .

# Find errors by correlation ID
grep 'a1b2c3d4' log/debug.log

# Watch for budget violations
tail -f log/perf.log

# Count errors per feature
grep -c 'feature:wallet' log/error.log
```
