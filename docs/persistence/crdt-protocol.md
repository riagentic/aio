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

Three message types over WebSocket:

### __op (Operation)

Client→server (local action) or server→client (broadcast):

```json
{
  "__op": {
    "id": "c1-00a7",
    "hlc": [1712345678901, 3, "c1"],
    "feature": "todos",
    "action": "add",
    "payload": { "text": "Buy milk" }
  }
}
```

### __ack (Acknowledgment)

Server→client after persisting an op:

```json
{ "__ack": { "opId": "c1-00a7", "serverHlc": [1712345678950, 0, "s"] } }
```

### __sync (Reconnection)

Client→server request (includes unconfirmed ops and last known HLC):

```json
{
  "__sync": {
    "clientId": "c1",
    "features": { "todos": { "lastHlc": [1712345600000, 1, "c1"] } },
    "pendingOps": []
  }
}
```

Server→client incremental response:

```json
{
  "__sync": {
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
  "__sync": {
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
6. Send `__op` to server if online

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

1. Send `__sync` with `lastHlc` per feature + unconfirmed ops
2. Server responds incremental (ops since lastHlc) or snapshot (full state)
3. Apply to confirmed state, rebase, update optimistic

Snapshot fallback triggers when `lastHlc < lowWater` (ops compacted) or > 500
pending.

## Server-Side Compaction

Prevents unbounded op-log growth. Triggers when op count > 1000.

**Atomic SQLite transaction:**

1. UPSERT snapshot with current feature state (version++)
2. DELETE ops with HLC below cutoff
3. UPDATE metadata with new low-water mark

**Schema:**

```sql
CREATE TABLE sync_ops (
  id TEXT PRIMARY KEY, feature TEXT NOT NULL,
  action TEXT NOT NULL, payload TEXT NOT NULL,
  hlc_phys INTEGER NOT NULL, hlc_cnt INTEGER NOT NULL,
  hlc_node TEXT NOT NULL, server_ts INTEGER NOT NULL
);
CREATE INDEX idx_sync_ops_feat_hlc
  ON sync_ops(feature, hlc_phys, hlc_cnt, hlc_node);

CREATE TABLE sync_snapshots (
  feature TEXT PRIMARY KEY, version INTEGER NOT NULL,
  state TEXT NOT NULL,
  hlc_phys INTEGER NOT NULL, hlc_cnt INTEGER NOT NULL,
  hlc_node TEXT NOT NULL
);

CREATE TABLE sync_meta (
  feature TEXT PRIMARY KEY, low_water TEXT NOT NULL,
  last_compact INTEGER NOT NULL, op_count INTEGER NOT NULL
);
```

## Op Buffer

Client-side op-log with pluggable storage (IndexedDB in browser, in-memory in
tests).

```ts
interface OpBuffer {
  add(op: SyncOp): Promise<boolean>; // false if cap hit
  confirm(feature, opId, serverHlc): Promise<void>;
  getUnconfirmed(feature): Promise<SyncOp[]>;
  pruneConfirmed(feature): Promise<void>;
  getMeta(feature): Promise<{ lastHlc: HLC | null } | undefined>;
  saveSnapshot(feature, { state, hlc }): Promise<void>;
  loadSnapshot(feature): Promise<{ state; hlc } | undefined>;
  clear(feature): Promise<void>;
}
```

## Rebase Engine

Replays unconfirmed ops through the feature reducer on top of confirmed state:

```ts
rebase(confirmed, unconfirmed, reducer) → { optimistic, dropped, surviving }
```

Ops returning `null` from the reducer are dropped (became invalid after server
state changed).

## Framework Integration

| File                | What it does                                                    |
| ------------------- | --------------------------------------------------------------- |
| `feature-create.ts` | Parses `sync` option, calls `normalizeSyncConfig()`             |
| `feature-types.ts`  | Stores `syncConfig` on `FeatureAio`                             |
| `state-core.ts`     | `setSyncHandler()` hook intercepts sync actions in `send()`     |
| `server.ts`         | `syncHandler` in `ServerConfig` routes `__op`/`__sync` messages |
| `persistence.ts`    | `syncFeatures` set auto-excludes sync features from KV          |
| `aio.ts`            | Collects `_syncFeatureIds`, initializes sync SQLite tables      |
| `config.ts`         | `_syncFeatureIds` registered in valid config keys               |

## Sync Engine Dependencies

```ts
interface SyncEngineDeps {
  clientId: string;
  features: Record<string, SyncConfig>;
  buffer: OpBuffer;
  send: (msg: string) => void;
  reducer: SyncReducer;
  getConfirmedState: () => Record<string, Record<string, unknown>>;
  setConfirmedState: (feature: string, state: Record<string, unknown>) => void;
  onStateUpdate: (feature: string, optimistic: Record<string, unknown>) => void;
}
```
