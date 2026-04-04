# CRDT Sync Layer — Design Spec

Offline-first, server-authoritative CRDT sync for AIO features. Hybrid op-log +
snapshot architecture. Opt-in per feature, zero overhead for non-sync features.

## Goals

- Multi-user collaboration: concurrent edits merge correctly on reconnect
- Multi-device: same user across laptop/phone/desktop stays in sync
- Hours of offline by default, days+ opt-in
- Server is the single source of truth — no P2P
- Extend AIO's existing infrastructure, don't replace it
- Zero API change for non-sync features

## Non-Goals

- Peer-to-peer sync (all sync goes through server)
- Rich text CRDT (extensible for later, not in scope)
- Ordered list CRDT (collections are unordered sets, sort by field)

---

## 1. Developer API

### Minimal opt-in

```ts
feature('todos', {
  state: { items: [], filter: 'all' },
  sync: true,  // LWW on everything, 4h retention
  methods: {
    add(s, text: string) { s.items.push({ id: uid(), text, done: false }); },
    toggle(s, id: string) { /* ... */ },
  },
});
```

### Full control

```ts
feature('inventory', {
  state: { stock: {}, items: [] },
  sync: {
    merge: { stock: 'lww-per-key' },
    identity: { items: 'sku' },
    offline: { retention: '7d' },
    onConflict(conflicts) { /* review destructive conflicts */ },
    onSync(stats) { /* { merged, conflicts, elapsed } */ },
  },
  methods: { /* ... */ },
});
```

### Sync config expansion

`sync: true` expands to:

```ts
sync: {
  merge: {},                    // all fields LWW
  identity: {},                 // auto-detect 'id' on array items
  offline: { retention: '4h' }, // medium retention
  onConflict: undefined,        // silent merge
  onSync: undefined,            // no notification
}
```

### Merge strategies

| Strategy | Behavior | Conflict-free? |
|----------|----------|----------------|
| `lww` | Last-write-wins by HLC (default) | No — loser's write dropped |
| `counter` | Additive merge (+3 and +5 → +8) | Yes |
| `lww-per-key` | Each map key merges independently via LWW | No per key |
| `set-add` | Add-wins set (concurrent add + remove → kept) | Yes |
| `set-remove` | Remove-wins set (concurrent add + remove → gone) | Yes |

`onConflict` only fires for non-conflict-free strategies (LWW fields where
two clients wrote different values). Counter and set merges never conflict.

### Collection handling

- Array of objects with `id` field → automatically treated as set
- Custom identity field via `sync.identity: { items: 'sku' }`
- Plain arrays (strings, numbers) → positional LWW
- Collections are **unordered sets** — use sort-by-field for ordering

### Sync status signal

Available via `useFeature(ref)` for sync-enabled features:

```ts
sync: {
  status: 'online' | 'offline' | 'syncing' | 'blocked',
  pending: number,    // unconfirmed op count
  lastSync: number,   // timestamp of last successful sync
}
```

`blocked` = hit 500 unconfirmed cap. UI should indicate read-only state.
Respects existing `showStatus` config for the transport-level overlay.

---

## 2. Architecture

### Dispatch pipeline integration

```
CLIENT:
  user action → feature.method()
    → stamp operation { op, hlc, clientId, featureId }
    → apply optimistically to local state
    → append to local op-log (IndexedDB)
    → send __op to server (or queue if offline)

SERVER:
  receive __op from client
    → validate (sync-enabled? clock drift < 60s?)
    → merge HLC: serverHlc.receive(op.hlc)
    → feed into existing dispatch loop (reduce → execute)
    → afterAction hook: append to sync_ops (SQLite)
    → broadcast __op to all other clients
    → send __ack to originating client
```

### Key principles

- **CRDT wraps dispatch, doesn't replace it.** Ops go in, actions come out.
  The reduce/execute/broadcast internals are untouched.
- **Non-sync features see zero overhead.** No clocks, no op-log, no merge.
- **Server is authority.** Client applies optimistically, server confirms.
- **Existing reconnect path preserved.** Steps 1-5 of browser.ts reconnect
  flow are identical. Steps 6+ become CRDT sync instead of naive replay.

### Routing split

Single decision point in `state-core.ts send()`:

```
send(action):
  if isSyncFeature(action.type) → sync-engine handles it
  else → existing _send() path (unchanged)
```

---

## 3. Wire Protocol

### New message types

Extend existing AIO protocol alongside `__resync`, `__subs`, `__vitals`.

**Client → Server:**

```json
// Operation (normal)
{ "__op": {
    "id": "c1-00a7",
    "hlc": [1712345678901, 3, "c1"],
    "feature": "todos",
    "action": "add",
    "payload": { "text": "Buy milk" }
}}

// Sync request (reconnect)
{ "__sync": {
    "clientId": "c1",
    "features": {
      "todos": { "lastHlc": [1712345600000, 1, "c1"] }
    },
    "pendingOps": [ /* unconfirmed ops, max 500 */ ]
}}
```

**Server → Client:**

```json
// Confirm (op accepted)
{ "__ack": {
    "opId": "c1-00a7",
    "serverHlc": [1712345678950, 0, "s"]
}}

// Broadcast (op from another client)
{ "__op": {
    "id": "c2-00b3",
    "hlc": [1712345679000, 0, "s"],
    "feature": "todos",
    "action": "add",
    "payload": { "text": "Buy eggs" }
}}

// Sync response
{ "__sync": {
    "mode": "incremental",
    "ops": [ /* missed ops */ ],
    "rebase": [ /* corrected pending ops */ ],
    "lowWater": [1712340000000, 0, "s"]
}}

// Snapshot fallback
{ "__sync": {
    "mode": "snapshot",
    "snapshot": { "todos": { "items": [], "filter": "all" } },
    "ops": [ /* ops since snapshot */ ],
    "lowWater": [1712340000000, 0, "s"]
}}
```

### HLC structure

`[physical, counter, nodeId]`

- **physical**: `max(local_time, last_seen)` — monotonic wall clock
- **counter**: disambiguates same-millisecond ops, resets on physical tick
- **nodeId**: client or server ID, final tiebreaker

**Clock drift guard:** Server rejects ops where
`|op.physical - server.now| > 60s`. Client must correct before retrying.

### Pending ops cap

If client has > 500 unconfirmed ops, the `__sync` request triggers snapshot
mode regardless of low-water mark. Prevents unbounded merge on reconnect.

---

## 4. Reconnection Flow

```
Client reconnects → sends __sync { lastHlc per feature, pendingOps }
  ↓
Server checks: is client.lastHlc >= lowWaterMark?
  ├── YES → incremental
  │   1. Collect missed ops since client.lastHlc
  │   2. Merge client's pending ops (conflict resolve)
  │   3. Send missed ops + ack/rebase for pending
  │   4. Client replays missed ops, rebases unconfirmed
  │
  └── NO → snapshot fallback
      1. Send latest snapshot + ops since snapshot
      2. Client replaces local state entirely
      3. Client's pending ops re-evaluated against new state
      4. Valid pending ops re-submitted as new ops
```

**Sync-level retry:** If no `__sync` response received within 10s, re-send
the request once. If second attempt also fails, fall back to `__resync`
(existing full-state recovery). Uses existing reconnection backoff for
transport-level failures (1s → 8s exponential with jitter).

Rebase is **atomic from UI perspective** — wrapped in `batch()` from
`signal.ts`. One state update, one re-render. No intermediate flicker.

Rebase replays unconfirmed ops **through the feature's reducer** — machine
guards and validation still run. Invalid ops after rebase are dropped.

---

## 5. Client-Side Engine

### Queue unification

AIO currently has three offline queues:

- `state-core.ts:87` — `_offlineQueue` (in-memory, max 100)
- `browser-protocol.ts:174` — IndexedDB `__aio_offline` (max 1000)
- `browser.ts` / `browser-air.ts` — in-memory copies

CRDT replaces all three with a **unified op-buffer** for sync-enabled
features. Non-sync features keep the existing `send()` path unchanged.

**IDB migration:** On first load, if `__aio_offline` exists, drain it
(replay all actions), delete old DB, then open `__aio_sync`.

### Module structure

```
src/sync/
├── hlc.ts          (~40 lines) — hybrid logical clock
├── op-buffer.ts    (~80 lines) — IndexedDB op log
├── rebase.ts       (~60 lines) — confirmed/optimistic reconciliation
├── sync-engine.ts  (~80 lines) — orchestrator, wire protocol
├── merge.ts        (~60 lines) — merge strategies
├── compact.ts      (~40 lines) — server op-log compaction
└── types.ts        (~40 lines) — shared types
```

~400 lines total. No file exceeds 200 lines.

### Four components

**1. HLC Clock** (`hlc.ts`)
- `tick()` — generate HLC for outgoing op
- `receive(remoteHlc)` — merge remote clock on incoming op/ack
- `now()` — current HLC without advancing
- Persisted to IndexedDB `aio_sync_meta` (survives page reload)

**2. Op Buffer** (`op-buffer.ts`)
- Replaces all three existing offline queues for sync features
- Each op: `{ id, feature, action, payload, hlc, confirmed }`
- On server `__ack`: flip `confirmed: true`, update `lastConfirmedHlc`
- Prune confirmed ops after local snapshot covers them
- **Cap: 500 unconfirmed ops** — beyond that, feature enters `blocked` status
- IndexedDB stores: `ops`, `meta`, `snapshots` in `__aio_sync` database

**3. State Ledger** (in `rebase.ts`)
- Dual-layer in-memory state:
  - `confirmed` — last known server-confirmed state
  - `optimistic` — confirmed + unconfirmed ops applied on top
- UI reads from `optimistic` (instant feedback)
- `confirmed` updates on server ack/broadcast
- `optimistic` recomputed when confirmed changes

**4. Sync Engine** (`sync-engine.ts`)
- Orchestrates clock, buffer, rebase, and transport
- Routes `__op`, `__ack`, `__sync` messages
- Manages reconnection handshake
- Exposes `sync` status signal per feature

### Boot sequence (page reload)

1. Open `__aio_sync` IndexedDB
2. Load last snapshot from `snapshots` store
3. Load unconfirmed ops from `ops` store
4. Replay unconfirmed through feature reducer → build optimistic state
5. Ready — UI renders optimistic state immediately
6. On connect, send `__sync` to reconcile with server

### Error handling

- **IndexedDB write failure:** Op still sent to server if online, flagged
  as non-durable. If also offline → op is lost. Emit error event.
  Documented as the one data-loss scenario.
- **IndexedDB read failure:** Send `__sync` with `lastHlc: null` → forces
  snapshot mode. Graceful recovery, no crash.
- **Corrupted op-log:** Same as read failure — snapshot fallback.

---

## 6. Server-Side Integration

### SQLite tables

Created in `aio.run()` when any feature has `sync: true`:

```sql
CREATE TABLE sync_ops (
  id        TEXT PRIMARY KEY,
  feature   TEXT NOT NULL,
  action    TEXT NOT NULL,
  payload   TEXT NOT NULL,
  hlc_phys  INTEGER NOT NULL,
  hlc_cnt   INTEGER NOT NULL,
  hlc_node  TEXT NOT NULL,
  server_ts INTEGER NOT NULL
);
CREATE INDEX idx_sync_ops_feat_hlc
  ON sync_ops(feature, hlc_phys, hlc_cnt, hlc_node);

CREATE TABLE sync_snapshots (
  feature  TEXT PRIMARY KEY,
  version  INTEGER NOT NULL,
  state    TEXT NOT NULL,
  hlc_phys INTEGER NOT NULL,
  hlc_cnt  INTEGER NOT NULL,
  hlc_node TEXT NOT NULL
);

CREATE TABLE sync_meta (
  feature      TEXT PRIMARY KEY,
  low_water    TEXT NOT NULL,
  last_compact INTEGER NOT NULL,
  op_count     INTEGER NOT NULL
);
```

### Op receive flow

1. Validate: is feature sync-enabled? Reject if not.
2. Clock drift check: `|op.hlc_phys - Date.now()| > 60s` → reject.
3. **Duplicate check:** `INSERT OR IGNORE` on `sync_ops.id` — if op already
   exists, skip dispatch and send `__ack` (idempotent). Handles network retries.
4. Merge server HLC: `serverHlc.receive(op.hlc)`.
5. Feed action into existing dispatch loop.
6. `afterAction` hook: append to `sync_ops` (async, via db worker).
7. Broadcast `__op` to all other clients.
8. Send `__ack` to originating client with server HLC.

### Compaction

Triggered by existing `schedule.ts` interval system:

```
Trigger: op_count > 1000 OR 1 hour since last_compact

1. Read current feature state from dispatch getState()
2. BEGIN TRANSACTION
   a. UPSERT sync_snapshots (feature, version++, state, hlc)
   b. DELETE FROM sync_ops WHERE feature = ? AND hlc < cutoff
   c. UPDATE sync_meta (low_water = cutoff, op_count = remaining)
   COMMIT
3. Log: { event: "compaction", feature, ops_removed, new_low_water }
```

Atomic — crash mid-compaction retains old snapshot + full log. Wall's
requirement satisfied.

**Snapshot fallback logging:** Every snapshot fallback logged with client's
lastHlc and current low_water for operational monitoring.

### Persistence split

- **Non-sync features:** dispatch → persist via KV (existing `persistence.ts`)
- **Sync features:** dispatch → `afterAction` → `sync_ops` (SQLite).
  Framework auto-excludes sync features from KV — when `sync` is set on a
  feature, `persistence.ts` skips it automatically. No manual `persist.exclude`
  needed.

### Existing code changes

```
EXTEND (~105 lines across existing files):
├── server.ts          — __op, __sync, __ack handlers (~60 lines)
├── aio.ts             — sync table init, afterAction hook (~30 lines)
├── persistence.ts     — auto-exclude sync features from KV (~5 lines)
└── schedule.ts        — register compaction interval (~10 lines)

REUSE (zero changes):
├── dispatch.ts        — dispatch loop, afterAction hook
├── server.ts broadcast() — broadcast __op reuses existing path
├── db/async-db.ts     — SQLite worker for sync_ops queries
├── patch-compact.ts   — unchanged, still used for non-sync features
├── signal.ts batch()  — atomic UI updates during rebase
├── config.ts          — syncIntervalMs, backpressure respected
└── adapters/          — useConnected() unchanged
```

---

## 7. Retention Policies

### Default (medium — 4h)

- Server: compact after 1000 ops or 1h
- Server: retain ops for 4h past compaction
- Client: prune confirmed ops after snapshot
- Client: IndexedDB cap ~5MB per feature

### Extended (opt-in)

- Server: compact after 5000 ops or 6h
- Server: retain ops for configured duration
- Client: IndexedDB cap ~50MB per feature
- Client: local snapshot on every confirmed batch

### Config

```ts
// New config options in aio.run()
sync?: {
  compactOps?: number;      // default: 1000
  compactInterval?: string; // default: '1h'
  maxDrift?: number;        // default: 60000 (ms)
  pendingCap?: number;      // default: 500
}
```

---

## 8. Testing Strategy

### Unit tests (per module, no I/O)

```
sync/hlc.test.ts       — tick, receive, merge, drift detection
sync/merge.test.ts     — lww, counter, lww-per-key, set-add, set-remove
sync/rebase.test.ts    — confirmed/optimistic reconciliation, invalid op drop
sync/op-buffer.test.ts — add/confirm/prune/cap (IDB mocked)
sync/compact.test.ts   — snapshot generation, atomic transaction
```

### Integration tests (multi-client simulation)

```
sync/integration/concurrent-edit.test.ts
  — Two clients edit same field offline → reconnect → converge
  — Two clients add to same collection → reconnect → union
  — Client A edits, Client B deletes → resolve per strategy

sync/integration/reconnect.test.ts
  — Short offline → incremental sync
  — Long offline past compaction → snapshot fallback
  — >500 pending → forced snapshot
  — Corrupted IDB → graceful snapshot fallback

sync/integration/compaction.test.ts
  — Compact while client offline → snapshot path on reconnect
  — Crash mid-compaction → old state retained
  — Concurrent compaction + incoming op → no data loss
```

### Property-based tests (CRDT correctness)

```
sync/properties/convergence.test.ts
  — N clients, random ops, random partitions → all converge
  — Commutativity: any op order → same result
  — Idempotency: same op twice → no change
  — Associativity: (a merge b) merge c === a merge (b merge c)
  — Stress: 10 clients × 1000 ops × random disconnect/reconnect → converge
```

### What we don't test

- No browser/Electron WebSocket tests
- IndexedDB mocked via in-memory adapter
- All tests run with `deno test`

---

## 9. File Map

### New files (~400 lines total)

```
src/sync/
├── hlc.ts          (~40 lines) — hybrid logical clock
├── op-buffer.ts    (~80 lines) — IndexedDB op log (replaces 3 queues)
├── rebase.ts       (~60 lines) — confirmed/optimistic state reconciliation
├── sync-engine.ts  (~80 lines) — orchestrator, wire protocol
├── merge.ts        (~60 lines) — merge strategies (lww, counter, set)
├── compact.ts      (~40 lines) — server op-log compaction
└── types.ts        (~40 lines) — shared CRDT types
```

### Modified files (~105 lines of changes)

```
src/server.ts       — __op, __sync, __ack message handlers
src/aio.ts          — sync table init, afterAction hook, sync config
src/state-core.ts   — send() routing split (sync vs non-sync)
src/persistence.ts  — auto-exclude sync features from KV
src/schedule.ts     — register compaction interval
```

### Replaced code (net reduction)

```
src/state-core.ts      _offlineQueue (for sync features)  ─┐
src/browser-protocol.ts __aio_offline IDB queue            ├→ sync/op-buffer.ts
src/browser.ts          _offlineQueue in-memory copy       │
src/browser-air.ts      _queue in-memory                   ─┘
```

Non-sync features retain the existing queue paths unchanged.
