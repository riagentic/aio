# Scaling

aio runs as a single Deno process with SQLite and WebSocket broadcast. With the
right approach it handles far more than you'd expect.

## Architecture at scale

```
Client -> WebSocket -> aio server (single process)
                        ├── state (in-memory, small)
                        └── SQLite state.db (on disk, WAL mode, fast)
                              ├── db: tables (records)
                              └── aio_kv snapshot (UI scalars)
```

A single modern server can handle thousands of concurrent WebSocket connections.
SQLite in WAL mode does 100k+ reads/sec on NVMe. The framework has delta
patching (only changed keys sent) and per-user filtering (`ui.forUser`).

## What limits scale

| Bottleneck      | Cause                                          | Ceiling               |
| --------------- | ---------------------------------------------- | --------------------- |
| In-memory state | Everything in state = everything in RAM        | Depends on state size |
| Broadcast storm | Every action triggers broadcast to all clients | ~1000s of clients     |
| SQLite writes   | Single-writer (WAL allows concurrent reads)    | ~10k writes/sec       |
| Single process  | One machine, one CPU core for dispatch         | One machine's worth   |

## Practices for maximum scale

**1. Keep state small — query on demand**

State should hold what's _active_, not what _exists_.

```ts
// Bad — 100k orders in memory, broadcast to every client
type State = { orders: Order[] }

// Good — state holds current view, SQLite holds everything
type State = { page: string; currentOrders: Order[]; filters: Filters }

methods: {
  async loadOrders(s) {
    const { rows } = await app.db!.query<Order>(
      'SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC LIMIT 100',
      ['active']
    )
    s.currentOrders = rows
  },
},
```

**2. Use cell-level `ui` config aggressively**

Use `forUser` to filter per-client. See
[Cell Visibility](../state/cell-visibility.md):

```ts
const orders = cell("orders", {
  state: { page: "", orders: [], internal: [] },
  ui: {
    include: ["page", "orders"],
    forUser: (exposed, user) => {
      if (user?.role === "admin") return exposed;
      return {
        ...exposed,
        orders: exposed.orders.filter((o) => o.userId === user?.id),
      };
    },
  },
});
```

**3. Use direct async SQL for heavy lifting**

```ts
methods: {
  async importCSV(s, parsedRows: Row[]) {
    for (const batch of chunks(parsedRows, 500)) {
      const params = batch.flatMap(r => [r.id, r.customer, r.total])
      const placeholders = batch.map(() => '(?,?,?)').join(',')
      await app.db!.execute(`INSERT INTO orders(id,customer,total) VALUES ${placeholders}`, params)
    }
    s.imported = parsedRows.length
  },
},
```

**4. Debounce high-frequency updates**

```ts
methods: {
  async sensorBatch(s, buffer: Reading[]) {
    const readings = collectReadings(buffer)
    const params = readings.flatMap(r => [r.ts, r.value])
    const placeholders = readings.map(() => '(?,?)').join(',')
    await app.db!.execute(`INSERT INTO readings(ts,value) VALUES ${placeholders}`, params)
    s.readingCount = readings.length  // one broadcast
  },
},
```

**5. Design state keys for delta efficiency**

Delta patching works per key. For namespaced state, the delta system compares
one level deeper, so changing `workspace.scrollY` only sends that sub-key.

Arrays of objects with `id` fields get per-element delta compression
automatically — only changed elements are sent over the wire.

```ts
// Good: 160 members, 10 change per tick -> only 10 sent (~7.5KB, not 120KB)
type State = {
  fleet: {
    members: Array<{ id: string; price: number; pnl: number }>;
    status: string;
  };
};
```

## Realistic capacity

With careful design (small state, filtered UI, SQLite for bulk data):

- **Concurrent clients**: 1,000-5,000 per server (WebSocket + delta patching)
- **SQLite rows**: Millions (reads are fast, writes batched in transactions)
- **Actions/sec**: Hundreds (reducer is synchronous, keep it fast)
- **Data on disk**: Limited by disk space, not framework

This comfortably serves tens of thousands of daily users on a single $20/month
VPS.

## What aio is not designed for

- Horizontal scaling across multiple machines (no shared state protocol)
- Public-facing websites needing SEO (no server-side rendering)
- Sub-millisecond latency requirements (WebSocket adds ~1-5ms)
- Truly stateless APIs (aio is stateful by design)

## Performance budgets

Every action is timed:

- **reduce budget** (default: 100ms) — if a sync method takes longer, it's
  flagged
- **effect budget** (default: 5ms) — if a sync stretch of the executor takes
  longer, it's flagged

```ts
await aio.run({
  cells: [myCell],
  perfCheck: "on", // or 'off'
  perfBudget: {
    reduce: 50, // warn if a sync method > 50ms
    effect: 10, // warn if a sync effect stretch > 10ms
  },
});
```

### Moving slow work off the sync path

```ts
// BAD — sync method blocks 200ms
methods: {
  analyze(s) {
    s.results = analyzeEverything(s.data)  // blocks 200ms!
  },
},

// GOOD — async method: flag commits first, heavy work suspends
methods: {
  async analyze(s) {
    s.analyzing = true
    s.results = await analyzeEverythingAsync(s.data)
    s.analyzing = false
  },
},
```

## Performance tuning by scenario

### State is large (>1MB)

| Setting                | Value                        | Why                                 |
| ---------------------- | ---------------------------- | ----------------------------------- |
| `ui.forUser`           | filter aggressively          | Each client only gets what it needs |
| `persist: { exclude }` | exclude caches, derived data | Less to write on each persist cycle |

Move large collections to SQLite and query on demand.

### Many concurrent clients (>100)

| Setting              | Value              | Why                                                                                                                                                                                     |
| -------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui.forUser`         | per-user filtering | Less data per broadcast                                                                                                                                                                 |
| `syncIntervalMs`     | raise to 100-200ms | Batches rapid _background_ state changes into fewer broadcasts — a client's own action still flushes immediately ([interactive priority](../persistence/delta.md#broadcast-throttling)) |
| `fullStateThreshold` | raise to 512-1024  | Sends full state when delta is almost as large                                                                                                                                          |

### High-frequency actions (>10/sec)

| Approach                     | How                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------ |
| Batch in methods             | Accumulate events, dispatch once per batch                                     |
| Debounce on client           | `useLocal` for keystroke state, `send` on blur/submit                          |
| Write directly to SQLite     | Use `app.db` in effects for high-volume writes, update state with summary only |
| `perfBudget: { reduce: 20 }` | Catch slow reducers early                                                      |

### Long arrays in state

- **Move to SQLite** — query with `LIMIT`/`OFFSET`, keep only the current page
  in state
- **Use an object keyed by ID** — `{ [id]: item }` instead of `Item[]`. Delta
  patching is per-key
- **Split into a separate cell** — isolate the heavy collection

### Electron / long-running desktop apps

| Setting                       | Value                      | Why                            |
| ----------------------------- | -------------------------- | ------------------------------ |
| `persist: { exclude: [...] }` | exclude UI-only fields     | Reduce persist write frequency |
| `perfCheck: 'on'`             | log violations to perf.log | Catch desktop-specific issues  |

Time-travel history is capped at 200 entries (dev mode only, zero in prod).

### Production monitoring

```ts
await aio.run({
  cells: [...],
  perfCheck: 'on',
  perfBudget: { reduce: 50, effect: 10 },
  onPerf: (metric) => {
    if (metric.reduce > 50) {
      const bd = metric.breakdown
      alertSlack(`Slow reduce: ${metric.actionType} ${metric.reduce}ms` +
        (bd ? ` (produce=${bd.produce.toFixed(0)}ms clone=${bd.clone.toFixed(0)}ms)`: ''))
    }
  },
})
```

The `breakdown` field on `PerfMetric` provides phase-level timing:

| Field       | What it measures                             |
| ----------- | -------------------------------------------- |
| `produce`   | Immer `produce()` — reducer execution (ms)   |
| `clone`     | `structuredClone()` — effect detachment (ms) |
| `spread`    | State object construction (ms)               |
| `routing`   | Owner cell lookup + reduce (ms)              |
| `listeners` | Foreign action listener fan-out (ms)         |

## Limitations

- **State must be JSON-serializable** — no classes, functions, Dates,
  Uint8Arrays, or circular references
- **No CSS imports in TS** — use `src/style.css` (auto-injected) or `<link>`
  tags
- **Single CSS entry point** — only `src/style.css` is auto-detected. Use
  `@import` for multiple files
- **`$p` and `$d` are reserved** — don't use as state keys (used internally for
  delta patches)
- **WS message size limit** — messages over 1MB are silently dropped
- **Actions dropped while offline** — `send()` silently drops when server
  unreachable. Initial connect race queues up to 100 actions
- **Max concurrent WebSocket connections** (configurable via `maxConnections`) —
  new connections get HTTP 503. Auto-retries with exponential backoff. Raise:
  `aio.run({ maxConnections: 1000 })`
