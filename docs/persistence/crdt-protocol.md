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
- `receive(remote)` — merge remote clock. Takes max of physical/counter. A
  remote whose counter is not a safe integer in `[0, 2^31]` (or whose physical
  time is not finite) is not followed: past 2^53 `counter++` stops advancing,
  and every HLC the node issued would be identical.
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
  "d": {
    "cell": "todos",
    "opId": "c1-00a7",
    "serverHlc": [1712345678950, 0, "s"],
    "serverTs": 1712345678950
  }
}
```

`serverTs` is the op's position in the server's monotonic cursor. The client
compares it with the cursor of the last **snapshot** it installed for that cell
(`sync-res` → `lastServerTs[cell]`): a snapshot IS the server's live state, so
it already contains every op at or below that cursor. Without the comparison, an
ack arriving _after_ a snapshot re-applied its op to confirmed state and the
client diverged by one application. It is optional — omitted when the server
re-acks a duplicate, and absent from a pre-alpha43 server — and its absence
simply means "apply as before".

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
    "lowWater": [1712340000000, 0, "s"],
    "reset": ["todos"]
  }
}
```

`reset` (optional) names the cells whose request cursor this server never issued
— it sat above the op-log's high-water mark, so the client synced with a
different history (a restored backup, a wiped data dir, another app on the same
address). For those cells the client adopts the snapshot and the server's cursor
as-is, bypassing its never-regress rule, and keeps its unsent ops (they were
re-sent as `pendingOps` and are acked by this server). Both sides log it once.

**Pushed server write.** A write to a sync cell that is not a sync op — an
effect, cron, a `serverFn`, `am dispatch`, an async method's commit — produces
no op for a client to fold, so the server pushes it to every connection as a
`sync-res` nobody asked for. It settles on a 100ms debounce with a 500ms max
wait (a cell written faster than every 100ms still settles), right after the
write is compacted into the cell's snapshot. It travels as a patch against the
state the server last pushed:

```json
{
  "v": 2,
  "t": "sync-res",
  "d": {
    "mode": "push",
    "push": true,
    "reqId": 0,
    "ops": [],
    "lowWater": {},
    "patch": {
      "board": {
        "ts": 1712345679001,
        "set": [{ "p": ["price"], "v": 42 }],
        "digest": "0f3a9c1e7b2d44"
      }
    }
  }
}
```

`set` holds path operations: `{ p, v }` sets a value, `{ p, d: 1 }` deletes an
object key, `{ p, n }` resizes an array (followed by a `v` for each new index).
`ts` is the position the state was captured at, under the cell's lock — the same
watermark a catch-up snapshot carries, so an ack or a held op at or below it is
already inside. The client applies `set` to its confirmed state and installs the
result only when it digests to `digest` (a hash of the state's canonical JSON,
`src/sync/state-patch.ts`); otherwise it keeps its state and asks for the cell
with `resync`. That happens when an op folded since the last push gives a
different result without the write (an op set a field the write set back, or
computed from the field the write changed). Held behind an outstanding catch-up
like any other frame and folded in position; its cursor, catch-up gate and
`onSync` stay untouched.

A patch bigger than half the cell's state (the same rule as the state stream),
the first push of a cell no client has synced yet, and a state the diff cannot
walk go out whole instead:

```json
{
  "v": 2,
  "t": "sync-res",
  "d": {
    "mode": "snapshot",
    "push": true,
    "reqId": 0,
    "snapshot": { "board": { "notes": ["from-cli"] } },
    "ops": [],
    "lowWater": {},
    "lastServerTs": { "board": 1712345679001 }
  }
}
```

`reqId: 0` keeps a client built before `push` from taking either for the answer
to its own catch-up. A patch never carries `lastServerTs`: a client built before
`mode: "push"` would save it as its cursor without applying the write. Such a
client does not send `pushPatch: true` in its `sync-req`, and the server sends
its socket the whole-cell frame beside every patch.

**`resync`** (optional, on `sync-req`) names cells the client wants served as a
snapshot whatever its cursor says. The engine sends it after it catches a sync
method that does not return the same state twice (see
[Methods must be deterministic](crdt.md#methods-must-be-deterministic)), and
after a pushed patch that does not reproduce the server's state.

**`pushPatch`** (on `sync-req`) says the engine folds a pushed server write sent
as a patch (above). Absent, the server sends that socket whole cells.

**Slices.** `pendingOps` carries at most ~250 KB of ops per request — or a
quarter of the server's frame limit when that is lower, which the WebSocket
server advertises in its `proto` hello as `maxMessageBytes` beside `rate`. When
more is queued, the next slice goes out when the response to this one has landed
(paced at ~1 MB/s), and ops made meanwhile wait behind the older ones. The
server drops an inbound frame over `wsLimits.maxMessageBytes` (1 MB by default)
unread, so a whole large queue in one request was never delivered at all.

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

1. Send a `sync-req` frame with `lastHlc` per cell + unconfirmed ops (in slices
   — see above)
2. Server responds incremental (ops since lastHlc) or snapshot (full state)
3. Apply to confirmed state, rebase, update optimistic

Snapshot fallback triggers when `lastHlc < lowWater` (ops compacted), when the
client's `server_ts` cursor sits below the compaction boundary, when it sits
ABOVE the log's high-water mark (a cursor from another history — see `reset`),
or > 500 pending.

## Server-Side Compaction

Prevents unbounded op-log growth. Triggers when a cell's op count reaches
`compactOps` (default 1000).

The boundary is a `server_ts` position issued at compaction time, under the same
per-cell lock persist and dispatch hold — so every op already applied (i.e. in
the snapshot) sits at or below it, and every later op above it.

**Atomic SQLite transaction:**

1. Tombstone the ids about to be deleted into `sync_compacted_ids` (with their
   `server_ts`), so a resend after a lost ack is still recognised as a duplicate
2. UPSERT the snapshot with the current cell state (`version`++, the cell's
   shape `cell_version`)
3. DELETE ops with `server_ts` at or below the boundary
4. DELETE tombstones older than the retention window (24 h, or the cell's
   `offline.retention` when longer)
5. UPSERT `sync_meta`: the new low-water HLC, `last_compact`, the recounted
   `op_count`, and `compacted_ts` (the boundary)

**Schema** (`SYNC_SCHEMA` in `src/sync/compact.ts`):

```sql
CREATE TABLE sync_ops (
  id TEXT PRIMARY KEY, cell TEXT NOT NULL, action TEXT NOT NULL,
  payload TEXT NOT NULL, hlc_phys INTEGER NOT NULL, hlc_cnt INTEGER NOT NULL,
  hlc_node TEXT NOT NULL, server_ts INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT -1
);
CREATE INDEX idx_sync_ops_cell_hlc
  ON sync_ops(cell, hlc_phys, hlc_cnt, hlc_node);
CREATE INDEX idx_sync_ops_cell_ts ON sync_ops(cell, server_ts);
CREATE INDEX idx_sync_ops_ts ON sync_ops(server_ts);

CREATE TABLE sync_snapshots (
  cell TEXT PRIMARY KEY, version INTEGER NOT NULL, state TEXT NOT NULL,
  hlc_phys INTEGER NOT NULL, hlc_cnt INTEGER NOT NULL, hlc_node TEXT NOT NULL,
  cell_version INTEGER NOT NULL DEFAULT -1
);

CREATE TABLE sync_meta (
  cell TEXT PRIMARY KEY, low_water TEXT NOT NULL,
  last_compact INTEGER NOT NULL, op_count INTEGER NOT NULL,
  compacted_ts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sync_compacted_ids (
  id TEXT PRIMARY KEY, compacted_at INTEGER NOT NULL,
  server_ts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sync_compacted_at ON sync_compacted_ids(compacted_at);
```

Every statement is `CREATE … IF NOT EXISTS`. `sync_ops.version` and
`sync_snapshots.cell_version` are the cell shape `version` a row was written
under; `-1` marks a row that predates the stamp, resolved at boot from the KV
version stamp. A database created by an earlier aio gains the newer columns
through `SYNC_MIGRATIONS` (`ALTER TABLE … ADD COLUMN`), applied on every boot;
any failure other than "duplicate column" stops the boot.

## Op Buffer

Client-side op-log with pluggable storage (localStorage in browser, in-memory in
tests).

```ts
interface OpBuffer {
  add(op: SyncOp): Promise<boolean>; // false if cap hit
  confirm(cell, opId, serverHlc): Promise<void>;
  getUnconfirmed(cell): Promise<SyncOp[]>;
  pruneConfirmed(cell): Promise<void>;
  pruneStale(cell, opId): Promise<void>; // drop one op (rejection rollback)
  dropStale?(cell, opId): Promise<void>; // …and report it through onDrop
  getMeta(cell): Promise<{ lastHlc: HLC | null; lastServerTs?: number } | undefined>;
  saveMeta(cell, { lastHlc, lastServerTs? }): Promise<void>;
  saveSnapshot(cell, { state, hlc, serverTs? }): Promise<void>;
  loadSnapshot(cell): Promise<{ state; hlc; serverTs? } | undefined>;
  clear(cell): Promise<void>;
}
```

## Rebase Engine

Replays unconfirmed ops through the cell reducer on top of confirmed state:

```ts
rebase(confirmed, unconfirmed, reducer) → { optimistic, dropped, notApplied, surviving }
```

Ops returning `null` from the reducer are dropped (became invalid after server
state changed). `notApplied` is the subset of `dropped` the reducer could not
replay at all — it threw (`"failed"`) or returned `undefined` — which is
reported rather than folded away silently.

## Framework Integration

| File             | What it does                                                              |
| ---------------- | ------------------------------------------------------------------------- |
| `cell-create.ts` | Parses `sync` option, calls `normalizeSyncConfig()`                       |
| `cell-types.ts`  | Stores `syncConfig` on `CellAio`                                          |
| `state-core.ts`  | `setSyncHandler()` hook intercepts sync actions in `send()`               |
| `server.ts`      | `syncHandler` in the internal server config routes `op`/`sync-req` frames |
| `persistence.ts` | `syncCells` set auto-excludes sync cells from the `aio_kv` snapshot       |
| `aio.ts`         | Collects `_syncCellIds`, initializes sync SQLite tables                   |
| `config.ts`      | `_syncCellIds` registered in valid config keys                            |

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
