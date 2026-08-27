# Persistence & Data

How AIO stores, syncs, and transports state.

## Overview

- [How It Works](how-it-works.md) — end-to-end: state change → disk → restore,
  and [the durability contract](how-it-works.md#the-durability-contract): what
  survives a kill, a power cut, and a bounded shutdown
- [Where Files Live](where-files-live.md) — `~/.<app>/data` is the whole backup;
  `am data` / `am backup` / `am restore`

## Storage

- [Auto-Persist](auto-persist.md) — automatic state persistence to SQLite
  (`aio_kv`)
- [SQLite](sqlite.md) — schema, queries, transactions, WAL
- [Big Data: The Four Tiers](big-data.md) — what belongs in cell state vs `db:`
  tables vs files vs `.server.ts` pipelines, and the size guardrails

## Sync

- [CRDT](crdt.md) — conflict-free sync overview
- [CRDT Protocol](crdt-protocol.md) — HLC, wire protocol, op-log

## Transport

- [Delta](delta.md) — compression, filtering, state shape
- [Offline](offline.md) — offline queue, transport, reconnection
