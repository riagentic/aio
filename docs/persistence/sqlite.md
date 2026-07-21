# SQLite

Full reference for aio's async SQLite layer. For how it integrates with
persistence broadly, see [auto-persist.md](auto-persist.md).

## Overview

Built on `node:sqlite` (Deno's built-in Node compat layer — no FFI, no native
modules). All DB operations run in a **dedicated Worker thread**, keeping the
main event loop non-blocking. The Worker spawns **lazily** on first use.

```
main thread        Writer Worker      Reader Workers (optional)
──────────         ─────────────      ─────────────────────────
execute()  ──▶     node:sqlite   ──▶  data.db (WAL)
query()    ──────────────────────────▶ node:sqlite (readonly)
```

One writer, N optional readers. No FFI, no npm packages. Just
`--allow-read --allow-write` on the db path.

## Schema definition

```ts
import { integer, pk, real, ref, table, text } from "aio";

const usersTable = table({
  id: pk(),
  name: text(),
  email: text({ unique: true }),
});

const ordersTable = table({
  id: pk(),
  customer: text(),
  total: real({ default: 0 }),
  status: text({ default: "pending" }),
  userId: ref("users"),
});
```

### Column helpers

| Helper              | SQL type                       | Notes                                   |
| ------------------- | ------------------------------ | --------------------------------------- |
| `pk()`              | `INTEGER PRIMARY KEY`          | One per table; enables incremental sync |
| `text(opts?)`       | `TEXT NOT NULL`                | String columns                          |
| `integer(opts?)`    | `INTEGER NOT NULL`             | Integer columns                         |
| `real(opts?)`       | `REAL NOT NULL`                | Floating-point columns                  |
| `ref(table, opts?)` | `INTEGER REFERENCES table(id)` | Foreign key to another table's `pk()`   |

### Column options (`ColumnOpts`)

| Option     | Type               | Description                                         |
| ---------- | ------------------ | --------------------------------------------------- |
| `nullable` | `boolean`          | Omits `NOT NULL` — column accepts SQL `NULL`        |
| `unique`   | `boolean`          | Adds `UNIQUE` constraint                            |
| `default`  | `string \| number` | Adds `DEFAULT value` (string or finite number only) |

```ts
text({ nullable: true }); // TEXT (allows NULL)
integer({ default: 0 }); // INTEGER NOT NULL DEFAULT 0
text({ unique: true, default: "" }); // TEXT NOT NULL UNIQUE DEFAULT ''
```

## Framework integration

Keys must match the corresponding state array names:

```ts
type AppState = {
  page: string; // → KV (scalar UI state)
  users: User[]; // → SQLite (arrays)
  orders: Order[]; // → SQLite
};

await aio.run({
  cells: [myCell],
  db: { users: usersTable, orders: ordersTable },
});
```

- Arrays under `db:` keys are **auto-excluded from KV**
- On startup, rows load from SQLite into state
- After each reducer run, changed arrays sync back (debounced, default 100ms)

## Auto-sync

Mutate state arrays in reducers. The framework handles the rest:

```ts
const orders = cell("orders", {
  state: { orders: [] as Order[], nextId: 1 },
  methods: {
    add(s, payload: { customer: string; userId: number }) {
      s.orders.push({
        id: s.nextId++,
        customer: payload.customer,
        total: 0,
        userId: payload.userId,
      });
    },
    remove(s, id: number) {
      s.orders = s.orders.filter((o) => o.id !== id);
    },
  },
});
```

Immer guarantees new array references on mutation. Framework detects via `!==`
and syncs only affected tables.

> **A `db:` table name must not collide with a cell.** A `db:` table maps to the
> top-level state slice of the same name, which must **be an array**. If you
> name a table after a cell (whose slice is an object, e.g. `{ nfts: [...] }`),
> the table's rows would overwrite that object slice at boot and break the
> cell's methods — so aio **throws at boot**, naming both. Rename the table
> (`nft_rows`), or point it at a genuinely array-root slice. To persist a cell's
> nested array field, use direct `createDB` (below) rather than `db:` auto-sync.

## Testing with an in-memory DB

`createDB(":memory:")` opens an ephemeral, file-less SQLite DB in a single
Worker — ideal for unit tests: no temp file, deterministic, and closed with
`await db.close()`. An in-memory DB can't be shared across Workers, so the
`readers` option is ignored for `:memory:` (each reader would get its own empty
DB); it stays writer-only.

```ts
const db = createDB(":memory:");
try {
  await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  // …exercise the real query/execute/transaction paths…
} finally {
  await db.close();
}
```

## Direct SQL access (`app.db`)

```ts
interface DB {
  query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  execute(sql: string, params?: unknown[]): Promise<QueryResult>;
  transaction(
    stmts: { sql: string; params?: unknown[] }[],
  ): Promise<QueryResult[]>;
  close(): Promise<void>;
}

type QueryResult<T = Record<string, unknown>> = {
  rows: T[];
  changes: number;
  lastInsertRowId: bigint;
};
```

```ts
methods: {
  async revenueReport(s) {
    const { rows } = await app.db!.query<{ customer: string; revenue: number }>(
      'SELECT customer, SUM(total) as revenue FROM orders GROUP BY customer ORDER BY revenue DESC'
    )
    s.report = rows
  },
},
```

`app.db` is `undefined` in standalone/Android mode.

## Transactions

Both forms wrap in `BEGIN`/`COMMIT` and roll back on error.

### Callback form (recommended)

Read-your-writes guaranteed. The callback's return value is the transaction's
return value.

```ts
await app.db!.transaction(async (tx) => {
  const { rows } = await tx.query<{ balance: number }>(
    "SELECT balance FROM accounts WHERE id = ?",
    [fromId],
  );
  if (rows[0]!.balance < amount) throw new Error("insufficient funds");
  await tx.execute("UPDATE accounts SET balance = balance - ? WHERE id = ?", [
    amount,
    fromId,
  ]);
  await tx.execute("UPDATE accounts SET balance = balance + ? WHERE id = ?", [
    amount,
    toId,
  ]);
});
```

**Write lock:** concurrent `db.execute()` calls queue behind the callback.
**Nested transactions** throw immediately — use SQLite savepoints if needed.

### Batch form

Array of `{ sql, params }` — one atomic message to the worker:

```ts
await app.db!.transaction([
  {
    sql: "UPDATE accounts SET balance = balance - ? WHERE id = ?",
    params: [amount, fromId],
  },
  {
    sql: "UPDATE accounts SET balance = balance + ? WHERE id = ?",
    params: [amount, toId],
  },
]);
```

|                          | Callback               | Batch    |
| ------------------------ | ---------------------- | -------- |
| Read within transaction  | yes (read-your-writes) | no       |
| Branch on query result   | yes                    | no       |
| Statements known upfront | either                 | required |

## State sync mechanics

`syncTables` runs after each reducer cycle (debounced):

1. Check reference equality: `state[name] !== prev[name]`
2. Skip unchanged tables
3. Tables **with `pk()`** — row-level diff (INSERT/UPDATE/DELETE unchanged rows
   skipped)
4. Tables **without `pk()`** — full table replacement
5. Flush all in a **single transaction**

## Startup flow

```
aio.run()
  ├─ createDB(path)          // create DB handle (worker not spawned yet)
  ├─ initSchema(db, schema)  // worker spawns; CREATE TABLE IF NOT EXISTS
  ├─ loadKV()                // restore scalar UI state from Deno.Kv
  ├─ onRestore(state)        // optional user hook
  └─ loadTables(db, schema)  // SELECT * → populate state arrays (SQLite wins over KV)
```

## Default pragmas

```sql
PRAGMA journal_mode = WAL         -- concurrent reads while writing
PRAGMA synchronous = NORMAL       -- safe + fast
PRAGMA cache_size = -64000        -- 64MB page cache
PRAGMA busy_timeout = 5000        -- wait up to 5s on lock
PRAGMA foreign_keys = ON          -- enforce ref() constraints
```

## Permissions

```sh
deno run --allow-read --allow-write src/main.ts
```

No `--allow-ffi` needed. DB path: `./data/<appId>.db` (dev) or
`~/.local/share/<appId>/data.db` (compiled).

## Standalone / Android

`app.db` is `undefined`. SQLite is server-only.

## Read replicas

```ts
const db = createDB("./myapp.db", { readers: 2 });
```

- `query()` round-robins across reader Workers
- `execute()` / `transaction()` always use the writer
- SQLite WAL allows concurrent readers with no lock contention

## `deno compile` note

Worker files aren't auto-embedded. Pass the worker explicitly:

```sh
deno compile --allow-read --allow-write \
  --include node_modules/.deno/aio/src/db/db-worker.ts \
  main.ts
```

## `createDB` standalone

For scripts, CLI tools, tests outside `aio.run()`:

```ts
import { createDB, DEFAULT_PRAGMAS } from "jsr:@riagentic/aio/db";

const db = createDB("./myapp.db");
const db = createDB("./myapp.db", {
  pragmas: [...DEFAULT_PRAGMAS, "PRAGMA temp_store = MEMORY"],
  readers: 2,
});

const { rows } = await db.query<{ id: number; name: string }>(
  "SELECT * FROM users WHERE id = ?",
  [1],
);
await db.close();
```

## Backup & restore

**Never `cp` the `.db` file while the app is running** — WAL files may be out of
sync.

### Safe hot backup

```ts
await app.db!.execute("VACUUM INTO '/backups/myapp-2026-03-17.db'");
```

### Scheduled backup

```ts
methods: {
  async runBackup(s, ts: string) {
    await app.db!.execute(`VACUUM INTO '/backups/myapp-${ts}.db'`)
    s.lastBackup = ts
  },
},
```

### WAL checkpoint

```ts
await app.db!.execute("PRAGMA wal_checkpoint(TRUNCATE)");
```

### Restore

Stop the app, replace the `.db` file (delete `.db-wal`/`.db-shm`), restart.
`aio.run()` loads restored data normally. KV state restores separately.
