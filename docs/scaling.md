# Scaling

For the docs index, see [manual.md](manual.md). For persistence details, see [persistence.md](persistence.md).

aio runs as a single Deno process with SQLite and WebSocket broadcast. That sounds limiting, but with the right approach it handles far more than you'd expect.

## Architecture at scale

```
Client → WebSocket → aio server (single process)
                        ├── state (in-memory, small)
                        ├── SQLite (on disk, WAL mode, fast)
                        └── Deno.Kv (UI scalars only)
```

A single modern server can handle thousands of concurrent WebSocket connections. SQLite in WAL mode does 100k+ reads/sec on NVMe. The framework already has delta patching (only changed keys are sent) and per-user filtering (`stateForUI`). The question isn't whether aio can scale — it's whether your app design lets it.

## What limits scale

| Bottleneck | Cause | Ceiling |
|------------|-------|---------|
| In-memory state | Everything in state = everything in RAM | Depends on state size |
| Broadcast storm | Every action triggers broadcast to all clients | ~1000s of clients |
| SQLite writes | Single-writer (WAL allows concurrent reads) | ~10k writes/sec |
| Single process | One machine, one CPU core for dispatch | One machine's worth |

## Practices for maximum scale

**1. Keep state small — query on demand**

The #1 mistake: putting large datasets in state. State should hold what's *active*, not what *exists*.

```ts
// Bad — 100k orders in memory, broadcast to every client
type State = { orders: Order[] }

// Good — state holds current view, SQLite holds everything
type State = { page: string; currentOrders: Order[]; filters: Filters }

// In an execute handler: query only what's needed
execute: {
  async loadOrders(app, payload) {
    const { rows } = await app.db!.query<Order>(
      'SELECT * FROM orders WHERE status = ? AND total > ? ORDER BY created_at DESC LIMIT 100',
      ['active', payload.minTotal]
    )
    app.dispatch(myFeature.A.ordersLoaded(rows))  // small, filtered result
  },
},
```

**2. Use `stateForUI` aggressively**

Filter what each user sees. Less data per client = less bandwidth = more clients.

```ts
stateForUI: (state, user?) => {
  // Admin sees everything, viewers see their own data
  if (user?.role === 'admin') return state
  return {
    page: state.page,
    orders: state.currentOrders.filter(o => o.userId === user?.id),
  }
}
```

**3. Use direct async SQL for heavy lifting**

Don't route large data operations through the reducer. Use `app.db` methods in effects — they write directly to SQLite without touching state or broadcast.

```ts
execute: {
  // Batch import: 10k rows directly to SQLite, no state churn
  async importCSV(app, payload) {
    for (const batch of chunks(payload.parsedRows, 500)) {
      const params = batch.flatMap(r => [r.id, r.customer, r.total])
      const placeholders = batch.map(() => '(?,?,?)').join(',')
      await app.db!.execute(`INSERT INTO orders(id,customer,total) VALUES ${placeholders}`, params)
    }
    app.dispatch(myFeature.A.importDone(payload.parsedRows.length))
  },

  // Aggregation: compute on SQLite, send result to state
  async dashboardStats(app) {
    const { rows } = await app.db!.query<{ total: number; count: number }>(
      'SELECT SUM(total) as total, COUNT(*) as count FROM orders WHERE status = ?',
      ['active']
    )
    app.dispatch(myFeature.A.statsLoaded(rows[0]))
  },
},
```

**4. Debounce high-frequency updates**

If your app processes rapid events (sensors, live data), batch them before dispatching.

```ts
execute: {
  // In execute handler: accumulate, then dispatch once
  async sensorBatch(app, payload) {
    const readings = collectReadings(payload.buffer)
    const params = readings.flatMap(r => [r.ts, r.value])
    const placeholders = readings.map(() => '(?,?)').join(',')
    await app.db!.execute(`INSERT INTO readings(ts,value) VALUES ${placeholders}`, params)
    app.dispatch(sensors.A.readingsUpdated(readings.length))  // one broadcast
  },
},
```

**5. Design state keys for delta efficiency**

Delta patching works per key — for v0.5 namespaced state (e.g. `{ counter: { count }, mdview: { html, scrollY } }`), the delta system automatically compares one level deeper, so changing `mdview.scrollY` only sends that sub-key, not the entire `mdview` slice including heavy fields like `html`.

For classic flat state, each top-level key is compared individually as before.

```ts
// Good: counter changes don't resend the orders list
type State = {
  counter: number       // changes often → small delta
  orders: Order[]       // changes rarely
  filters: Filters      // changes sometimes
}
```

## Realistic capacity

With careful design (small state, filtered UI, SQLite for bulk data):

- **Concurrent clients**: 1,000–5,000 per server (WebSocket + delta patching)
- **SQLite rows**: Millions (reads are fast, writes batched in transactions)
- **Actions/sec**: Hundreds (reducer is synchronous, keep it fast)
- **Data on disk**: Limited by disk space, not framework

This comfortably serves tens of thousands of daily users on a single $20/month VPS. For most tools, dashboards, and business apps — that's more than enough.

## What aio is not designed for

- Horizontal scaling across multiple machines (no shared state protocol)
- Public-facing websites needing SEO (no server-side rendering)
- Sub-millisecond latency requirements (WebSocket adds ~1-5ms)
- Truly stateless APIs (aio is stateful by design)

For these, use a purpose-built tool. aio excels at stateful, interactive applications where the server owns the truth and clients render it.

---

## Performance budgets

aio tracks how long your reducer and effects take, warning when operations exceed budget. This catches blocking work that makes the UI unresponsive.

### How it works

Every action is timed:
- **reduce budget** (default: 100ms) — if `reduce()` takes longer, it's flagged
- **effect budget** (default: 5ms) — if sync portion of `execute()` takes longer, it's flagged

Async effects (promises) return immediately — only the sync part is measured. If your effect does `fetch().then(...)`, the `fetch()` call takes microseconds, so it passes.

```ts
execute: {
  // ✅ GOOD — async, returns in < 1ms
  fetch(app, payload) {
    fetch(payload.url).then(r => app.dispatch(myFeature.A.loaded(r)))
  },

  // ❌ BAD — sync work blocks
  process(_app, payload) {
    const data = heavyComputation(payload)  // 500ms sync — blocks!
  },
},
```

### Modes

| Mode | Behavior |
|------|----------|
| `'strict'` (default) | Calls `onError({ source: 'performance', ... })` + logs error |
| `'soft'` | Only `console.warn()` — no callback |

### Custom budgets

```ts
await aio.run(state, {
  reduce, execute,
  perfMode: 'strict',           // or 'soft'
  perfBudget: {
    reduce: 50,   // warn if reduce > 50ms
    effect: 10,   // warn if sync effect > 10ms
  },
})
```

### Getting performance errors

Both modes apply the action — state changes normally. This keeps your app functional while surfacing issues.

```ts
await aio.run(state, {
  reduce, execute,
  onError: (err) => {
    if (err.source === 'performance') {
      console.error(`Slow ${err.actionType ?? err.effectType}: ${err.duration}ms > ${err.budget}ms`)
      // Show warning in UI, send to monitoring, etc.
    }
  },
})
```

### Best practices

1. **Keep reduce fast** — state updates should be instant. Move heavy computation to effects
2. **Effects should return immediately** — kick off async work, don't block
3. **Use `perfMode: 'soft'` in dev** — see warnings in console during development
4. **Use `perfMode: 'strict'` in prod** — log to monitoring via `onError`

### Example: Moving slow work out of reduce

```ts
// BAD — reduce handler blocks 200ms
reduce: {
  analyze(state) {
    state.results = analyzeEverything(state.data)  // blocks 200ms!
  },
},

// GOOD — reduce sets flag, execute does the heavy work
reduce: {
  analyze(state) {
    state.analyzing = true
  },
},
execute: {
  runAnalysis(app, payload) {
    const results = analyzeEverything(payload.data)  // still 200ms, but doesn't block UI
    app.dispatch(myFeature.A.analysisDone(results))
  },
},
```

## Limitations

- **State must be JSON-serializable** — no classes, functions, Dates, Uint8Arrays, or circular references
- **No CSS imports in TS** — use `src/style.css` (auto-injected) or `<link>` tags, not `import './style.css'`
- **Single CSS entry point** — only `src/style.css` is auto-detected. Use `@import` inside it for multiple files
- **CSS detection is startup-only** — if you create `src/style.css` after starting the server, restart to pick it up
- **`$p` and `$d` are reserved** — don't use `$p` or `$d` as state keys at any level (used internally for delta patches and key deletion within feature slices)
- **WS message size limit** — messages over 1MB are silently dropped. Keep state and actions compact
- **Actions dropped while offline** — when the server is unreachable, `send()` silently drops actions. Only the initial connect race (WS not yet open) queues up to 100 actions
- **Max 100 concurrent WebSocket connections** — returns 503 beyond this limit
- **Dev mode CDN** — React loaded from esm.sh in dev (first load needs internet). Compiled builds are fully offline
