# How Persistence Works

End-to-end: how cell state gets from memory to disk and back.

## The Pipeline

```
Action dispatched → reduce → new state → schedulePersist()
                                              ↓ (debounce 100ms)
                                         flushPersist()
                                        ↙            ↘
                                   Deno.Kv          SQLite
                                (auto-persist)    (db schema)
```

Every dispatched action triggers `schedulePersist()`. The debounce timer
(default 100ms, configurable via `persistDebounceMs`) coalesces rapid state
changes into one write. When the timer fires, KV and SQLite sync run **in
parallel**.

## Two Storage Engines

|                    | Deno.Kv (auto-persist)                    | SQLite (db schema)                      |
| ------------------ | ----------------------------------------- | --------------------------------------- |
| **Config**         | `persist: "all"` or `{ include/exclude }` | `dbSchema: { table(...) }`              |
| **Size limit**     | 65KB per key (warns at 50KB)              | None                                    |
| **Write strategy** | Full state replacement                    | Incremental diff (INSERT/UPDATE/DELETE) |
| **Worker**         | Main thread (async KV API)                | Dedicated worker thread (WAL mode)      |
| **Use case**       | Simple state, small payloads              | Tables, queries, large datasets         |

Cells with `sync: true` skip KV — their state flows through the CRDT op-log in
SQLite instead.

## Deno.Kv Persistence

Two modes controlled by `persistMode`:

- **`"single"`** (default) — entire filtered state stored as one KV entry. Fast
  for small state, hits 65KB limit on larger apps.
- **`"multi"`** — each top-level cell stored as a separate KV entry under
  `[persistKey, cellName]`. Bypasses the 65KB limit by spreading state across
  keys. Atomic via KV transactions.

The state is filtered before writing. Each cell's `persist` config controls what
gets saved:

```ts
cell("user", {
  state: { name: "", sessionToken: "", tempCache: {} },
  // secrets and scratch state stay out of the KV store
  persist: { exclude: ["sessionToken", "tempCache"] },
  // and out of the browser: exclude secrets from ui too — see the security
  // note in docs/auth/auth.md (a secret needs BOTH excludes)
  ui: { exclude: ["sessionToken"] },
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

1. **KV restore** — load persisted state from Deno.Kv, merge with `initialState`
2. **SQLite init** — create workers, run `CREATE TABLE IF NOT EXISTS` for all
   tables
3. **Table load** — `SELECT * FROM` each table, merge into state
4. **`onRestore` hook** — your transform runs on the merged state
5. **CRDT restore** — for each `sync: true` cell, the committed op-log is replayed
   through the reducer (HLC-ordered) so sync cells recover their state on a
   headless restart, **before any client connects** (logged as
   `sync: restored cell "x" from N op(s)`). Sync cells are excluded from KV — the
   op-log is their durable store.
6. **Persistence manager creation** — wire filters, register `schedulePersist()`
   callback

KV values are merged over initial state, then SQLite values are merged over KV.
This means SQLite always wins when both exist — it's the authoritative source.

> **Dictionary state (`Record<K,V>` with `{}` initial):** the KV merge treats an
> empty-object initial as a dictionary and keeps every persisted entry — it does
> NOT drop them as "not in the schema template". Fixed-shape objects still use
> the template rule (unknown keys dropped).

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

Size warnings fire at 50KB (approaching limit) and error at 63KB (exceeds KV
limit). The error message suggests: switch to `persistMode: "multi"`, add
persist field filters, or move to SQLite.

## See Also

- [Auto-Persist](auto-persist.md) — KV configuration
- [SQLite](sqlite.md) — schema, queries, transactions
- [CRDT Protocol](crdt-protocol.md) — sync persistence layer
- [Architecture](../basics/architecture.md) — full module map
