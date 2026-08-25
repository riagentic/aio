# CRDT Sync Layer

Offline-first collaborative state for AIO cells. Opt-in per cell,
server-authoritative, hybrid op-log + snapshot architecture.

Sync wraps the existing dispatch loop. Sync-enabled cells stamp mutations as
operations with HLC timestamps, store them in an op-log (localStorage on the
client, SQLite on the server), and merge on reconnect. Non-sync cells are
unaffected.

**It just works.** Add `sync: true` to a cell and the client engine boots
automatically on connect — local method calls become HLC ops (queued offline,
replayed on reconnect), the server applies each accepted op through its normal
dispatch and relays to peers, and the optimistic view drives your UI. The server
op-log SQLite file is provisioned even without a `db:` config.

> **Status: stable, fully tested.** The end-to-end loop is proven by multi-tab
> convergence e2e against real browsers, plus unit + property + integration
> suites over the engine, HLC, op buffer, catch-up cursor, compaction, and
> reconnect paths (`tests/sync/`, `tests/browser-sync.test.ts`,
> `tests/e2e-sync-browser.test.ts`).

See also: [Wire protocol & internals](crdt-protocol.md)

## Quick Start

```ts
const todos = cell("todos", {
  state: { items: [], filter: "all" },
  sync: true, // all fields LWW, 4h retention
  methods: {
    add(s, text: string) {
      s.items.push({ id: crypto.randomUUID(), text });
    },
    remove(s, id: string) {
      s.items = s.items.filter((i) => i.id !== id);
    },
  },
});
```

With custom merge strategies:

```ts
const inventory = cell("inventory", {
  state: { stock: {}, quantity: 0, items: [] },
  sync: {
    merge: { stock: "lww-per-key", quantity: "counter", items: "set-add" },
    identity: { items: "sku" },
    offline: { retention: "7d" },
    onConflict(conflicts) {
      // Fires when a remote op changes a field your unconfirmed local ops
      // also changed. Default semantics are rebase-LWW: your local value
      // stays visible (replayed on top) until confirmed; `remote` is the
      // confirmed value underneath; resolution is "lww".
      //
      // Fields with a merge strategy get a CRDT merge applied to YOUR VIEW
      // for the conflict window (e.g. quantity shows base + both deltas,
      // items shows the union) and resolution names the strategy. The server
      // remains the convergence authority — the next ack/snapshot rebase
      // replaces the merged view with the confirmed outcome.
      console.log("conflicts:", conflicts);
    },
    onSync(stats) {
      console.log(`synced ${stats.merged} ops`);
    },
  },
  methods: {/* ... */},
});
```

## Architecture

```
Client A                    Server                    Client B
   |--- op {hlc, action} ---->|--- op (broadcast) ------->|
   |<-- sync-ack {serverHlc} -|                          |
   |  (goes offline)          |                          |
   |  (queues ops locally)    |                          |
   |--- sync-req {lastHlc} -->|                          |
   |<-- sync-res {ops|snap} --|                          |
```

**Dual-layer state:** Confirmed (server-acked) + Optimistic (confirmed +
unconfirmed ops replayed through reducer). UI always reads optimistic for
instant feedback.

**Catch-up cursor:** the server stamps every persisted op with a strictly
monotonic `server_ts` and echoes a per-cell `lastServerTs` cursor in each
`sync-res` response (reserved under the cell's lock — race-free). Clients send
it back on the next catch-up, so re-delivery (and double-apply through the
reducer) can't happen; broadcast `op` frames carry their `serverTs` so peers
advance the cursor as they apply them. The HLC cursor remains as a legacy
fallback only.

## Merge Strategies

### lww (Last-Write-Wins) — default

Later HLC timestamp wins. Fires `onConflict` when values differ.

### counter

Additive: `result = base + localDelta + remoteDelta`. Never conflicts.

```ts
// Base: 10, Client A: +5 = 15, Client B: +8 = 18 → Result: 23
```

### lww-per-key

LWW per object key. Union of all keys from both sides.

```ts
// A: { name: "Alice", age: 30 }, B: { name: "Alicia", bio: "eng" }
// Result: { name: "Alicia", age: 30, bio: "eng" } (B's name wins by HLC)
```

### set-add (Add-Wins)

Union by identity field. Concurrent add + remove keeps the item.

### set-remove (Remove-Wins)

Three-way merge against base. Concurrent add + remove removes the item.

### When to Use What

| Strategy      | Conflict-free  | Use case                            |
| ------------- | -------------- | ----------------------------------- |
| `lww`         | No (last wins) | Scalar fields, text, settings       |
| `counter`     | Yes            | Scores, votes, inventory levels     |
| `lww-per-key` | Per-key        | Profile objects, config maps        |
| `set-add`     | Yes            | Collaborative lists (keep all)      |
| `set-remove`  | Yes            | Collaborative lists (honor deletes) |

## Local-first: `sync` for the whole app

`sync: true` is per cell. `aio.run({ localFirst: true })` makes it the default
for **every server cell** — methods run where the caller is, instantly and
optimistically, and travel as CRDT ops. The server is unchanged as the
authority: it re-runs each op through normal dispatch, so guards, `access` and
`validate:` hooks decide exactly what they decide today, and a refused op comes
back explained (`sync.onRejected`).

```ts
await aio.run({ localFirst: true });
```

Per-cell resolution, in order:

| the cell says        | what happens                                     |
| -------------------- | ------------------------------------------------ |
| `sync: {...}`/`true` | its own config wins — localFirst never overrides |
| `sync: false`        | opt-out: keeps round-tripping through the server |
| nothing              | adopted — runs locally, syncs                    |
| `scope: "client"`    | never adopted (its state never leaves the tab)   |

**Local-first is not "free frames".** An adopted method runs locally and returns
immediately, but every call still becomes a CRDT op that is persisted and
broadcast. A 60 Hz game tick or a mousemove handler therefore puts 60 ops/second
on the wire per client — the latency is gone, the traffic is not. High-frequency
state that no other client needs belongs in a `scope: "client"` cell (never
synced, never persisted, per-tab); sync the outcome, not the frames.

Only methods-style cells are adopted (the client replays sync methods as CRDT
ops); an actions-style cell stays server-only and the boot line says so.

Flipping the switch on an app with existing persisted data is safe: the moment a
cell is adopted, its restored state is written to the sync store as a base
snapshot (sync cells stop being KV-persisted, so without that seed the first
restart after the flip would resurrect them empty).

Server-origin writes are durable too: a change that arrives as an **op** (client
method call) lands in the op-log immediately, and any **other** commit to a sync
cell — an effect, cron, `serverFn`, a server-side method call, an async method's
outcome — folds into the cell's sync snapshot (debounced 100ms, flushed on clean
shutdown). The crash-loss window is the same 100ms KV cells have; a restart
never rewinds a write the server confirmed.

Use `sync: false` wherever an optimistic preview would be a lie — an auth cell,
a payment, a ledger balance the user must not see move until the server agrees.

Boot says exactly which cells were adopted; a switch that silently relocates
every method in the app would be the worst kind of quiet decision:

```
localFirst: 3 cell(s) run locally and sync — todos, prefs, board;
server-only by opt-out: auth
```

The browser learns the decision from the page shell (it is resolved on the
server at compose time, so it cannot be read off the cell definition the way
`sync: true` can). Proven by measurement, not by config: an adopted cell's click
lands in the server op-log, and the same app without the switch produces no ops
at all (`tests/e2e-local-first.test.ts`).

**Status: opt-in.** It changes WHERE your methods run, so the default flips only
after a real local-first app reports back
([spec](../specs/2026-07-22-local-first.md)).

## Configuration

```ts
sync?: true | false | Partial<SyncConfig>   // false = opt out under localFirst

interface SyncConfig {
  merge: Record<string, MergeStrategy>;    // field → strategy
  identity: Record<string, string>;        // array field → id property
  offline: { retention: string };           // offline op retention
  onConflict?: (conflicts: SyncConflict[]) => void;
  onSync?: (stats: SyncStats) => void;
}
```

| Setting             | Default            | Description                                                                                                                                                 |
| ------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `merge`             | `{}` (all LWW)     | Per-field merge strategy                                                                                                                                    |
| `identity`          | `{}` (auto `"id"`) | Identity field for set merges                                                                                                                               |
| `offline.retention` | `"4h"`             | How long to keep offline ops — digits + `ms`/`s`/`m`/`h`/`d` (e.g. `"7d"`). A value this cannot read throws at boot rather than falling back to the default |
| `pendingCap`        | `500`              | Max unconfirmed ops before blocking                                                                                                                         |
| `maxDrift`          | `60000`            | Max clock skew (ms)                                                                                                                                         |
| `compactOps`        | `1000`             | Server compacts after N ops                                                                                                                                 |

## Sync Status

Per sync-enabled cell:

```ts
interface SyncStatus {
  status: "online" | "offline" | "syncing" | "blocked";
  pending: number; // unconfirmed op count
  lastSync: number; // timestamp of last sync
}
```

| Status    | Meaning                                |
| --------- | -------------------------------------- |
| `online`  | Connected, ops flowing                 |
| `offline` | Disconnected, ops queued locally       |
| `syncing` | Reconnection handshake in progress     |
| `blocked` | Hit 500 pending cap, cannot queue more |

## Callbacks

**onConflict** — called when a remote op collides with unconfirmed local ops:

```ts
onConflict(conflicts) {
  // conflicts: Array<{ field, local, remote, resolution }>
  // resolution: "lww" (default) or the field's configured merge strategy —
  // that strategy was already applied to your client view.
}
```

**onSync** — called after sync completes:

```ts
onSync(stats) {
  // stats: { merged: number, conflicts: number, elapsed: number }
}
```

## Persistence

Sync cells are automatically excluded from the `aio_kv` snapshot. Their state
lives in the SQLite op-log (`sync_ops`) and snapshot table (`sync_snapshots`).
Non-sync cells use `aio_kv` as before.

At boot each sync cell is rebuilt **per cell, per op**: the compaction snapshot
is loaded first, then every surviving op is folded through the composed reducer.
One cell's replay never touches another cell's restore, and the KV restore of
non-sync cells is finished before the replay starts.

### Shape changes: `version` + `onMigrate`

Every op row and every snapshot is stamped with the cell's declared `version` at
the moment it was written. At boot the stamp is compared with the version the
running build declares:

| stored vs declared      | `onMigrate` declared | what replay does                                                                  |
| ----------------------- | -------------------- | --------------------------------------------------------------------------------- |
| equal                   | —                    | applied as-is                                                                     |
| older                   | yes                  | ops fold in version order; at each version boundary `onMigrate(slice, from)` runs |
| older                   | no                   | ops **skipped**, never applied blind; snapshot kept with a `stale` warning        |
| newer (downgrade)       | —                    | ops **skipped**                                                                   |
| reducer throws on an op | —                    | the op counts as failed                                                           |

A cell with a skipped or failed op is **quarantined** — one decider, two
outcomes:

- **dev** (source run without `--prod`): boot is **refused** with an `AioError`
  naming the cell, `failed/total`, the first error and the fix. Nothing is
  written; the op-log and snapshot are intact on disk for a fixed build.
- **prod** (`--prod` or a compiled binary): the cell runs at its **last
  snapshot** (never `initialState`), `log.error` says so once, and **compaction
  and the boot seed skip the cell** — its snapshot is never rewritten and its
  ops never deleted. Writes made while quarantined are not durable across a
  restart; fix the version/hook and restart.

The quarantine exists because of a real incident (a field report, §3.1): a field
was added to a sync cell, every replayed op threw, the cell came up at its
defaults, and the next compaction wrote that emptiness into the snapshot while
deleting the ops.

Two warnings you will see before anything goes wrong:

- `sync: cell "x" has a persisted op-log and no \`version\``— declare`version:
  1` now, so the next shape change has a boundary to migrate across. Dev and
  prod both warn (a refusal would break every existing sync app).
- `migrate: sync cell "x" snapshot v1 → v2 but no onMigrate hook` — the same
  `stale` outcome the KV path reports.

Both appear in `am migrations` as `sync-unversioned` / `stale`; a quarantine
appears as `sync-quarantined`.

Rows written by an aio older than the stamp carry `-1` (unknown). They resolve
to the version stamp of the build that last persisted (`__versions` in
`aio_kv`), never to `0` — so an app that already declares `version: 3` does not
re-run its hook over current data on the first boot after upgrading.

Writing `onMigrate` for a sync cell: the hook receives the slice as it stood
**after** the ops written under `from` were folded, and must return it in the
declared shape. If the log holds ops from several older versions, the hook runs
once per boundary; the ops of the next version then fold onto the migrated
slice.

### `persist` filters on a sync cell — refused

The op-log is the durable home of a sync cell and an op **is** the method call's
payload — raw. No `persist` filter can apply to it: a value that passed through
a method payload is on disk regardless of any `exclude`, and `persist: "none"`
would restore an empty cell. So `sync: true` together with any `persist` filter
(`exclude`, `include`, `"none"`) is **refused at `cell()`**, and a
`cellDefaults.persist` filter that would land on a sync cell is refused at
`aio.run()` (`localFirst` adoption declines such a cell and says so). The error
names the cell, the fields and the three ways out: remove the filter
(`persist: "all"`), turn sync off for that cell, or keep the transient data in a
separate non-sync cell. It used to be honoured on the compaction snapshot only
and warned about — a filter kept in one of two write paths.

## Module Structure

```
src/sync/
  types.ts        — HLC, SyncOp, SyncConfig, wire types, defaults
  hlc.ts          — Hybrid Logical Clock: tick, receive, compare
  merge.ts        — 5 merge strategies
  op-buffer.ts    — Client op-log with storage abstraction
  rebase.ts       — Confirmed/optimistic reconciliation
  compact.ts      — Server-side atomic compaction
  sync-engine.ts  — Client orchestrator
  server-handler.ts — Server op/sync handler (persist, dispatch, relay)
  browser-storage.ts — localStorage OpBufferStorage (offline durability)
  mod.ts          — Public API barrel export
src/browser/
  browser-sync.ts — Auto-wires the engine on connect (the missing half)
```
