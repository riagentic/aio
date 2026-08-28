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
execute()  ──▶     node:sqlite   ──▶  state.db (WAL)
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

| Helper              | SQL type                             | Notes                                                              |
| ------------------- | ------------------------------------ | ------------------------------------------------------------------ |
| `pk()`              | `INTEGER PRIMARY KEY`                | One per table; enables incremental sync                            |
| `text(opts?)`       | `TEXT NOT NULL`                      | String columns                                                     |
| `integer(opts?)`    | `INTEGER NOT NULL`                   | Integer columns                                                    |
| `real(opts?)`       | `REAL NOT NULL`                      | Floating-point columns                                             |
| `ref(table, opts?)` | `INTEGER REFERENCES table(<its pk>)` | Foreign key to another table's `pk()` column, whatever it is named |

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

A `db:` key names the **state array the table stores** — which, with cells, is
an array FIELD of a cell (every top-level state key is a cell id, and a cell's
state is an object):

```ts
const contacts = cell("contacts", {
  state: { contacts: [] as Contact[], nextId: 1 }, //   ← the array
  methods: {/* … */},
});

await aio.run({
  cells: [contacts],
  db: { contacts: contactsTable }, //  table "contacts" ↔ state.contacts.contacts
});
```

How a key resolves — decided once at boot, announced in the log, never guessed:

| Key          | Binds to                                                                               | SQL table    |
| ------------ | -------------------------------------------------------------------------------------- | ------------ |
| `items`      | the array field `items` of the **one** cell that declares it                           | `items`      |
| `items`      | ambiguous (two cells declare `items`) → **boot error** naming both                     | —            |
| `cell.items` | that cell's `items` field, explicitly (use it to disambiguate)                         | `cell_items` |
| `cell.items` | no such cell/field → **boot error** listing the array fields that do exist             | —            |
| `rows`       | nothing matches → the table is **SQL-only**: created, warned about, yours via `app.db` | `rows`       |

```
db: table "contacts" ↔ state.contacts.contacts (auto-sync)
db: table "rows" is SQL-only — no state array is bound to it …
```

- A bound array is **auto-excluded from the `aio_kv` snapshot** — SQLite owns
  those rows, and a second copy in the snapshot would be a stale twin
- On startup, rows load from SQLite into the bound field
- After each reducer run, changed arrays sync back (debounced, default 100ms)
- Nothing is ever written to a state key no cell owns

## Auto-sync

Mutate the bound array in a method. The framework handles the rest:

```ts
// db: { orders: ordersTable }  ↔  state.orders.orders
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

### Object-shaped bindings

A `db:` entry may be an object instead of a bare table — the same table, plus
_which_ value it mirrors and in _what shape_. Additive: a bare `TableDef` still
means `{ table, shape: "array" }`.

```ts
db: {
  // a pk-keyed MAP: state.wallet.byMint = { [mint]: Holding }
  "wallet.byMint": { table: holdings, shape: "map" },
  // a SUBSET deeper than one field: state.ledger.book.entries
  "ledger.entries": { table: entries, path: "book.entries" },
}
```

| Option  | Meaning                                                                                                                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `table` | the `table({…})` — required                                                                                                                                                                                              |
| `shape` | `"array"` (default) or `"map"`: the bound value is a plain object whose **values are the rows** and whose **keys are their primary keys** (`String(row[pk])`). Needs a `pk()` column; rebuilt from the pk on every boot. |
| `path`  | dotted path _inside_ the cell (default: the key's `<field>`). Only with an explicit `"<cell>.<field>"` key; the SQL table is still `<cell>_<field>`.                                                                     |

Every misuse is refused at boot by name: a `"map"` without a `pk()`, a `path` on
a bare key, a key whose value is not the declared shape, a bare-key map
(ambiguous by construction — say `"<cell>.<field>"`). At write time, a map key
that disagrees with its row's pk is refused too — the key and the pk are one
fact, and the next boot would key the row by the pk.

### What a persist window costs

A window writes only what moved, and finds it without walking the table:

- a bound table whose reference is unchanged is skipped outright (Immer shares
  structure, so an untouched array keeps its reference)
- inside a changed table, a row that is the **same reference at the same index**
  as in the last committed window is unchanged — one comparison, no key work
  (committed state is frozen; an unchanged reference cannot hide changed
  contents). Only rows whose reference moved are keyed, validated and compared
  column by column
- the pk index survives across windows and advances **only when the transaction
  commits** — a refused window is retried whole
- the window's own Immer patches narrow the pass to the touched rows when they
  can be trusted (`push`, an edit at an index). A patch they cannot express — a
  shrink, a `remove`, the array replaced — takes the full identity pass, which
  is always right and merely slower

Measured (`tests/db-dirty-tracking.test.ts`, 10k rows, one changed row): the old
path cost ~3.3 ms to clone the table plus ~3.4 ms to diff it, every window; the
full identity pass costs ~0.2 ms and the patch-narrowed pass ~0.01 ms.

### What a bound row must look like

A bound array is the table, so the table's rules are the array's rules. Each is
checked before a single statement is built, and each names the table, the row
index and the column:

| Row shape                                                                             | What happens                                                                                            |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `pk` column missing or `null`                                                         | **throws** — a row with no key cannot be updated or deleted                                             |
| two rows with the same `pk`                                                           | **throws** — naming the key and both row indices                                                        |
| a value SQLite cannot store (`Date`, object, `true`, `NaN`, `undefined`)              | **throws** — convert it first (`.toISOString()`, `JSON.stringify`) or use `null`                        |
| a field with no column (`{ id, title, pinned }`)                                      | **warns once** — SQLite owns these rows, so that field is persisted nowhere and is gone after a restart |
| a value the column's type converts (`42` into `text()`, which reads back as `"42.0"`) | **warns once**                                                                                          |
| rows not in ascending `pk` order                                                      | **warns once** — a SQL table is a set; the next boot restores them sorted by `pk`                       |

A row field you want to keep but not store in SQL belongs in a field of the cell
that is _not_ bound to a table.

### Changing a table's schema

`CREATE TABLE IF NOT EXISTS` cannot alter a table that already exists, so schema
drift is reconciled at boot instead:

- a column you **added** that is `nullable` or has a `default` is added to the
  existing table
- a column you added that is `NOT NULL` with no default is added when the table
  is empty; when it holds rows, boot **throws** and names both ways out — SQLite
  has no value to put in the existing rows and aio will not invent one
- a column the database has that you **no longer declare** is reported, and
  throws only when it is `NOT NULL` without a default (every `INSERT` would fail
  on it). Dropping it, and its data, stays your call:
  `ALTER TABLE t DROP COLUMN c`

> **A table's rows can never overwrite a cell's slice.** Rows are only ever
> written to the array field a table is BOUND to. A table named after a cell
> that has no array field of that name binds to nothing: it is created as an
> SQL-only table and boot says so, naming the cell's array fields so the
> intended binding is one edit away (`db: { "nfts.items": table({…}) }`).

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

`execute()` runs **exactly one statement**. A multi-statement string is rejected
with the fix in the message — SQLite prepares the first statement and discards
the rest, so a pasted migration would apply partially and report `changes: 0`
with no error. Run several statements with `transaction([…])` (atomic), or one
call each.

```ts
interface DB {
  query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  execute(sql: string, params?: unknown[]): Promise<QueryResult>; // one statement
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

### What aio owns in the file — and what it doesn't

The state database is shared ground: aio keeps its bookkeeping in **private
tables** (`aio_kv` for the state snapshot, `sync_*` for the CRDT op-log,
`aio_schema` for its own schema version) and treats everything else as yours. In
particular, **aio reserves nothing in `PRAGMA user_version`** — that integer is
the standard SQLite idiom for an _app's_ own "have I run this migration" marker,
and it is entirely the app's to read and write; aio tracks its schema era in
`aio_schema` instead.

History caveat: aio ≤alpha51 wrote `user_version = 1` on open (aio never reads
or writes it since alpha52), so a file created by an older aio may already read
`1` without any app migration having run. An app whose files predate alpha52
should treat `1` as its own baseline — or keep its marker in an app table and
accept one re-run. A fresh file opens at `0`. `createDB` has no `migrations`
option; run yours after it returns (an ordered, recorded `migrations: [...]`
option is a possible later addition).

## Live queries (`reactiveDB`)

`query()` is a snapshot: you asked, you got rows, they are stale the moment the
next write lands. For a derived view a UI keeps on screen — a balance, a
leaderboard, "unread per folder" over 200k rows — that means either keeping the
whole table in cell state (RAM, and a full re-broadcast per write) or
hand-wiring a recompute after every mutation and forgetting one.

`reactiveDB(db)` wraps a `DB` so `select()` returns a **live query** instead: it
re-runs and notifies whenever a write _through the same wrapper_ touches one of
the tables it reads.

```ts
import { createDB, reactiveDB } from "aio/server";

const db = reactiveDB(createDB("./inbox.db"));
await db.execute(
  "CREATE TABLE IF NOT EXISTS mail (id INTEGER PRIMARY KEY, " +
    "folder TEXT NOT NULL, unread INTEGER NOT NULL)",
);

const unread = await db.select<{ folder: string; n: number }>(
  "SELECT folder, COUNT(*) AS n FROM mail WHERE unread = 1 GROUP BY folder",
);

const off = unread.subscribe((rows) => {
  console.log("unread now", rows);
});

await db.execute("INSERT INTO mail (folder, unread) VALUES ('inbox', 1)");
// → the subscriber fired; unread.rows is already refreshed

off();
unread.dispose();
await db.close();
```

`reactiveDB` is exported from both `aio/db` and `aio/server` (the same
function). It wraps any `DB` — `createDB()`, or `app.db` inside a running app.

### What invalidates what

Change detection is **by table**, parsed out of the SQL:

- a query's `tables` are the names after `FROM` and `JOIN`, lowercased
- a write's tables are the names after `INSERT INTO`, `UPDATE`, `DELETE FROM`,
  `REPLACE INTO`
- a write invalidates every live query whose `tables` intersect it; unrelated
  tables never fire

Transactions:

| Form                           | Invalidates                                                |
| ------------------------------ | ---------------------------------------------------------- |
| `transaction([{ sql, … }, …])` | exactly the tables written by the statements, after commit |
| `transaction(async (tx) => …)` | **every** live query, after commit                         |

The callback form cannot see the SQL up front, so it invalidates everything — a
correct superset that never misses a change, at the cost of re-running views a
transaction did not touch. Prefer the array form when the statement list is
known.

### The seam

**Writes must go through the wrapper.** A write issued against the underlying
`DB` — or by another process against the same file — is invisible to the change
feed, and the live query keeps serving the rows it last read. That is the seam,
not a bug: the wrapper knows only what passes through it. Wrap once and use the
wrapper everywhere, or call `refresh()` yourself after an outside write.

### `ReactiveQuery`

| Member          | What it is                                                            |
| --------------- | --------------------------------------------------------------------- |
| `rows`          | `T[]` — the latest rows, refreshed **in place** (same array identity) |
| `tables`        | `ReadonlySet<string>` — what this query is invalidated by             |
| `subscribe(cb)` | notify on every subsequent refresh; returns an unsubscribe function   |
| `refresh()`     | `Promise<void>` — force a re-run and notify now                       |
| `dispose()`     | stop tracking: removed from the change feed, subscribers cleared      |

`select()` fills `rows` before it resolves, and does **not** notify for that
first fill (there are no subscribers yet). A `select()` whose SQL is invalid
rejects there — the one place a live query is allowed to fail loudly.

`dispose()` is not optional bookkeeping: an undisposed query keeps being re-run
on every matching write for the life of the `DB`. Dispose it when the view goes
away.

### After the write is committed, nothing can un-commit it

Two things run after a write lands: the re-run, and your subscribers. Both are
error-isolated, and the reasoning is the same for each — the write is already
committed, so a throw travelling back out of `execute()` would report a failure
that did not happen, and the caller would retry a landed write.

So a re-run that throws (a busy database, a view whose SQL no longer resolves)
and a subscriber that throws are both caught and logged at `error` level on the
`db` channel, naming what happened:

```
a live query failed to refresh after a write — the write is COMMITTED,
and this query's rows are now STALE: …
```

A subscriber that throws does not stop the other subscribers. Neither failure is
silent — a live query that quietly stopped refreshing is exactly the stale-UI
bug this feature exists to prevent — but neither one is allowed to describe a
committed write as undone.

## Integrity & snapshots

A file that holds data a user would miss eventually meets a power cut mid-write,
a full disk, or a filesystem that lied about `fsync`. Two primitives cover it.

```ts
await app.db.snapshot(`${dir}/state.db.snapshot`); // VACUUM INTO — safe while live
const { ok, problems } = await app.db.checkIntegrity(); // PRAGMA quick_check
```

`snapshot()` copies at a single point in time (never half-written) and compacts
on the way out. It writes to a temp file beside the destination, runs
`quick_check` on the COPY, and only then renames it over the destination — so
calling it on a schedule works, the destination is replaced atomically, and a
snapshot is never silently a corrupt copy of a damaged file. At every instant
the path holds either the previous good snapshot or the new one.

```ts
// A rolling snapshot: one file, replaced in place.
const snapshot = `${dir}/state.db.snapshot`;
setInterval(() => {
  app.db.snapshot(snapshot).catch((e) => log.error(`snapshot failed: ${e}`));
}, 15 * 60_000);
```

`snapshot()` is what `checkIntegrityOnBoot` restores from, and it keeps exactly
one generation. **Dated history is the app's own job** — copy the fresh snapshot
aside and prune, so a corruption you notice late still has something older to
come back to:

```ts
const KEEP = 7;
async function rollSnapshot(dir: string) {
  const snapshot = `${dir}/state.db.snapshot`;
  await app.db.snapshot(snapshot); // atomic; verified before it lands
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await Deno.copyFile(snapshot, `${dir}/state.db.${stamp}.bak`);
  const dated = [...Deno.readDirSync(dir)]
    .map((e) => e.name)
    .filter((n) => n.endsWith(".bak"))
    .sort(); // the stamp is ISO, so lexical order is chronological
  for (const old of dated.slice(0, Math.max(0, dated.length - KEEP))) {
    await Deno.remove(`${dir}/${old}`);
  }
}
```

```ts
await aio.run({ checkIntegrityOnBoot: true });
```

On boot the app database is scanned. A sound file costs one cheap scan and says
nothing. A damaged one is **quarantined** — renamed beside itself with a
timestamp, never deleted, so a human or a real recovery tool still has every
byte — and if `<db>.snapshot` exists the app boots on that instead. Every branch
is reported, including what the restore lost:

```
db: INTEGRITY CHECK FAILED for …/state.db — row 4 missing from index idx_x
db: damaged file kept at …/state.db.corrupt-2026-08-02T14-27-10-762Z
db: restored from …/state.db.snapshot — changes made AFTER that snapshot are
    not in it; the damaged original is at …
```

The snapshot is checked before it is installed. If it is damaged too, it is
**not** restored and nothing is deleted — both files stay on disk for a real
recovery tool, and the app says so.

With no usable snapshot the app starts **empty** and says so, loudly, rather
than booting on a file SQLite cannot read. Off by default: only apps holding
data worth this deserve the per-boot scan.

`.corrupt-<timestamp>` copies are full-size copies of the database, and
`am backup` archives whatever is in the data directory. aio keeps the **3 most
recent** automatically and reports each one it removes; anything older than that
is yours to keep by copying it somewhere else first.

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

### Integers beyond 2^53

SQLite INTEGERs are 64-bit; JavaScript numbers are not. A single row holding a
value beyond ±2^53 makes `node:sqlite` throw on every read of that table
(`RangeError: Value is too large…`) — including the boot-time load. The error
names the table and the offending column, and the fix is to store the value as
TEXT, or to read that column with an explicit `CAST(col AS TEXT)`.

## State sync mechanics

`syncTables` runs after each reducer cycle (debounced):

1. Check reference equality: `state[name] !== prev[name]`
2. Skip unchanged tables
3. Tables **with `pk()`** — row-level diff (INSERT/UPDATE/DELETE unchanged rows
   skipped)
4. Tables **without `pk()`** — full table replacement
5. Flush all in a **single transaction**

## Boot schema setup — one runner

Every DDL seam runs through ONE ordered, fatal runner (`runSchemaSetup`,
`src/db/ddl.ts`), in this order:

1. **ladder** — aio's own versioned schema moves, tracked in its private
   `aio_schema` table (deliberately _not_ `PRAGMA user_version`, which is the
   app's — see below). A file written by a **newer** aio is refused here with
   both exits: upgrade aio, or restore a backup taken by this version.
2. **tables** — the declared `db:` tables, then drift reconciliation.
3. **sync** — the CRDT op-log tables and their migrations (sync cells only).

Every step is idempotent, so a re-boot on the same file is a no-op walk. The
first failure **refuses the boot** — naming the step, what ran before it, and
the fix — and nothing after it runs; the app never serves traffic against a
schema it does not have (it used to: a refused `CREATE TABLE` became one
`sqlite: unavailable` warning and an app with none of its tables).

```
db: schema setup REFUSED at step "tables" (after ladder) — db: could not create
table "orders" — near "order": syntax error …
  fix: the message above names the table and column SQLite refused — …
  Nothing after this step ran; the app did not start, …
```

## Startup flow

```
aio.run()
  ├─ createDB(path)          // create DB handle (worker not spawned yet)
  ├─ initSchema(db, schema)  // worker spawns; CREATE TABLE IF NOT EXISTS
  ├─ loadKV()                // restore scalar UI state from the aio_kv table
  ├─ onRestore(state)        // optional user hook
  └─ loadTables(db, schema)  // SELECT * → populate state arrays (tables win over the snapshot)
```

## Default pragmas

```sql
PRAGMA journal_mode = WAL         -- concurrent reads while writing
PRAGMA synchronous = NORMAL       -- safe + fast
PRAGMA cache_size = -64000        -- 64MB page cache
PRAGMA busy_timeout = 5000        -- wait up to 5s on lock
PRAGMA foreign_keys = ON          -- enforce ref() constraints
```

### Choosing your own durability

`synchronous = NORMAL` is the right default for a cache and the wrong one for a
wallet: on power loss it can lose the last committed transactions. Replace the
list per app — the array you pass is used verbatim, so include the pragmas you
still want:

```ts
await aio.run({
  cells: [ledger],
  dbPragmas: [
    "PRAGMA journal_mode = WAL",
    "PRAGMA synchronous = FULL", // survive power loss, pay an fsync per commit
    "PRAGMA cache_size = -64000",
    "PRAGMA busy_timeout = 5000",
    "PRAGMA foreign_keys = ON",
  ],
});
```

`FULL` costs one fsync per commit — worth it when the last transaction is a
freshly imported seed or a payment, not worth it for a UI cache.

## Permissions

```sh
deno run --allow-read --allow-write src/main.ts
```

No `--allow-ffi` needed. DB path: `~/.<appId>/data/state.db` — the same in dev
and compiled (see [Where Files Live](where-files-live.md)).

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

The DB runs in a Worker started with
`new Worker(new URL("./db-worker.ts", import.meta.url))`, which `deno compile`
cannot see in the module graph. It must be embedded explicitly — otherwise the
binary compiles, boots, and dies on the first DB call with
`Module not found: …/src/db/db-worker.ts`.

`deno task build` does this for you. Compiling an entry yourself, take the flags
from the framework rather than typing a path:

```ts
import { dbWorkerInclude } from "aio/build";

await new Deno.Command("deno", {
  args: ["compile", "-A", ...dbWorkerInclude(), "-o", "myapp", "src/app.ts"],
}).output();
```

Or by hand, where `<aio-src>` is wherever aio resolved for your project —
`dep/aio/src` for a vendored/source install,
`node_modules/.deno/@riagentic+aio@<version>/src` for a JSR one (the version is
part of the directory name; `node_modules/.deno/aio/…` is not a real path):

```sh
deno compile --allow-read --allow-write \
  --include <aio-src>/src/db/db-worker.ts \
  main.ts
```

See [build targets → compiling an entry yourself](../build/targets.md) for the
size flags that go with it.

## `createDB` standalone

For scripts, CLI tools, tests outside `aio.run()`:

```ts
import { createDB, DEFAULT_PRAGMAS } from "aio/server";

const db = createDB("./myapp.db"); // zero-config
const tuned = createDB("./myapp.db", {
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
`aio.run()` loads restored data normally. The `aio_kv` snapshot lives in the
same file, so it restores with it.
