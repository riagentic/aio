# CRDT Sync Layer

Offline-first collaborative state for AIO cells. Opt-in per cell,
server-authoritative, hybrid op-log + snapshot architecture.

Sync wraps the existing dispatch loop. Sync-enabled cells stamp mutations as
operations with HLC timestamps, store them in an op-log (IndexedDB client,
SQLite server), and merge on reconnect. Non-sync cells are unaffected.

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
      // also changed. Engine semantics are rebase-LWW: your local value stays
      // visible (replayed on top) until confirmed; `remote` is the confirmed
      // value underneath. resolution is "lww".
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
   |--- __op {hlc, action} -->|--- __op (broadcast) ---->|
   |<-- __ack {serverHlc} ---|                          |
   |  (goes offline)          |                          |
   |  (queues ops locally)    |                          |
   |--- __sync {lastHlc} --->|                          |
   |<-- __sync {ops|snap} ---|                          |
```

**Dual-layer state:** Confirmed (server-acked) + Optimistic (confirmed +
unconfirmed ops replayed through reducer). UI always reads optimistic for
instant feedback.

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

## Configuration

```ts
sync?: true | Partial<SyncConfig>

interface SyncConfig {
  merge: Record<string, MergeStrategy>;    // field → strategy
  identity: Record<string, string>;        // array field → id property
  offline: { retention: string };           // offline op retention
  onConflict?: (conflicts: SyncConflict[]) => void;
  onSync?: (stats: SyncStats) => void;
}
```

| Setting             | Default            | Description                         |
| ------------------- | ------------------ | ----------------------------------- |
| `merge`             | `{}` (all LWW)     | Per-field merge strategy            |
| `identity`          | `{}` (auto `"id"`) | Identity field for set merges       |
| `offline.retention` | `"4h"`             | How long to keep offline ops        |
| `pendingCap`        | `500`              | Max unconfirmed ops before blocking |
| `maxDrift`          | `60000`            | Max clock skew (ms)                 |
| `compactOps`        | `1000`             | Server compacts after N ops         |

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

**onConflict** — called when LWW resolves different values:

```ts
onConflict(conflicts) {
  // conflicts: Array<{ field, local, remote, resolution }>
}
```

**onSync** — called after sync completes:

```ts
onSync(stats) {
  // stats: { merged: number, conflicts: number, elapsed: number }
}
```

## Persistence

Sync cells are automatically excluded from KV. Their state lives in the SQLite
op-log and snapshot tables. Non-sync cells use KV as before.

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
  mod.ts          — Public API barrel export
```
