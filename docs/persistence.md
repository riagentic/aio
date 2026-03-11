# Persistence

For the docs index, see [manual.md](manual.md). For scaling guidance, see [scaling.md](scaling.md).

## State persistence

By default, AIO auto-persists your entire state to Deno.Kv. On restart, persisted state is **deep-merged** with `initialState`:

```ts
// On first run:  state = initialState
// On restart:    state = deepMerge(initialState, persisted)
```

This means:
- New fields added to `initialState` appear automatically (at any nesting depth)
- Existing persisted values are restored
- Keys removed from `initialState` are dropped (schema wins)
- Arrays are replaced wholesale (not merged element-by-element)
- Type mismatches (e.g. persisted `null` where initial has an object) fall back to initial

Example: if `initialState` has `{ user: { name: "", age: 0 } }` and persisted has `{ user: { name: "Bob" } }`, the restored `user` will be `{ name: "Bob", age: 0 }` — the new `age` field is preserved.

### Filtering persisted state

Use `getDBState` to exclude transient data:

```ts
await aio.run(initialState, {
  reduce,
  execute,
  getDBState: (s) => ({ counter: s.counter }),  // only persist counter, not UI state
})
```

### Large state — multi-key mode

The default `'single'` mode stores all state in one Deno.Kv entry (65KB limit). For larger state, use `persistMode: 'multi'` — each top-level state key is stored separately, so the limit applies per-key rather than to the whole state object:

```ts
await aio.run(initialState, {
  reduce,
  execute,
  persistMode: 'multi',  // stores state.todos, state.users, etc. as separate KV keys
})
```

`'multi'` mode is backward-compatible — restoring from an empty store falls back gracefully. Not compatible with an existing `'single'` store for the same `persistKey` — use a different `persistKey` or clear the KV store when switching.

### Disabling persistence

```ts
await aio.run(initialState, {
  reduce,
  execute,
  persist: false,  // state resets on every restart
})
```

## SQLite persistence

For structured data (orders, products, users), aio supports SQLite alongside Deno.Kv. KV handles scalar UI state (page, flags, counters). SQLite handles arrays of records — queryable, indexed, relational. Three levels of access:

### Table definition

Define tables with column helpers in your `aio.run()` config:

```ts
import { aio, table, pk, text, real, integer, ref } from 'aio'

type Order = { id: number; customer: string; total: number; userId: number }
type User = { id: number; name: string; email: string }

type AppState = {
  page: string          // → KV (UI state)
  selectedId: number    // → KV (UI state)
  users: User[]         // → SQLite
  orders: Order[]       // → SQLite
}

await aio.run(initialState, {
  reduce, execute,
  db: {
    users: table({
      id:    pk(),
      name:  text(),
      email: text({ unique: true }),
    }),
    orders: table({
      id:       pk(),
      customer: text(),
      total:    real({ default: 0 }),
      userId:   ref('users'),
    }),
  },
})
```

Column helpers:

| Helper | SQL | Notes |
|--------|-----|-------|
| `pk()` | `INTEGER PRIMARY KEY` | One per table, user-assigned (not autoincrement) |
| `text(opts?)` | `TEXT NOT NULL` | `{ nullable, unique, default }` |
| `integer(opts?)` | `INTEGER NOT NULL` | Same opts |
| `real(opts?)` | `REAL NOT NULL` | Same opts |
| `ref(table, opts?)` | `INTEGER REFERENCES table(id)` | Foreign key |

### Level 1 — Auto-sync (zero SQL)

Reducer mutates arrays as normal. Framework syncs to SQLite automatically:

```ts
case A.AddOrder:
  d.orders.push({ id: d.nextId++, customer: action.payload.customer, total: 0, userId: action.payload.userId })
  return []
case A.RemoveOrder:
  d.orders = d.orders.filter(o => o.id !== action.payload.id)
  return []
```

On startup, SQLite data populates state arrays. After each reduce, changed arrays sync back. Reference equality (`!==`) determines which tables need writing — Immer guarantees new refs on mutation.

### Level 2 — ORM methods (typed CRUD)

For effects that need direct data access. Available on `app.db!.<tableName>`:

```ts
case E.LoadExpensiveOrders:
  const expensive = app.db!.orders.where({ total: { gt: 1000 } })
  app.dispatch(A.ordersFiltered(expensive))
  break
```

Methods:

| Method | Returns | Description |
|--------|---------|-------------|
| `.all(opts?)` | `T[]` | All rows |
| `.find(id)` | `T \| undefined` | By primary key |
| `.where(filter, opts?)` | `T[]` | AND-filtered rows |
| `.whereOr(filters)` | `T[]` | OR-filtered rows — array of clauses |
| `.insert(row)` | `{ lastInsertRowId }` | Insert one |
| `.insertMany(rows)` | `void` | Insert many (transaction) |
| `.upsert(row)` | `{ lastInsertRowId, changes }` | Insert or replace (by PK) |
| `.update(where, set)` | `{ changes }` | Update matching |
| `.delete(where)` | `{ changes }` | Delete matching |
| `.count(where?)` | `number` | Count rows |

Where filter supports equality (`{ field: value }`) and operators: `{ field: { gt, gte, lt, lte, ne, like, in } }`.

> **Note:** The operator form is detected by key shape — a value object whose keys are only `gt/gte/lt/lte/ne/like/in` will be treated as an operator, not a plain value. Avoid using those words as column names in your schema.

`all()` and `where()` accept an optional `QueryOpts` second argument: `{ orderBy: 'field' | ['field', 'asc'|'desc'], limit: number, offset: number }`.

```ts
// Paginated query, sorted descending
const page1 = app.db!.orders.where(
  { status: 'open' },
  { orderBy: ['total', 'desc'], limit: 20, offset: 0 }
)

// OR filter — match either clause
const results = app.db!.items.whereOr([{ status: 'active' }, { priority: 'high' }])

// Upsert — insert if new, replace if PK already exists
app.db!.settings.upsert({ id: 1, theme: 'dark' })
```

**Note**: Level 2 methods write directly to SQLite, bypassing the reducer. Use for effects like batch imports or external data loading — not for normal user-driven state changes.

### Level 3 — Raw SQL

For aggregation, joins, complex queries:

```ts
case E.RevenueReport:
  const stats = app.db!.query<{ customer: string; revenue: number }>(
    'SELECT customer, SUM(total) as revenue FROM orders GROUP BY customer'
  )
  app.dispatch(A.reportLoaded(stats))
  break
```

Raw methods:

| Method | Returns | Description |
|--------|---------|-------------|
| `.query<T>(sql, params?)` | `T[]` | SELECT rows |
| `.get<T>(sql, params?)` | `T \| undefined` | Single row |
| `.run(sql, params?)` | `{ changes, lastInsertRowId }` | INSERT/UPDATE/DELETE |
| `.exec(sql)` | `void` | DDL statements |
| `.transaction(fn)` | `R` | Wraps `fn(db)` in BEGIN/COMMIT (ROLLBACK on error) |

### How it works

- **Startup**: Opens SQLite at `./data.db` (dev) or `~/.local/share/<app>/data.db` (compiled). Creates tables with `IF NOT EXISTS`. Loads rows into state arrays
- **After reduce**: Changed arrays sync to SQLite (debounced, same timer as KV). Unchanged arrays (same ref) are skipped
- **Incremental sync**: Tables with primary keys use row-level INSERT/UPDATE/DELETE for efficiency. Tables without PK fall back to full table replacement
- **KV stripping**: Arrays managed by `db:` are auto-excluded from KV persistence — no double-storing
- **Shutdown**: Pending sync flushed, SQLite closed, then KV closed
- **WAL mode + foreign keys**: Enabled by default for performance and referential integrity
- **No migrations**: `CREATE TABLE IF NOT EXISTS` handles setup. Use `app.db!.exec('ALTER TABLE ...')` in `onStart` for schema changes
- **Standalone/Android**: `app.db` is `undefined` — SQLite is server-only

### Incremental sync

For tables with a primary key (`pk()`), SQLite sync uses row-level diffs instead of full table replacement. This is significantly faster for large datasets.

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

When the WebSocket disconnects (network issues, server restart), actions are persisted to IndexedDB and replayed on reconnect.

**How it works:**
1. First connect: Actions queue in memory (max 100) until WS ready
2. After first connect: All subsequent disconnections persist actions to IndexedDB
3. On reconnect: Queued actions replay in order
4. Actions older than 24 hours are discarded before replay

**No configuration needed** — works automatically. The 24-hour `maxAge` prevents stale actions from accumulating indefinitely.

If you need custom behavior, handle it in your reducer (idempotency, conflict resolution).

## State snapshots

Export and import state for debugging, backup, or state transfer. **Server-only** — `snapshot()` and `loadSnapshot()` are `undefined` in standalone/Android mode.

```ts
const app = await aio.run(initialState, { reduce, execute })

// Export current state
const json = app.snapshot!()           // returns JSON string
console.log(json)

// Import state
app.loadSnapshot!('{"counter": 42}')   // replaces state, broadcasts to all clients
```

### Snapshot HTTP endpoints

```sh
# Export
curl http://localhost:8000/__snapshot          # GET → JSON state

# Import (X-AIO header required for CSRF protection)
curl -X POST http://localhost:8000/__snapshot \
  -H 'Content-Type: application/json' \
  -H 'X-AIO: 1' \
  -d '{"counter": 42}'                        # replaces state
```

`loadSnapshot` triggers persistence (debounced KV write), broadcasts the new state to all connected clients, and records a `__snapshot` entry in the time-travel history (dev mode).
