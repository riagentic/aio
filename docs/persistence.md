# Persistence

For the docs index, see [manual.md](manual.md). For scaling guidance, see
[scaling.md](scaling.md).

## State persistence

By default, AIO auto-persists your entire state to Deno.Kv. On restart,
persisted state is **deep-merged** with `initialState`:

```ts
// On first run:  state = initialState
// On restart:    state = deepMerge(initialState, persisted)
```

This means:

- New fields added to `initialState` appear automatically (at any nesting depth)
- Existing persisted values are restored
- Keys removed from `initialState` are dropped (schema wins)
- Arrays are replaced wholesale (not merged element-by-element)
- Type mismatches (e.g. persisted `null` where initial has an object) fall back
  to initial

Example: if `initialState` has `{ user: { name: "", age: 0 } }` and persisted
has `{ user: { name: "Bob" } }`, the restored `user` will be
`{ name: "Bob", age: 0 }` — the new `age` field is preserved.

### Filtering persisted state

**Per-feature exclusion (recommended)** — declare excluded fields directly in
the feature:

```ts
const editor = feature('editor', {
  state: {
    content: '',
    htmlCache: '',   // derived — no need to persist
    thumbnail: '',   // generated — rebuild on load
  },
  methods: { ... },
  persist: { exclude: ['htmlCache', 'thumbnail'] },
})
```

Each feature owns its own persistence config. Fields in `exclude` are stripped
from the KV snapshot automatically. Multiple features can each declare excludes
— they compose without any manual merging.

**App-level exclusion** — use `stateForDB` when you need full control or want to
filter entire features:

```ts
await aio.run({
  features: [myFeature],
  stateForDB: (s) => ({ counter: s.counter }), // only persist counter, not UI state
});
```

`stateForDB` at `aio.run()` level takes precedence over per-feature
`persist.exclude` — only one runs.

### Large state — multi-key mode

The default `'single'` mode stores all state in one Deno.Kv entry (65KB limit).
For larger state, use `persistMode: 'multi'` — each top-level state key is
stored separately, so the limit applies per-key rather than to the whole state
object:

```ts
await aio.run({
  features: [myFeature],
  persistMode: "multi", // stores state.todos, state.users, etc. as separate KV keys
});
```

`'multi'` mode is backward-compatible — restoring from an empty store falls back
gracefully. Not compatible with an existing `'single'` store for the same
`persistKey` — use a different `persistKey` or clear the KV store when
switching.

### Disabling persistence

```ts
await aio.run({
  features: [myFeature],
  persist: false, // state resets on every restart
});
```

## SQLite persistence

For structured data (orders, products, users), aio supports SQLite alongside
Deno.Kv. KV handles scalar UI state (page, flags, counters). SQLite handles
arrays of records — queryable, indexed, relational.

For the full SQLite reference, see [sqldb.md](./sqldb.md).

### Table definition

Define tables with column helpers in your `aio.run()` config:

```ts
import { aio, integer, pk, real, ref, table, text } from "aio";

type Order = { id: number; customer: string; total: number; userId: number };
type User = { id: number; name: string; email: string };

type AppState = {
  page: string; // → KV (UI state)
  selectedId: number; // → KV (UI state)
  users: User[]; // → SQLite
  orders: Order[]; // → SQLite
};

await aio.run({
  features: [myFeature],
  db: {
    users: table({
      id: pk(),
      name: text(),
      email: text({ unique: true }),
    }),
    orders: table({
      id: pk(),
      customer: text(),
      total: real({ default: 0 }),
      userId: ref("users"),
    }),
  },
});
```

Column helpers:

| Helper              | SQL                            | Notes                                            |
| ------------------- | ------------------------------ | ------------------------------------------------ |
| `pk()`              | `INTEGER PRIMARY KEY`          | One per table, user-assigned (not autoincrement) |
| `text(opts?)`       | `TEXT NOT NULL`                | `{ nullable, unique, default }`                  |
| `integer(opts?)`    | `INTEGER NOT NULL`             | Same opts                                        |
| `real(opts?)`       | `REAL NOT NULL`                | Same opts                                        |
| `ref(table, opts?)` | `INTEGER REFERENCES table(id)` | Foreign key                                      |

### Level 1 — Auto-sync (zero SQL)

Reducer mutates arrays as normal. Framework syncs to SQLite automatically:

```ts
reduce: {
  addOrder(state, payload) {
    state.orders.push({ id: state.nextId++, customer: payload.customer, total: 0, userId: payload.userId })
  },
  removeOrder(state, payload) {
    state.orders = state.orders.filter(o => o.id !== payload.id)
  },
},
```

On startup, SQLite data populates state arrays. After each reduce, changed
arrays sync back. Reference equality (`!==`) determines which tables need
writing — Immer guarantees new refs on mutation.

### Level 2 — Direct async SQL

For effects that need queries beyond what state arrays provide — aggregations,
joins, filtered reads, writes that bypass the reducer:

```ts
execute: {
  async revenueReport(app) {
    const { rows } = await app.db!.query<{ customer: string; revenue: number }>(
      'SELECT customer, SUM(total) as revenue FROM orders GROUP BY customer ORDER BY revenue DESC'
    )
    app.dispatch(myFeature.reportLoaded(rows))
  },

  async archiveOld(app) {
    await app.db!.execute(
      'DELETE FROM orders WHERE status = ? AND created_at < ?',
      ['closed', Date.now() - 30 * 86400_000]
    )
  },

  async transferFunds(app, payload: { from: number; to: number; amount: number }) {
    await app.db!.transaction([
      { sql: 'UPDATE accounts SET balance = balance - ? WHERE id = ?', params: [payload.amount, payload.from] },
      { sql: 'UPDATE accounts SET balance = balance + ? WHERE id = ?', params: [payload.amount, payload.to] },
    ])
  },
},
```

| Method                   | Returns                   | Description                                  |
| ------------------------ | ------------------------- | -------------------------------------------- |
| `query<T>(sql, params?)` | `Promise<QueryResult<T>>` | SELECT — rows in `.rows`                     |
| `execute(sql, params?)`  | `Promise<QueryResult>`    | INSERT/UPDATE/DELETE — changes in `.changes` |
| `transaction(stmts)`     | `Promise<QueryResult[]>`  | Atomic multi-statement batch                 |

`app.db` is `undefined` in standalone/Android mode — guard with `app.db!` or
check `app.db != null`.

### How it works

- **Startup**: Opens SQLite at `./data/<appId>.db` (dev) or
  `~/.local/share/<appId>/data.db` (compiled). Creates tables with
  `IF NOT EXISTS`. Loads rows into state arrays
- **After reduce**: Changed arrays sync to SQLite (debounced, same timer as KV).
  Unchanged arrays (same ref) are skipped
- **Incremental sync**: Tables with primary keys use row-level
  INSERT/UPDATE/DELETE for efficiency. Tables without PK fall back to full table
  replacement
- **KV stripping**: Arrays managed by `db:` are auto-excluded from KV
  persistence — no double-storing
- **Shutdown**: Pending sync flushed, SQLite closed, then KV closed
- **WAL mode + foreign keys**: Enabled by default for performance and
  referential integrity
- **No migrations**: `CREATE TABLE IF NOT EXISTS` handles setup. Use
  `app.db!.execute('ALTER TABLE ...')` in `onStart` for schema changes
- **Standalone/Android**: `app.db` is `undefined` — SQLite is server-only

### Incremental sync

For tables with a primary key (`pk()`), SQLite sync uses row-level diffs instead
of full table replacement. This is significantly faster for large datasets.

```ts
// With PK — incremental updates
db: {
  users: table({
    id: pk(),      // ← Primary key enables incremental sync
    name: text(),
  }),
}

// Without PK — full table replacement (slower for large tables)
db: {
  logs: table({
    ts: integer(),
    message: text(),
  }),
}
```

When you have a PK:

- **INSERT**: New rows (not in DB) are inserted
- **UPDATE**: Changed rows (same PK, different data) are updated
- **DELETE**: Removed rows (in DB, not in state) are deleted
- **UNCHANGED**: Skipped entirely

## Offline queue

When the WebSocket disconnects (network issues, server restart), actions are
persisted to IndexedDB and replayed on reconnect.

**How it works:**

1. First connect: Actions queue in memory (max 100) until WS ready
2. After first connect: All subsequent disconnections persist actions to
   IndexedDB
3. On reconnect: Queued actions replay in order
4. Actions older than 24 hours are discarded before replay

**No configuration needed** — works automatically. The 24-hour `maxAge` prevents
stale actions from accumulating indefinitely.

If you need custom behavior, handle it in your reducer (idempotency, conflict
resolution).

## State snapshots

Export and import state for debugging, backup, or state transfer.
**Server-only** — `snapshot()` and `loadSnapshot()` are `undefined` in
standalone/Android mode.

```ts
const app = await aio.run({ features: [myFeature] });

// Export current state
const json = app.snapshot!(); // returns JSON string
console.log(json);

// Import state
app.loadSnapshot!('{"counter": 42}'); // replaces state, broadcasts to all clients
```

### Snapshot HTTP endpoints

```sh
# Export
curl http://localhost:8000/__aio/snapshot          # GET → JSON state

# Import (X-AIO header required for CSRF protection)
curl -X POST http://localhost:8000/__aio/snapshot \
  -H 'Content-Type: application/json' \
  -H 'X-AIO: 1' \
  -d '{"counter": 42}'                        # replaces state
```

`loadSnapshot` triggers persistence (debounced KV write), broadcasts the new
state to all connected clients, and records a `__snapshot` entry in the
time-travel history (dev mode).
