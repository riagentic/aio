# Storage backend interface (design — pre-freeze reservation)

**Status: design only.** aio persists through Deno.Kv (snapshots) and SQLite
(3-tier db + sync op store). Both are hardwired today. This spec reserves an
additive seam so a future pluggable backend (Postgres, S3-backed snapshots,
custom KV) never requires a breaking change — the reason to design it before the
API freeze even though the implementation lands post-1.0.

## Interface (draft)

```ts
/** Snapshot storage — what persistence.ts needs. */
interface StateStore {
  load(key: string): Promise<Record<string, unknown> | null>;
  save(key: string, state: Record<string, unknown>): Promise<void>;
  delete(key: string): Promise<void>;
  close(): Promise<void>;
}

/** Sync op storage — what server-store.ts needs (see persistOp/loadOpsSince). */
interface OpStore {
  persistOp(op: SyncOp): Promise<void>;
  loadOpsSince(
    cell: string,
    cursor: HLC | null,
    lastServerTs?: number,
  ): Promise<SyncOp[]>;
  getLowWater(cell: string): Promise<HLC | null>;
  compact(cell: string, retention: string): Promise<void>;
}
```

Config seam (additive):
`aio.run({ storage: { state?: StateStore, ops?: OpStore } })` — omitted =
current Kv/SQLite defaults, byte-compatible.

## Constraints discovered in the current code

- `persistence.ts` couples schema-stamping (`<appId>:__schema`) to the store —
  the interface must let the framework own versioning above the backend.
- `server-store.ts` orders by `(hlc_phys, hlc_cnt, hlc_node)` — any backend must
  preserve that total order; make it part of the contract, not the SQL.
- The 3-tier `app.db` API (tables/migrations) is intentionally NOT abstracted —
  it is SQLite-specific by design (documented positioning).

## Non-goals

Multi-region replication, cross-backend transactions, swapping mid-run.
