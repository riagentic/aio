# Auto-Persist

AIO auto-persists your entire state to SQLite — the `aio_kv` table in the app's
single `state.db`. On restart, persisted state is **deep-merged** with
`initialState`:

```ts
// On first run:  state = initialState
// On restart:    state = deepMerge(initialState, persisted)
```

- New fields added to `initialState` appear automatically (at any nesting depth)
- Existing persisted values are restored
- Keys removed from `initialState` are dropped (schema wins)
- Arrays are replaced wholesale (not merged element-by-element)
- Type mismatches (e.g. persisted `null` where initial has an object) fall back
  to initial

Writes are **debounced** (`persistDebounceMs`, default 100 ms), so a method that
has returned is committed in memory and broadcast, but not yet on disk. What
that means for a kill, a power cut and a clean shutdown is written down in
[the durability contract](how-it-works.md#the-durability-contract) — read it
before you decide whether you need `journal: true`.

## Per-Cell Persistence

Each cell declares what gets persisted. Default: `"all"` (everything persists).

```ts
// Persist everything (default — omit or set explicitly)
persist: "all",

// Persist nothing
persist: "none",

// Only persist these fields
persist: { include: ["count", "name"] },

// Persist everything except these fields
persist: { exclude: ["cache", "htmlCache"] },
```

Wanting exactly one field kept is the common case, and `{ include: [...] }` is
it — reach for that before hand-rolling storage. The same four forms work for
`visible` ([filter options](../state/cell-visibility.md#filter-options)).

**The names are checked.** A field in `include`/`exclude` that is not in the
cell's state throws at `cell()`, naming the nearest real field and what the
mistake would have cost — a typo here is otherwise silent in both directions (an
`include` typo drops a field you meant to keep; an `exclude` typo writes one you
meant to leave out).

To opt every cell out by default (e.g. for privacy-sensitive apps), use
`cellDefaults` in `aio.run()`:

```ts
await aio.run({
  cells: [counter, auth],
  cellDefaults: { persist: "all" },
});
```

## Multi-key mode

Default `'single'` mode stores all state in one `aio_kv` row. For per-cell
granularity, use `persistMode: 'multi'` — each top-level key is stored
separately:

```ts
await aio.run({
  cells: [myCell],
  persistMode: "multi",
});
```

Switching modes is safe in both directions: boot reads the layout your config
asks for, and if it is empty it looks in the OTHER one before concluding "fresh
install". A document found in the other layout is **copied into the new one,
verified, and only then removed from the old** — announced on both lines:

```
persist: persistMode is "multi" but the stored document is in the "single" layout (3 key(s)) — migrating it to "multi" now.
persist: migrated the stored document single → multi (3 key(s))
```

Retiring the old copy is part of the migration: left behind, it would come back
as authoritative the next time the mode changed. If both layouts somehow hold
data (an older aio, a hand-edited store), boot uses the configured one and warns
about the other — nothing is deleted, and nothing is guessed.

## Disabling persistence

```ts
await aio.run({
  cells: [myCell],
  persist: false,
});
```

## Changing a cell's shape after it has shipped

Your users have rows written by an older version of your app. Restore merges the
persisted state over the cell's **declared** `state`, and the declaration always
wins a disagreement — so an upgrade cannot resurrect a field you deleted or put
a value of the wrong type into your state.

| You did this to a persisted field  | On the next boot                                               |
| ---------------------------------- | -------------------------------------------------------------- |
| **added** it                       | it gets its declared default; other fields restore             |
| **removed** it                     | the stored value is **dropped**, not carried forever           |
| **retyped** it (`number`→`string`) | the stored value is ignored; the **default** is used           |
| **renamed** it                     | remove + add — the old value is **lost** unless you migrate it |
| nested object                      | same rules, field by field, at every depth                     |
| `state: { byId: {} }`              | an empty object means "dictionary" — every stored key is kept  |

Nothing is guessed: a rename is indistinguishable from a delete-plus-add, so aio
does not try to match them up. Carry the value across yourself with `version` +
`onMigrate` — which is handed the declared shape **plus whatever the store still
holds**, so the old field is there to read even though the new declaration no
longer mentions it:

```ts
const hw = cell("hw", {
  version: 2, // bump when the shape changes
  state: { memBps: 0 }, // was: ramBps
  onMigrate(state, from) {
    // `from` is the version that wrote the data.
    if (from < 2) {
      const old = state as unknown as { ramBps?: number };
      if (typeof old.ramBps === "number") state.memBps = old.ramBps;
    }
    return state;
  },
  methods: {/* … */},
});
```

### The case the top-level rules do NOT cover: a field inside a collection

The table above defaults **top-level** keys. Restore is
`deepMerge(initialState, persisted)`, so a key you add to `state` arrives with
its default — but a field you add to the objects inside `Record<string, Elem>`
or `Elem[]` does not exist on the thousands of rows already on disk. They come
back `undefined`.

This is the case that quietly wins, and it is worth naming because the wrong
answer is so much easier to write:

```ts
// The tempting one. It works today, and every read site pays forever.
const status = el.progress ?? "none";
```

One `??` becomes twenty, spread across the codebase, each one a guess about a
value the schema is supposed to guarantee — and the day a field legitimately
holds a falsy value, one of them is wrong. Migrate the collection once instead:

```ts
type Elem = { id: string; title: string; progress: Progress; grouped: boolean };

const board = cell("board", {
  version: 2, //  1 → 2: elements gained `progress` and `grouped`
  state: { elements: {} as Record<string, Elem> },
  onMigrate(state, from) {
    if (from < 2) {
      // Walk the collection ONCE, here, where the shape change is declared.
      for (const el of Object.values(state.elements)) {
        el.progress ??= "none";
        el.grouped ??= false;
      }
    }
    return state;
  },
  methods: {/* …every read is now unconditional: el.progress */},
});
```

Two things make this the cheap option rather than the diligent one: it runs once
at boot instead of on every read, and it puts the default in the single place
the reader already looks for the shape. `am migrations` reports what the pass
did, and a `version` bump with no `onMigrate` is refused by the data-contract
gate — so this is hard to half-do.

The same shape works for an array (`state.items.forEach(…)`) and for a nested
collection (walk down, then across).

`am migrations` shows each cell's declared vs stored version, what the last
boot's migration pass did, and any **shape drift** — a field still in storage
that the current `state` no longer declares. Boot warns about drift too, so a
rename you forgot to migrate is visible before a user reports it.

### When a migration fails, and when you roll back

Both cases are about the same thing: your users' data outliving the build that
wrote it, so neither is allowed to overwrite it.

| Situation                             | What aio does                                                                                                                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onMigrate` **throws**                | the app **refuses to boot** (reported through `onError` too). Nothing is written, so the pre-migration data is untouched and a build with a fixed hook still finds it            |
| stored version is **newer** than code | boots, warns, and keeps the newer build's fields instead of narrowing them away; a verbatim copy of the slice is parked under `__downgraded:<cell>` and carried into every write |

The version stamp is **monotonic**: an older build never lowers it. That is what
makes rolling forward again a no-op instead of a second run of `onMigrate` over
data that was already migrated.

Resetting a cell to its defaults is never the framework's decision — booting on
defaults would persist that emptiness over the data within one debounce window,
which is how a failed migration used to become permanent. To start clean, back
up `state.db` and clear the cell's stored slice yourself.

## State recovery (offline queue)

When the WebSocket disconnects, actions are queued IN MEMORY and replayed on
reconnect.

1. First connect: actions queue in memory (max 100) until WS ready
2. After first connect: disconnections queue actions in memory (lost on reload)
3. On reconnect: queued actions replay in order
4. Actions older than 24 hours are discarded before replay

No configuration needed. If you need custom behavior, handle it in your reducer
(idempotency, conflict resolution).

## State snapshots

Export and import state for debugging, backup, or state transfer.
**Server-only** — `snapshot()` and `loadSnapshot()` are `undefined` in
standalone/Android mode.

```ts
const app = await aio.run({ cells: [myCell] });

const json = app.snapshot!(); // export current state as JSON
app.loadSnapshot!('{"counter": 42}'); // replace state, broadcast to all clients
```

### HTTP endpoints

```sh
# Export
curl http://localhost:8000/__aio/snapshot

# Import (X-AIO header required for CSRF protection)
curl -X POST http://localhost:8000/__aio/snapshot \
  -H 'Content-Type: application/json' \
  -H 'X-AIO: 1' \
  -d '{"counter": 42}'
```

`loadSnapshot` triggers persistence (debounced write), broadcasts the new state
to all connected clients, and records a `__snapshot` entry in the time-travel
history (dev mode).

## SQLite integration

For structured data (orders, products, users), aio maps state to SQL tables in
the same `state.db`. The `aio_kv` snapshot handles scalar UI state. User tables
handle arrays of records — queryable, indexed, relational.

See [sqlite.md](sqlite.md) for the full reference.

Arrays under `db:` keys are automatically excluded from the snapshot — no
double-storing.

### Auto-sync

Methods mutate arrays as normal. Framework syncs to SQLite automatically:

```ts
methods: {
  addOrder(s, customer: string, userId: string) {
    s.orders.push({ id: s.nextId++, customer, total: 0, userId })
  },
  removeOrder(s, id: number) {
    s.orders = s.orders.filter(o => o.id !== id)
  },
},
```

On startup, SQLite data populates state arrays. After each mutation, changed
arrays sync back. Reference equality (`!==`) determines which tables need
writing.

### Incremental sync

For tables with a primary key (`pk()`), sync uses row-level diffs:

- **INSERT**: New rows (not in DB) are inserted
- **UPDATE**: Changed rows (same PK, different data) are updated
- **DELETE**: Removed rows (in DB, not in state) are deleted
- **UNCHANGED**: Skipped entirely

Tables without PK fall back to full table replacement.
