# Auto-Persist

AIO auto-persists your entire state to Deno.Kv. On restart, persisted state is
**deep-merged** with `initialState`:

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

## Filtering persisted state

**Per-feature exclusion (recommended):**

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

Fields in `exclude` are stripped from the KV snapshot automatically. Multiple
features can each declare excludes — they compose without manual merging.

**App-level exclusion** — use `stateForDB` for full control or to filter entire
features:

```ts
await aio.run({
  features: [myFeature],
  stateForDB: (s) => ({ counter: s.counter }),
});
```

`stateForDB` at `aio.run()` level takes precedence over per-feature
`persist.exclude` — only one runs.

## Multi-key mode

Default `'single'` mode stores all state in one Deno.Kv entry (65KB limit). For
larger state, use `persistMode: 'multi'` — each top-level key is stored
separately:

```ts
await aio.run({
  features: [myFeature],
  persistMode: "multi",
});
```

Not compatible with an existing `'single'` store for the same `persistKey` — use
a different `persistKey` or clear the KV store when switching.

## Disabling persistence

```ts
await aio.run({
  features: [myFeature],
  persist: false,
});
```

## State recovery (offline queue)

When the WebSocket disconnects, actions are persisted to IndexedDB and replayed
on reconnect.

1. First connect: actions queue in memory (max 100) until WS ready
2. After first connect: disconnections persist actions to IndexedDB
3. On reconnect: queued actions replay in order
4. Actions older than 24 hours are discarded before replay

No configuration needed. If you need custom behavior, handle it in your reducer
(idempotency, conflict resolution).

## State snapshots

Export and import state for debugging, backup, or state transfer.
**Server-only** — `snapshot()` and `loadSnapshot()` are `undefined` in
standalone/Android mode.

```ts
const app = await aio.run({ features: [myFeature] });

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

`loadSnapshot` triggers persistence (debounced KV write), broadcasts the new
state to all connected clients, and records a `__snapshot` entry in the
time-travel history (dev mode).

## SQLite integration

For structured data (orders, products, users), aio supports SQLite alongside
Deno.Kv. KV handles scalar UI state. SQLite handles arrays of records —
queryable, indexed, relational.

See [sqlite.md](sqlite.md) for the full reference.

Arrays under `db:` keys are automatically excluded from KV — no double-storing.

### Auto-sync

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
writing.

### Incremental sync

For tables with a primary key (`pk()`), sync uses row-level diffs:

- **INSERT**: New rows (not in DB) are inserted
- **UPDATE**: Changed rows (same PK, different data) are updated
- **DELETE**: Removed rows (in DB, not in state) are deleted
- **UNCHANGED**: Skipped entirely

Tables without PK fall back to full table replacement.
