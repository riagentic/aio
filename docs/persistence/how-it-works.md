# How Persistence Works

End-to-end: how cell state gets from memory to disk and back.

## The Pipeline

```
Action dispatched → reduce → new state → schedulePersist()
                                              ↓ (debounce 100ms)
                                         flushPersist()
                                        ↙            ↘
                                 aio_kv snapshot   user tables
                                 (auto-persist)    (db schema)
                                        ↘            ↙
                                     SQLite (state.db)
```

Every dispatched action triggers `schedulePersist()`. The debounce timer
(default 100ms, configurable via `persistDebounceMs`) coalesces rapid state
changes into one write. When the timer fires, the table sync and the snapshot
write run in one flush cycle — both land in the app's single `state.db`.

## One Database, Two Write Paths

Everything persists to **one SQLite file** (`state.db`). Inside it there are two
write paths:

|                    | `aio_kv` snapshot table (auto-persist)    | User tables (db schema)                 |
| ------------------ | ----------------------------------------- | --------------------------------------- |
| **Config**         | `persist: "all"` or `{ include/exclude }` | `dbSchema: { table(...) }`              |
| **Size limit**     | None                                      | None                                    |
| **Write strategy** | Full state replacement                    | Incremental diff (INSERT/UPDATE/DELETE) |
| **Use case**       | Simple state, scalar UI state             | Tables, queries, large datasets         |

Cells with `sync: true` skip the snapshot — their state flows through the CRDT
op-log in SQLite instead.

## Snapshot Persistence (`aio_kv`)

Snapshots are JSON values in the `aio_kv` table — inspect them any time with
`am sql "SELECT * FROM aio_kv"`. Two modes controlled by `persistMode`:

- **`"single"`** (default) — entire filtered state stored as one row.
- **`"multi"`** — each top-level cell stored as a separate row under
  `[persistKey, cellName]`. Atomic via a SQLite transaction.

The state is filtered before writing. Each cell's `persist` config controls what
gets saved:

```ts
cell("user", {
  state: { name: "", sessionToken: "", tempCache: {} },
  // secrets and scratch state stay out of the persisted snapshot
  persist: { exclude: ["sessionToken", "tempCache"] },
  // and out of the browser: exclude secrets from ui too — see the security
  // note in docs/auth/auth.md (a secret needs BOTH excludes)
  visible: { exclude: ["sessionToken"] },
});
```

## SQLite Persistence

When cells define a `dbSchema`, state maps to SQL tables:

```ts
cell("todos", {
  state: { items: [] },
  dbSchema: {
    items: table({ id: pk(), text: text(), done: integer() }),
  },
});
```

### Incremental Diff Strategy

On each flush, `syncTables()` compares current state vs previous state:

1. **Reference check** — `state.items !== prev.items` (skip unchanged tables)
2. **Primary key diff** — for tables with a PK column:
   - `toDelete`: rows in prev but not in current
   - `toInsert`: rows in current but not in prev
   - `toUpdate`: rows in both but with changed column values
3. **Full replace** — tables without PK get DELETE ALL + INSERT ALL
4. All statements execute in **one atomic transaction**

The previous state snapshot is maintained by the persistence manager and updated
after each successful flush.

### Worker Architecture

SQLite runs in a dedicated worker thread (`db-worker.ts`):

- **Writer worker** — all mutations (execute, transaction)
- **Reader workers** — optional read replicas for query parallelism
- **Write lock** — prevents interleaving of execute() into transactions
- **Lazy spawn** — workers created on first DB call, not at `createDB()`

## Boot Sequence

On `aio.run()`, state restores in this order:

1. **SQLite init** — create workers, run `CREATE TABLE IF NOT EXISTS` for all
   tables (including `aio_kv`); legacy Deno.Kv data auto-migrates into `aio_kv`
   on first boot
2. **Snapshot restore** — load persisted state from `aio_kv`, merge with
   `initialState`
3. **Table load** — `SELECT * FROM` each table, merge into state
4. **`onRestore` hook** — your transform runs on the merged state
5. **CRDT restore** — for each `sync: true` cell, the committed op-log is
   replayed through the reducer (HLC-ordered) so sync cells recover their state
   on a headless restart, **before any client connects** (logged as
   `sync: restored cell "x" from N op(s)`). Sync cells are excluded from the
   snapshot — the op-log is their durable store.
6. **Persistence manager creation** — wire filters, register `schedulePersist()`
   callback

Snapshot values are merged over initial state, then table values are merged over
the snapshot. This means the tables always win when both exist — they're the
authoritative source.

> **Dictionary state (`Record<K,V>` with `{}` initial):** the snapshot merge
> treats an empty-object initial as a dictionary and keeps every persisted entry
> — it does NOT drop them as "not in the schema template". Fixed-shape objects
> still use the template rule (unknown keys dropped).

## Concurrency & Safety

- **Debounce** — `schedulePersist()` resets a timer; only the last call within
  the debounce window triggers a flush
- **Guard flag** — `persistRunning` prevents overlapping flushes. If a flush is
  in progress when the timer fires, the new flush waits for the previous one
- **Shutdown** — `setShuttingDown()` prevents new debounces; `flushPersist()`
  forces an immediate sync before process exit
- **Time-travel** — persistence pauses during time-travel to avoid writing
  historical snapshots to disk

## Error Handling

Persistence errors are reported as `PERSIST_ERROR` through the diagnostic bus.
They never crash the app — state continues in memory even if disk writes fail.

There is no per-value size cap — SQLite has no 64KiB limit. Very large snapshot
values are still a smell: prefer `db:` tables for arrays of records.

## See Also

- [Auto-Persist](auto-persist.md) — snapshot configuration
- [SQLite](sqlite.md) — schema, queries, transactions
- [CRDT Protocol](crdt-protocol.md) — sync persistence layer
- [Architecture](../basics/architecture.md) — full module map
