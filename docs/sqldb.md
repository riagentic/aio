# SQLite

Full reference for aio's async SQLite layer. For how it integrates with persistence broadly, see [persistence.md](./persistence.md).

## Overview

aio's SQLite support is built on `node:sqlite` (Deno's built-in Node compat layer — no FFI, no native modules). All DB operations run in a **dedicated Worker thread**, keeping the main event loop non-blocking. Queries return Promises; the main thread and the Worker communicate via `postMessage`.

The Worker spawns **lazily** on first use — zero overhead if your app doesn't use SQLite.

```
main thread        Writer Worker      Reader Workers (optional)
──────────         ─────────────      ─────────────────────────
execute()  ──▶     node:sqlite   ──▶  data.db (WAL)
query()    ──────────────────────────▶ node:sqlite (readonly)
```

One writer, N optional readers. Reads and writes never block each other.
No FFI, no npm packages. Just `--allow-read --allow-write` on the db path.

## Schema definition

Import helpers from `aio` and define tables with `table()`:

```ts
import { table, pk, text, integer, real, ref } from 'aio'

const usersTable = table({
  id:    pk(),
  name:  text(),
  email: text({ unique: true }),
})

const ordersTable = table({
  id:       pk(),
  customer: text(),
  total:    real({ default: 0 }),
  status:   text({ default: 'pending' }),
  userId:   ref('users'),
})
```

### Column helpers

| Helper | SQL type | Notes |
|--------|----------|-------|
| `pk()` | `INTEGER PRIMARY KEY` | One per table; enables incremental sync |
| `text(opts?)` | `TEXT NOT NULL` | String columns |
| `integer(opts?)` | `INTEGER NOT NULL` | Integer columns |
| `real(opts?)` | `REAL NOT NULL` | Floating-point columns |
| `ref(table, opts?)` | `INTEGER REFERENCES table(id)` | Foreign key to another table's `pk()` |

### Column options (`ColumnOpts`)

All helpers except `pk()` accept an optional options object:

| Option | Type | Description |
|--------|------|-------------|
| `nullable` | `boolean` | Omits `NOT NULL` — column accepts SQL `NULL` |
| `unique` | `boolean` | Adds `UNIQUE` constraint |
| `default` | `string \| number` | Adds `DEFAULT value` (string or finite number only) |

```ts
text({ nullable: true })              // TEXT (allows NULL)
integer({ default: 0 })              // INTEGER NOT NULL DEFAULT 0
text({ unique: true, default: '' })  // TEXT NOT NULL UNIQUE DEFAULT ''
```

## Framework integration

Pass the schema to `aio.run()` under `db:`. Keys must match the corresponding state array names:

```ts
type AppState = {
  page: string      // → KV (scalar UI state)
  users: User[]     // → SQLite (arrays)
  orders: Order[]   // → SQLite
}

await aio.run({
  features: [myFeature],
  db: {
    users:  usersTable,
    orders: ordersTable,
  },
})
```

- Arrays under `db:` keys are **automatically excluded from KV** — no double-storing.
- On startup, rows are loaded from SQLite into state (overriding any KV-restored values for those keys).
- After each reducer run, changed arrays are synced back (debounced, default 100ms).

## Auto-sync — Level 1

Mutate state arrays in reducers as usual. The framework handles the rest:

```ts
const orders = feature('orders', {
  state: { orders: [] as Order[], nextId: 1 },
  methods: {
    add(s, payload: { customer: string; userId: number }) {
      s.orders.push({ id: s.nextId++, customer: payload.customer, total: 0, userId: payload.userId })
    },
    remove(s, id: number) {
      s.orders = s.orders.filter(o => o.id !== id)
    },
    updateTotal(s, payload: { id: number; total: number }) {
      const o = s.orders.find(o => o.id === payload.id)
      if (o) o.total = payload.total
    },
  },
})
```

Immer guarantees a new array reference on every mutation. The framework detects changed references via `!==` and syncs only the affected tables.

## `app.db` — direct SQL access

`app.db` is the `DB` interface for use in **effects**. All methods are async:

```ts
interface DB {
  query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>>
  execute(sql: string, params?: unknown[]): Promise<QueryResult>
  transaction(stmts: { sql: string; params?: unknown[] }[]): Promise<QueryResult[]>
  close(): Promise<void>
}

type QueryResult<T = Record<string, unknown>> = {
  rows: T[]
  changes: number
  lastInsertRowId: bigint
}
```

Use it in effect handlers:

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
},
```

`app.db` is `undefined` in standalone/Android mode — guard with `app.db!` or check `app.db != null` if your code runs in both contexts.

### `query` vs `execute`

Both accept SQL and optional params. The distinction is semantic and affects nothing at the protocol level — use `query` for `SELECT` (you want `rows`), `execute` for `INSERT`/`UPDATE`/`DELETE` (you want `changes`/`lastInsertRowId`).

## Transactions

Two forms — both wrap statements in `BEGIN`/`COMMIT` and roll back automatically on any error.

### Callback form (recommended)

Pass an async function. Inside it, use `tx.query` and `tx.execute` — they run on the same writer connection and **see your own uncommitted writes** (read-your-writes guaranteed). The callback's return value is the transaction's return value.

```ts
execute: {
  async transferFunds(app, { fromId, toId, amount }: { fromId: number; toId: number; amount: number }) {
    await app.db!.transaction(async (tx) => {
      const { rows } = await tx.query<{ balance: number }>(
        'SELECT balance FROM accounts WHERE id = ?', [fromId]
      )
      if (rows[0]!.balance < amount) throw new Error('insufficient funds')
      await tx.execute('UPDATE accounts SET balance = balance - ? WHERE id = ?', [amount, fromId])
      await tx.execute('UPDATE accounts SET balance = balance + ? WHERE id = ?', [amount, toId])
      await tx.execute('INSERT INTO audit_log (action, amount) VALUES (?, ?)', ['transfer', amount])
    })
  },
},
```

The callback receives a `Tx` handle — a `query` + `execute` pair scoped to the transaction. Never call `db.execute()` directly inside a transaction callback; use `tx.execute()` instead.

**Write lock:** while the callback runs, all concurrent `db.execute()` calls queue behind it. No external write can interleave between your `BEGIN` and `COMMIT`.

**Nested transactions** throw immediately instead of deadlocking — use SQLite savepoints if you need them.

### Batch form

Pass an array of `{ sql, params }` statements — sent as one atomic message to the worker. Simpler when the statements are fully known upfront and no branching is needed:

```ts
await app.db!.transaction([
  { sql: 'UPDATE accounts SET balance = balance - ? WHERE id = ?', params: [amount, fromId] },
  { sql: 'UPDATE accounts SET balance = balance + ? WHERE id = ?', params: [amount, toId] },
])
```

Returns `QueryResult[]` — one result per statement. Cannot read intermediate results or branch.

### Which to use

| | Callback | Batch |
|---|---|---|
| Read within transaction | ✓ (read-your-writes) | ✗ |
| Branch on query result | ✓ | ✗ |
| Return a value | ✓ | ✗ |
| Statements known upfront | either | required |
| Syntax | slightly more verbose | terse |

## State sync mechanics

`syncTables` runs after each reducer cycle (debounced). It:

1. Checks reference equality for each table: `state[name] !== prev[name]`
2. Skips unchanged tables entirely
3. For changed tables **with a `pk()` column** — computes a row-level diff:
   - New rows (PK not in DB) → `INSERT`
   - Changed rows (same PK, different data) → `UPDATE`
   - Removed rows (PK in state before, not after) → `DELETE`
   - Unchanged rows → skipped
4. For tables **without a `pk()`** — full table replacement (`DELETE` all, then `INSERT` all)
5. Flushes all generated statements in a **single transaction**

```ts
// With PK → incremental (fast for large tables)
db: { users: table({ id: pk(), name: text() }) }

// Without PK → full replacement (fine for small lookup tables)
db: { config: table({ key: text(), value: text() }) }
```

The `prevDbState` snapshot is updated after each successful sync.

## Startup flow

```
aio.run()
  │
  ├─ createDB(path)          // create DB handle (worker not spawned yet)
  ├─ initSchema(db, schema)  // worker spawns here; CREATE TABLE IF NOT EXISTS each table
  ├─ loadKV()                // restore scalar UI state from Deno.Kv
  ├─ onRestore(state)        // optional user hook to validate/transform
  └─ loadTables(db, schema)  // SELECT * FROM each table → populate state arrays
                             // (SQLite wins over KV for db-managed keys)
```

On shutdown, `syncTables` flushes any pending changes before the process exits.

## Default pragmas

Applied automatically when the Worker opens the database:

```sql
PRAGMA journal_mode = WAL         -- concurrent reads while writing
PRAGMA synchronous = NORMAL       -- safe + fast (not FULL)
PRAGMA cache_size = -64000        -- 64MB page cache
PRAGMA busy_timeout = 5000        -- wait up to 5s on locked DB
PRAGMA foreign_keys = ON          -- enforce ref() constraints
```

Override by passing custom pragmas to `createDB` directly (see below).

## Permissions

```sh
deno run --allow-read --allow-write src/main.ts
```

No `--allow-ffi` needed. `node:sqlite` is built into Deno — SQLite is statically linked.

The DB file path is:
- **Dev**: `./data/<appId>.db` (relative to cwd)
- **Compiled**: `~/.local/share/<appId>/data.db` (XDG data dir)

## Standalone / Android

`app.db` is `undefined` in standalone mode (compiled as a single executable) and in the Android target. SQLite is a server-side feature.

```ts
execute: {
  async loadData(app) {
    if (!app.db) return  // standalone — skip or use a different strategy
    const { rows } = await app.db.query('SELECT * FROM products')
    app.dispatch(myFeature.loaded(rows))
  },
},
```

## Read replicas

For read-heavy workloads — parallel queries, backtest scans alongside live writes — spawn readonly Workers on the same WAL-mode file:

```ts
const db = createDB('./myapp.db', { readers: 2 })
```

Routing:
- `query()` → round-robins across N reader Workers (parallel reads)
- `execute()` / `transaction()` → always the single writer Worker

SQLite WAL mode allows concurrent readers on the same file with no lock contention. Readers see all committed writes immediately on the next query.

```
main thread         Writer Worker        Reader 0       Reader 1
───────────         ─────────────        ────────       ────────
db.execute() ──▶   INSERT (commits)
db.query()   ──────────────────────────▶ SELECT
db.query()   ────────────────────────────────────────▶ SELECT
```

Rules:
- One writer — SQLite doesn't support concurrent writes
- N readers — add more for parallel read throughput; each is a separate Deno Worker
- `readers: 0` (default) — all ops go through the writer

## `deno compile` note

Worker files are not automatically embedded by `deno compile`. If you compile an aio app that uses SQLite, pass the worker explicitly:

```sh
deno compile --allow-read --allow-write \
  --include node_modules/.deno/aio/src/db/db-worker.ts \
  main.ts
```

Or reference the worker via its resolved JSR URL. Check the aio JSR package page for the exact path.

## `createDB` directly

For apps that need SQLite outside of the `aio.run()` lifecycle — standalone scripts, CLI tools, tests:

```ts
import { createDB, DEFAULT_PRAGMAS } from 'jsr:@riagentic/aio/db'

const db = createDB('./myapp.db')

// with custom pragmas and read replicas
const db = createDB('./myapp.db', {
  pragmas: [...DEFAULT_PRAGMAS, 'PRAGMA temp_store = MEMORY'],
  readers: 2,
})

const { rows } = await db.query<{ id: number; name: string }>('SELECT * FROM users WHERE id = ?', [1])
await db.execute('INSERT INTO users (name) VALUES (?)', ['Alice'])
await db.close()
```

`createDB` returns the same `DB` interface used by `app.db`. The Worker spawns on first call and persists until `close()`.

## Backup & restore

aio's SQLite runs in WAL mode on a Worker thread. **Never `cp` the `.db` file while the app is running** — WAL files (`.db-wal`, `.db-shm`) may be out of sync, producing a corrupt copy.

### Safe hot backup

Use `VACUUM INTO` via `app.db` — creates a consistent snapshot while the app is live:

```ts
// In an execute handler or onInit:
await app.db!.execute("VACUUM INTO '/backups/myapp-2026-03-17.db'")
```

This creates a standalone `.db` file (no WAL) that's safe to copy, upload, or archive. The source database is unaffected.

### Scheduled backup

Combine with `schedule.cron` for automatic daily backups:

```ts
methods: {
  backup(s) {
    const ts = new Date().toISOString().slice(0, 10)
    return schedule.cron('daily-backup', '0 3 * * *', {
      type: 'myFeature:runBackup', payload: { ts }
    })
  },
},
// in execute:
execute: {
  async runBackup(app, { ts }) {
    await app.db!.execute(`VACUUM INTO '/backups/myapp-${ts}.db'`)
  },
},
```

### WAL checkpoint

SQLite checkpoints automatically, but long-running apps with heavy writes may want to force a checkpoint during maintenance windows:

```ts
await app.db!.execute('PRAGMA wal_checkpoint(TRUNCATE)')
```

`TRUNCATE` mode resets the WAL file to zero bytes — useful before backup or when WAL grows large.

### Restore

Stop the app, replace the `.db` file (and delete any `.db-wal`/`.db-shm` files), restart. On startup, `aio.run()` loads the restored data normally. KV-persisted state (non-SQL) restores from Deno.Kv separately.
