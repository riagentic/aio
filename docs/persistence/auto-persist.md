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
  to initial — a stored `null` under a declared **object** is replaced by the
  declared default, and restore warns naming the path (a declared array or
  primitive keeps its stored `null`). If `null` is a value the field holds,
  declare it `null as T | null`. Dev also warns at the write that stores one.
- A key a method adds to a declared non-empty object (`opts: { a: 1 }`, then
  `s.opts.b = 3`) is **not** restored: dev warns at the write; the next boot
  (dev and production alike) goes on without it, says so by name, and the next
  write removes it from disk. The same goes for a value a method writes with the
  wrong type (`s.count += "abc"` over a declared number): the declared default
  comes back. Declare it, or declare the object as `{}` (an open record).

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
  cellDefaults: { persist: "none" }, // a cell that sets `persist` still wins
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
as authoritative the next time the mode changed. A migration that dies between
the copy and the retire leaves the SAME document in both layouts; the next boot
recognizes that, retires the old copy and says so. If both layouts hold
DIFFERENT data (an older aio, a hand-edited store), boot uses the configured one
and warns about the other — nothing is deleted, and nothing is guessed.

## Disabling persistence

```ts
await aio.run({
  cells: [myCell],
  persist: false,
});
```

## Shaping what goes out — `onPersist`

`persist` FILTERS (whole fields, in or out). `onPersist` SHAPES:

```ts
cell("photos", {
  state: { thumb: null as Blob | null, key: "" },
  onPersist: (s) => ({ key: s.key }), // 40 MB live, 200 bytes on disk
  onRestore: (s) => {
    s.thumb = load(s.key);
  },
  methods: {/* … */},
});
```

aio let you repair what comes back and not shape what goes out. With only a
filter, a field you need **on screen** but not **on disk** has no expression —
the remaining move is a second mirrored cell kept in sync by hand.

`onPersist` receives the slice after `persist`'s include/exclude and returns
what is written. It and `onRestore` are a pair, read in that order:

- a shape that only **drops** fields needs no partner — the cell's declared
  initial fills them back in;
- a shape that **reshapes** needs an `onRestore` that knows the new shape, or
  the app cannot read its own store. That `onRestore` is handed the declared
  state **plus** every key the shape stored (a shape writing `key` restores with
  `s.key` there to read; a shape storing `items` as a list where a record is
  declared restores with the list), and what it leaves is trimmed back to the
  declared shape. The stored slice is checked against what this build's
  `onPersist` writes, not the declaration — so the shape itself is not
  [shape drift](#changing-a-cells-shape-after-it-has-shipped), and a field
  renamed inside it still is.

A crash does not change what comes back: `journal: true` replay sends a
recovered slice through the same `onPersist` → restore → `onRestore` round trip
a clean restart does, so a field the shape keeps off disk is not resurrected by
replaying the action that wrote it. The same holds for every restore hook: when
replay changed state, a plain cell's `onRestore` (for a slice it touched) and
the app-level `onRestore` run again on the replayed state, as they would on the
snapshot a clean stop writes — keep them repairs (idempotent), not counters.

It is **not** error-guarded, unlike the observe-only lifecycle hooks. It runs on
the persist path, where "the write quietly stopped happening" is the worst
outcome there is — the app keeps running on state that is not on disk and finds
out at the next boot. A throw is reported as a failed write, names the cell, and
turns `/health` degraded.

Refused on a `sync: true` cell, for the same reason a `persist` filter is: an op
**is** the method call's payload, written raw, so the field is on disk whatever
the hook returns.

## `persist` is about the STORE — `diagnostics` is about the record

`persist: "none"` keeps a cell's **state** out of the state store — and out of
the dev checkpoint (`logs/checkpoint.json`), which can be read back by
`onCheckpointRestore` and so leaves every `persist: "none"` cell out — and every
field a `persist: { exclude }` (or `include`) keeps off disk; a restored
checkpoint brings those fields back exactly as a restart does. Since 1.0.11 it
also keeps the cell's **payloads** out of `logs/actions.jsonl` and the
state-diff debug log: a `setToken(t)` call's argument IS the state the cell must
never keep, so the line records that the action ran, with its payload redacted.
Lines an older build wrote are rewritten once, in place. Under `journal: true`
the durability journal withholds the same payloads: such a cell's calls are
journalled without their arguments and are not replayed after a crash (its state
is never restored, so a crash brings it back empty, as a clean restart does),
while what a call wrote to **persisted** cells — a `listensTo` reaction — is
journalled as data and survives. The copies an older build left are scrubbed
once at boot, in place: the rolling `.snapshot`, the pre-update `backups/`,
`am backup` copies, the `data.replaced-*` folder `am restore` sets aside, and
every journal among them — except, in an older build's journal, a call some cell
`listensTo`: that line is the only record of the reaction it caused, so it is
kept and the copy is named in a warning (restore it and let one boot replay it,
or delete the copy). To keep the cell's actions out entirely — the line, not
just its payload — use `diagnostics: false` (the whole cell) or `redactActions`
(named actions), below.

They are different things and they now have different words:

```ts
cell("vault", {
  state: { unlocked: false },
  persist: "none", // the STATE never reaches the store
  diagnostics: false, // the ACTIONS never reach the dev record
  methods: {/* … */},
});
```

`diagnostics: false` keeps this cell's actions out of every dev diagnostic that
writes them down: `logs/actions.jsonl`, the state-diff debug log, the
checkpoint's recent actions, and `am timeline`.

It does **not** touch two things, on purpose:

- **The durability journal** (`journal: true`). That is not a diagnostic — it is
  how committed actions are replayed. Dropping a cell from it would be data loss
  dressed as a privacy feature.
- **Persistence.** That is `persist`'s job, and making one key mean both is the
  conflation this key exists to end.

To hide one FIELD while keeping the rest of the record, reach for
`redactActions` instead — see
[Redaction](../debugging/feedback.md#redaction-is-not-optional).

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
| a method `delete`d a declared key  | it comes back with its **default** — write `null` to clear one |

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

What `onMigrate` returns is trimmed to the declared shape before it is stored:
the old key (`ramBps`) is read, carried across, and then dropped with one
warning naming it — so the **next** boot, which has no migration left to run,
finds only declared fields. Deleting it yourself is allowed and changes nothing.

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

`am migrations` shows a running app's declared vs stored version per cell, what
the last boot's migration pass did, and any **shape drift** — a field still in
storage that the current `state` no longer declares. It needs a running app: a
dev boot REFUSES over unmigrated drift left by a changed declaration (every
write stamps its cell's declared shape, so drift the app's OWN methods wrote
under an unchanged `state:` is told apart: that boot goes on, restores the
declared defaults and names each field), and that refusal prints the same
picture — the drifted fields per cell, where the data is, and the ways out
(including `am start --instance=<name>`, which runs the new build against a
private, empty data home and leaves the refused data untouched). Production
boots and warns instead, so a rename you forgot to migrate is visible before a
user reports it.

Boot also says the **safe** case out loud:

```
state shape: 1 declared field(s) not in the stored data, filled from `state:`
— no migration needed — cfg.retries (number). Either the field is new in this
build (adding one is safe on its own), or a method deleted it — a deleted
declared key always comes back with its default (write null to clear one).
(Renaming or removing a field from `state:` is not safe — that is the
"shape drift" line.)
```

The two writes that the next boot would undo are said **when they happen**, in
dev and production, once per path, naming the method: a `delete` of a declared
key (`state write: … deleting a declared key does not survive a restart`), and a
key added under an object `state:` declares with keys
(`state write: … does not declare "y" under that (closed) object`).

Adding a field really is safe — stored data without it deep-merges and the
declared value fills the gap — but you should not have to work that out from
first principles. Silence on the safe case and a warning on the unsafe one are
the same thing as far as a reader is concerned: both are the absence of a
sentence, and neither tells you the tool looked.

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

1. First connect: actions queue in memory until WS ready — 1000 for a cell
   method call, 100 for `useCell().send` / `useAio().send` (two queues, one drop
   policy)
2. After first connect: disconnections queue actions in memory (lost on reload)
3. On reconnect: queued actions replay in order
4. At the cap the OLDEST queued action is dropped — newest data wins — and its
   caller's promise REJECTS rather than resolving. Nothing expires on a clock:
   the queue holds `{action, seq}` and no timestamp

No configuration needed. If you need custom behavior, handle it in your reducer
(idempotency, conflict resolution).

## State snapshots

Export and import state for debugging, backup, or state transfer.
**Server-only** — `snapshot()` and `loadSnapshot()` are `undefined` in
standalone/Android mode.

```ts
const app = await aio.run({ cells: [counter] });

const json = app.snapshot!(); // '{"counter":{"count":3}}' — one object per cell
app.loadSnapshot!('{"counter":{"count":42}}'); // replace state, broadcast to all clients
app.loadSnapshot!(otherAppsFile, { force: true }); // a file whose cell set does not match — refused without force
```

A snapshot has the shape `snapshot()` returns: an object keyed by cell name,
each value that cell's **whole state object**. It must name every declared cell
and no other — a missing cell would be wiped, so a mismatch throws
(`snapshot refused — it has nothing for cell "counter"…`) unless `force: true`,
which wipes each missing cell to its declared state and drops each cell the app
does not declare, with a warning (what a restart gives it). A load is as durable
as a write, `sync: true` cells included, and their clients get the loaded state.
Pass the exact string `snapshot()` gave you.

### HTTP endpoints

```sh
# Export — the port is on the boot line, or in `am instances`
curl http://localhost:<port>/__aio/snapshot

# Import (X-AIO header required for CSRF protection)
curl -X POST http://localhost:<port>/__aio/snapshot \
  -H 'Content-Type: application/json' \
  -H 'X-AIO: 1' \
  -d '{"counter":{"count":42}}'
```

A body whose cell value is not an object (`{"counter": 42}`) is a `400` naming
the cell; a cell-set mismatch is a `400` too, and `?force=1` overrides it.

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
