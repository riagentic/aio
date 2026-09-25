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
type Order = { id: string; userId: string };

const orders = cell("orders", {
  state: { page: "", orders: [] as Order[], internal: [] as string[] },
  visible: {
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

## Limits your app declares (`budgets`)

`perfBudget` is the TIMES — milliseconds per dispatch. `budgets` is the SIZES
and RATES:

```ts
await aio.run({
  cells: [todo],
  budgets: {
    cellState: "1MB", // largest a single cell's state may get
    broadcastRate: "20/s", // broadcast rounds per second
    payload: "500KB", // largest single payload to one client
  },
});
```

Every one of these already existed and was reachable — a hard-coded 1 MiB inside
the broadcaster, and `vitals.pressure`'s `rateThreshold` / `payloadThreshold`.
This is one obvious door onto them, in the units a person writes, because no
single default calls a 4 MB table pushed once a minute and 200 bytes at 60 Hz
both correctly.

An explicit `vitals.pressure` still **wins** — it is the more specific
instruction.

`cellState` is read by both size seams: the full-state frame line and the
persist lines (it moves the 1 MB warn, and lifts the 16 MB hard line when
declared above it). A whole-state frame also trips `payload`, so an app that is
big on purpose declares both — every size message prints the exact line to
paste, sized to what it measured
([Legitimately large state](../persistence/big-data.md#legitimately-large-state)).

Sizes are **UTF-8 bytes** — what the wire and the disk carry, and what `"1MB"`
says. Non-ASCII text is up to 3 bytes per character, so a cell holding 900 000
characters of Japanese is 2.7 MB against a `"1MB"` budget. The same unit is used
by the persist size guardrails and the oversized-frame warnings.
(`wsLimits.maxMessageBytes` still _refuses_ an inbound frame by character count,
so nothing that is accepted today starts being refused — but a frame over the
limit in bytes is now said, once per connection.)

### They fail, not just warn

A warning is for a person watching a dev server. A budget is a limit the app
committed to, so `/health` reports it and a breach turns the app `degraded`:

```json
{
  "status": "degraded",
  "budgets": {
    "ok": false,
    "breaches": [
      {
        "budget": "cellState",
        "limit": 1048576,
        "worst": 4210688,
        "detail": "cell \"rows\""
      }
    ]
  }
}
```

That makes it a CI step: `deno task am health` exits non-zero. The ledger keeps
the **worst** reading, not the latest — "it went over once" is the fact, and a
later healthy sample must not erase it.

An app that declared no budgets gets **no** `budgets` field at all, rather than
a green tick: aio's own numbers are hints, not commitments, and a tick for a
promise nobody made reads as assurance.

### Unreadable values throw at boot

`budgets: { cellState: "1 gigabyte" }` fails the boot, naming the key. A budget
that quietly fell back to aio's default is a limit nobody declared and nobody
can see — worse than having none, because the app believes it has one.

## Performance tuning by scenario

### State is large (>1MB)

| Setting                | Value                        | Why                                 |
| ---------------------- | ---------------------------- | ----------------------------------- |
| `visible`              | `exclude` / `forUser`        | Each client only gets what it needs |
| `persist: { exclude }` | exclude caches, derived data | Less to write on each persist cycle |
| `budgets`              | `cellState` + `payload`      | Declare a size that is on purpose   |

Move large collections to SQLite and query on demand. What each limit governs,
measured costs per transport, and the patterns for a working set that is big on
purpose:
[Legitimately large state](../persistence/big-data.md#legitimately-large-state).

### Many concurrent clients (>100)

| Setting              | Value              | Why                                                                                                                                                                                     |
| -------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `visible.forUser`    | per-user filtering | Less data per broadcast                                                                                                                                                                 |
| `syncIntervalMs`     | raise to 100-200ms | Batches rapid _background_ state changes into fewer broadcasts — a client's own action still flushes immediately ([interactive priority](../persistence/delta.md#broadcast-throttling)) |
| `fullStateThreshold` | raise to 0.8–0.9   | A ratio (default 0.5): a delta is sent whole only when almost as large as the state                                                                                                     |

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

Time-travel history is capped at 2000 entries (dev mode only, zero in prod) —
`MAX_ENTRIES` in `src/diagnostics/time-travel.ts`, and the number
[time-travel.md](../debugging/time-travel.md) states.

### Production monitoring

There is no `onPerf` config key — `aio.run()` refuses an unknown key by name, so
a copied snippet that used one exited 1 before serving anything. Budget
violations go to `perf.log` (`perfCheck`/`perfBudget`), and the callback that
exists is `vitals.onVitalAlert`:

```ts
await aio.run({
  cells: [...],
  perfCheck: "on", // budget violations → perf.log
  perfBudget: { reduce: 50, effect: 10 },
  features: {
    all: {
      vitals: {
        onVitalAlert: (alert) => {
          if (alert.status === "frozen") {
            alertSlack(`${alert.layer} ${alert.status}: ${alert.hint?.cause}`);
          }
        },
      },
    },
  },
});
```

See [vitals](../debugging/vitals.md) for the alert shape and the thresholds that
produce one.

## Limitations

- **State must be JSON-serializable** — no classes, functions, Dates,
  Uint8Arrays, or circular references
- **No CSS imports in TS** — use `style.css` next to your entry (auto-injected)
  or `<link>` tags
- **Single CSS entry point** — only `style.css` in the app dir is auto-detected.
  Use `@import` for multiple files
- **`$p` and `$d` are reserved** — don't use as state keys (used internally for
  delta patches)
- **WS message size limit** — a frame over 1MB (`wsLimits.maxMessageBytes`) is
  refused, never silently. The server logs it at error level, writes the same
  line to that client's log store (readable with `am logs`), and sends the
  client back an error frame carrying `message_too_large`, code `1009`, and the
  size it rejected
- **Outbound frames to a Deno peer are capped at 64 MiB** — Deno's WebSocket
  fails the connection on a larger message and cannot be raised, so a full state
  over that is never written to a `connectCli` / `am` / server-to-server peer (a
  browser is not limited). The server logs it, writes it to that client's log
  store, and tells the peer once each time it goes over (`ws-frame-ceiling`),
  which a CLI client prints — instead of the socket dying and reconnecting into
  the same frame. That client reads `connected: false` and `state: null` (never
  a stale copy) until the app's state is smaller: bulk rows belong in `db:`
  tables, binaries in files
- **Offline send queue is bounded at 100 actions** — `send()` does not drop when
  the server is unreachable, it queues. At the cap the OLDEST queued action is
  dropped (newest wins — one policy everywhere), and the drop is loud: a warning
  naming the action type, a diagnostic event carrying the type and the cap, and
  a REJECTED ack, so a caller awaiting that action hears the failure instead of
  hanging
- **Max concurrent WebSocket connections** (configurable via `maxConnections`) —
  new connections get HTTP 503. Auto-retries with exponential backoff. Raise:
  `aio.run({ maxConnections: 1000 })`
