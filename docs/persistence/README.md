# Persistence & Data

How AIO stores, syncs, and transports state.

## Storage

- [Auto-Persist](auto-persist.md) — Deno.Kv automatic state persistence
- [SQLite](sqlite.md) — schema, queries, transactions, WAL

## Sync

- [CRDT](crdt.md) — conflict-free sync overview
- [CRDT Protocol](crdt-protocol.md) — HLC, wire protocol, op-log

## Transport

- [Delta](delta.md) — compression, filtering, state shape
- [Offline](offline.md) — offline queue, transport, reconnection
