# CRDT Internals

Wire protocol, client-side flow, server compaction, and framework integration
for the [CRDT sync layer](crdt.md).

## Hybrid Logical Clock

```ts
type HLC = [physical: number, counter: number, nodeId: string];
```

Total order: physical first, counter breaks same-ms ties, nodeId is final
tiebreaker.

- `tick()` — generate HLC for outgoing op. Counter increments on same-ms.
- `receive(remote)` — merge remote clock. Takes max of physical/counter.
- `isDriftExceeded(remote)` — rejects clock skew > 60s.

## Wire Protocol

Every frame is a v2 envelope — `{ v: 2, t: <kind>, d: <payload> }` — since
alpha29 (`src/protocol/envelope.ts`). The CRDT kinds are `op`, `sync-ack`,
`sync-req`, `sync-res` and `op-rejected`. (The v1 `__op` / `__ack` / `__sync`
string-prefixed frames are gone; a v1 peer is refused at the version handshake.)

### op (Operation)

Client→server (local action) or server→client (broadcast):

```json
{
  "v": 2,
  "t": "op",
  "d": {
    "id": "c1-00a7",
    "hlc": [1712345678901, 3, "c1"],
    "cell": "todos",
    "action": "add",
    "payload": { "text": "Buy milk" }
  }
}
```

### sync-ack (Acknowledgment)

Server→client after persisting an op:

```json
{
  "v": 2,
  "t": "sync-ack",
  "d": { "opId": "c1-00a7", "serverHlc": [1712345678950, 0, "s"] }
}
```

### op-rejected

Server→client when an optimistic op is refused (access denied, invalid shape).
The client rolls the op back out of its optimistic state:

```json
{ "v": 2, "t": "op-rejected", "d": { "opId": "c1-00a7", "reason": "denied" } }
```

### sync-req / sync-res (Reconnection)

Client→server request (unconfirmed ops + last known HLC per cell):

```json
{
  "v": 2,
  "t": "sync-req",
  "d": {
    "clientId": "c1",
    "cells": { "todos": { "lastHlc": [1712345600000, 1, "c1"] } },
    "pendingOps": []
  }
}
```

Server→client incremental response:

```json
{
  "v": 2,
  "t": "sync-res",
  "d": {
    "mode": "incremental",
    "ops": [],
    "rebase": [],
    "lowWater": [1712340000000, 0, "s"]
  }
}
```

Server→client snapshot fallback (when ops have been compacted away):

```json
{
  "v": 2,
  "t": "sync-res",
  "d": {
    "mode": "snapshot",
    "snapshot": { "todos": { "items": [], "filter": "all" } },
    "ops": [],
    "lowWater": [1712340000000, 0, "s"]
  }
}
```

## Client-Side Flow

**Local action:**

1. `clock.tick()` → stamp HLC
2. Generate op ID `clientId-counter`
3. Add to op-buffer (rejected if >= 500 pending → status "blocked")
4. Rebase: replay all unconfirmed ops on confirmed state
5. Update optimistic state (UI sees instant result)
6. Send an `op` frame to the server if online

**Server ack:**

1. Merge server HLC into local clock
2. Mark op confirmed in buffer
3. Rebase (fewer unconfirmed ops now)

**Remote op:**

1. Merge remote HLC into local clock
2. Apply op to confirmed state via reducer
3. Rebase unconfirmed ops on new confirmed state
4. Update optimistic state

**Reconnect:**

1. Send a `sync-req` frame with `lastHlc` per cell + unconfirmed ops
2. Server responds incremental (ops since lastHlc) or snapshot (full state)
3. Apply to confirmed state, rebase, update optimistic

Snapshot fallback triggers when `lastHlc < lowWater` (ops compacted) or > 500
pending.

## Server-Side Compaction

Prevents unbounded op-log growth. Triggers when op count > 1000.

**Atomic SQLite transaction:**

1. UPSERT snapshot with current cell state (version++)
2. DELETE ops with HLC below cutoff
3. UPDATE metadata with new low-water mark

**Schema:**

```sql
CREATE TABLE sync_ops (
  id TEXT PRIMARY KEY, cell TEXT NOT NULL,
  action TEXT NOT NULL, payload TEXT NOT NULL,
  hlc_phys INTEGER NOT NULL, hlc_cnt INTEGER NOT NULL,
  hlc_node TEXT NOT NULL, server_ts INTEGER NOT NULL
);
CREATE INDEX idx_sync_ops_feat_hlc
  ON sync_ops(cell, hlc_phys, hlc_cnt, hlc_node);

CREATE TABLE sync_snapshots (
  cell TEXT PRIMARY KEY, version INTEGER NOT NULL,
  state TEXT NOT NULL,
  hlc_phys INTEGER NOT NULL, hlc_cnt INTEGER NOT NULL,
  hlc_node TEXT NOT NULL
);

CREATE TABLE sync_meta (
  cell TEXT PRIMARY KEY, low_water TEXT NOT NULL,
  last_compact INTEGER NOT NULL, op_count INTEGER NOT NULL
);
```

## Op Buffer

Client-side op-log with pluggable storage (localStorage in browser, in-memory in
tests).

```ts
interface OpBuffer {
  add(op: SyncOp): Promise<boolean>; // false if cap hit
  confirm(cell, opId, serverHlc): Promise<void>;
  getUnconfirmed(cell): Promise<SyncOp[]>;
  pruneConfirmed(cell): Promise<void>;
  getMeta(cell): Promise<{ lastHlc: HLC | null } | undefined>;
  saveSnapshot(cell, { state, hlc }): Promise<void>;
  loadSnapshot(cell): Promise<{ state; hlc } | undefined>;
  clear(cell): Promise<void>;
}
```

## Rebase Engine

Replays unconfirmed ops through the cell reducer on top of confirmed state:

```ts
rebase(confirmed, unconfirmed, reducer) → { optimistic, dropped, surviving }
```

Ops returning `null` from the reducer are dropped (became invalid after server
state changed).

## Framework Integration

| File             | What it does                                                        |
| ---------------- | ------------------------------------------------------------------- |
| `cell-create.ts` | Parses `sync` option, calls `normalizeSyncConfig()`                 |
| `cell-types.ts`  | Stores `syncConfig` on `CellAio`                                    |
| `state-core.ts`  | `setSyncHandler()` hook intercepts sync actions in `send()`         |
| `server.ts`      | `syncHandler` in `ServerConfig` routes `op`/`sync-req` frames       |
| `persistence.ts` | `syncCells` set auto-excludes sync cells from the `aio_kv` snapshot |
| `aio.ts`         | Collects `_syncCellIds`, initializes sync SQLite tables             |
| `config.ts`      | `_syncCellIds` registered in valid config keys                      |

## Sync Engine Dependencies

```ts
interface SyncEngineDeps {
  clientId: string;
  cells: Record<string, SyncConfig>;
  buffer: OpBuffer;
  send: (msg: string) => void;
  reducer: SyncReducer;
  getConfirmedState: () => Record<string, Record<string, unknown>>;
  setConfirmedState: (cell: string, state: Record<string, unknown>) => void;
  onStateUpdate: (cell: string, optimistic: Record<string, unknown>) => void;
}
```
