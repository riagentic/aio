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

## The Durability Contract

What survives what, exactly. This is the part every app eventually needs to
know, so it is stated rather than implied.

### A returned method call is not a durability ack

A method returns as soon as its reducer has committed **in memory** — the new
state is already broadcast to every client. It reaches disk on the next debounce
window: `persistDebounceMs`, **100 ms by default**. Everything written inside
that window is lost if the process dies before the flush.

`persistDebounceMs: 0` does not make a write synchronous. It makes the window as
short as the event loop allows — the write is still asynchronous, and there is
still a window.

The one way to know state is on disk is a flush that has completed: aio runs one
on a clean shutdown (below), and `journal: true` closes the window from the
other side by making the actions themselves recoverable.

### What the SQLite settings buy

aio opens `state.db` with `journal_mode = WAL` and `synchronous = NORMAL`
(`DEFAULT_PRAGMAS`, `src/db/async-db.ts`). Precisely:

- A **committed transaction survives process death** — SIGKILL, a crash, the OOM
  killer, `Deno.exit`. The bytes are in the OS page cache and the OS writes them
  out whether or not your process is still there.
- It **may be lost on power loss or an OS/kernel crash**. At `NORMAL`, SQLite
  does not fsync the WAL on every commit, so the last commits can still be in
  the page cache when the machine stops.

For full power-cut durability, pass the pragma — and know what it costs (one
fsync per commit, so every debounce window pays a disk round trip):

```ts
await aio.run({ dbPragmas: ["PRAGMA synchronous = FULL"] });
```

`dbPragmas` is merged **over** the defaults by pragma name, so naming one
setting keeps WAL, `busy_timeout` and the page cache. Turning a default off is
still possible by saying so (`PRAGMA foreign_keys = OFF`).

### What `journal: true` changes

With `journal: true`, every committed action is appended to
`<data>/state.db.journal` before the debounce window closes, and on the next
boot the actions after the last persisted snapshot are replayed on top of it. So
the debounce-window tail is recovered instead of lost.

- Replay **re-reduces** the actions: state transitions only, effects discarded.
  No I/O is repeated, and no request is re-sent.
- The watermark that says "the snapshot already includes up to seq N" is a row
  in `state.db`, written **inside the same transaction as the snapshot**. A
  crash can therefore never make the two disagree, in either direction.
- Each append is a synchronous write, so it survives **process** death. It is
  not fsynced, so power loss can still take the tail. (`sync: true` inside the
  journal implementation would fsync every append; it is not reachable from
  `aio.run()` today — `journal` is a boolean.)

### The shutdown flush is bounded

A clean stop (SIGINT/SIGTERM, `am stop`, `app.stop()`) runs a final
`flushPersist()`. It is not unbounded: shutdown drains in-flight method calls
for up to **3 s** (`DRAIN_TIMEOUT_MS`), then **everything after that shares one
5 s budget** (`TEARDOWN_TIMEOUT_MS` in `src/server/shutdown-budget.ts`) — the
final persist, diagnostics, your `onStop`, the lock, the server and the
databases. A flush that runs out of budget is logged and abandoned, so a very
large final write, or a slow `onStop` ahead of it, can leave the last window
unwritten. A clean stop is a best effort with a stated ceiling, not a guarantee.

Anything that waits for an aio app to exit before escalating to SIGKILL must
wait at least `SHUTDOWN_BUDGET_MS` (3 s + 5 s), or it cuts a legitimate final
flush short.

### What survives what

| Failure                       | Default (WAL + NORMAL)                                               | `journal: true`              | `synchronous = FULL` |
| ----------------------------- | -------------------------------------------------------------------- | ---------------------------- | -------------------- |
| Process killed (SIGKILL, OOM) | all COMMITTED writes                                                 | committed writes + the tail  | all COMMITTED writes |
| …the last debounce window     | lost                                                                 | replayed on next boot        | lost                 |
| Power loss / kernel panic     | last commits may be lost                                             | journal tail may be lost too | all COMMITTED writes |
| Disk corruption               | `checkIntegrityOnBoot` quarantines and restores from `<db>.snapshot` | same                         | same                 |

Nothing on this table is free: `journal: true` costs a synchronous append per
action, and `synchronous = FULL` costs an fsync per commit.

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
