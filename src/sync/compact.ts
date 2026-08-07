// src/sync/compact.ts — Server-side op-log compaction
import type { DB } from "../db/types.ts";
import { applyDdl } from "../db/ddl.ts";
import type { HLC } from "./types.ts";
import { SYNC_DEFAULTS } from "./types.ts";
import { issueSnapshotTs } from "./server-store.ts";

/**
 * Dependencies for server-side op-log compaction.

 *  @internal Engine/framework wiring (alpha52 sweep) — not public API.
 */
export interface CompactDeps {
  db: DB;
  cell: string;
  getState: () => Record<string, unknown>;
  serverHlc: HLC;
  compactOps?: number;
  log: {
    debug: (msg: string, data?: Record<string, unknown>) => void;
    warn: (msg: string, data?: Record<string, unknown>) => void;
    error: (msg: string, data?: Record<string, unknown>) => void;
  };
}

/** How long compacted op ids stay tombstoned for duplicate detection.
 *  Compaction DELETEs op rows, which would silently void the INSERT OR IGNORE
 *  dedup in persistOp — a client re-sending an op after a lost ack would then
 *  be re-applied (server-side double-apply). Tombstoning the deleted ids keeps
 *  dedup sound across compaction. 24h bounds the table: clients re-send only
 *  until acked, and client-side stale eviction (default 4h) makes older
 *  resends effectively impossible. */
export const COMPACTED_ID_RETENTION_MS = 24 * 3600_000;

/**
 * Compact sync_ops into a snapshot when op count exceeds threshold.

 *  @internal Engine/framework wiring (alpha52 sweep) — not public API.
 */
export async function compactSyncOps(deps: CompactDeps): Promise<void> {
  const threshold = deps.compactOps ?? SYNC_DEFAULTS.compactOps;

  const { rows } = await deps.db.query<{ count: number }>(
    "SELECT COUNT(*) as count FROM sync_ops WHERE cell = ?",
    [deps.cell],
  );
  const opCount = rows[0]?.count ?? 0;
  if (opCount < threshold) return;

  // The compaction boundary — ONE value, and every question about this
  // snapshot is answered with it: what the snapshot contains, what the DELETE
  // removes, and which client cursors can still be served from the log.
  //
  // It is a position on the `server_ts` sequence, issued here. Persist and
  // dispatch happen under the same per-cell lock this compaction holds, so
  // every op already applied — i.e. everything the snapshot below contains —
  // sits strictly below it, and every op persisted afterwards strictly above.
  //
  // The boundary used to be the server's HLC, and that disagreed with what the
  // snapshot contained: `HLClock.receive` deliberately refuses to follow a
  // remote clock more than `maxDrift` ahead (one bad clock must not hijack
  // causal order), so an op from a fast-clocked client is APPLIED — and
  // therefore inside the snapshot — while sitting above the HLC mark, which
  // left its row in the log. Boot replay is snapshot + surviving ops, so that
  // op applied twice… and the next compaction snapshotted the doubled state
  // while the row again survived, so it compounded on every restart.
  const compactedTs = await issueSnapshotTs(deps.db);
  // The HLC is no longer a boundary — it is the low-water mark published to
  // clients (the legacy snapshot-vs-incremental check) and the snapshot's own
  // stamp. Frozen here, at the moment of state capture.
  const [hlcPhys, hlcCnt, hlcNode] = deps.serverHlc;
  const state = deps.getState();
  const stateJson = JSON.stringify(state);
  const now = Date.now();

  await deps.db.transaction([
    {
      // Tombstone the ids the DELETE below removes — op-id dedup (persistOp)
      // must survive compaction, or a resend after a lost ack double-applies.
      // The op's `server_ts` is carried over with it: a re-ack for a resent op
      // has to state the op's cursor position, and after this DELETE the
      // tombstone is the only place that still knows it (see
      // `getOpServerTs`). Without it the re-ack goes out bare and the client
      // cannot tell whether the snapshot it just installed already contains
      // the op — it applies it a second time.
      sql:
        `INSERT OR IGNORE INTO sync_compacted_ids (id, compacted_at, server_ts)
            SELECT id, ?, server_ts FROM sync_ops
            WHERE cell = ? AND server_ts <= ?`,
      params: [now, deps.cell, compactedTs],
    },
    {
      sql:
        `INSERT INTO sync_snapshots (cell, version, state, hlc_phys, hlc_cnt, hlc_node)
            VALUES (?, COALESCE((SELECT version FROM sync_snapshots WHERE cell = ?), 0) + 1, ?, ?, ?, ?)
            ON CONFLICT(cell) DO UPDATE SET
              version = excluded.version, state = excluded.state,
              hlc_phys = excluded.hlc_phys, hlc_cnt = excluded.hlc_cnt, hlc_node = excluded.hlc_node`,
      params: [deps.cell, deps.cell, stateJson, hlcPhys, hlcCnt, hlcNode],
    },
    {
      // Everything below the boundary is inside the snapshot above.
      sql: `DELETE FROM sync_ops WHERE cell = ? AND server_ts <= ?`,
      params: [deps.cell, compactedTs],
    },
    {
      // Bound the tombstone table (see COMPACTED_ID_RETENTION_MS).
      sql: `DELETE FROM sync_compacted_ids WHERE compacted_at < ?`,
      params: [now - COMPACTED_ID_RETENTION_MS],
    },
    {
      sql:
        `INSERT INTO sync_meta (cell, low_water, last_compact, op_count, compacted_ts)
            VALUES (?, ?, ?, 0, ?)
            ON CONFLICT(cell) DO UPDATE SET
              low_water = excluded.low_water, last_compact = excluded.last_compact,
              op_count = (SELECT COUNT(*) FROM sync_ops WHERE cell = ?),
              compacted_ts = MAX(sync_meta.compacted_ts, excluded.compacted_ts)`,
      params: [
        deps.cell,
        JSON.stringify([hlcPhys, hlcCnt, hlcNode]),
        now,
        compactedTs,
        deps.cell,
      ],
    },
  ]);

  deps.log.debug(
    `[sync:compact] ${deps.cell}: compacted ${opCount} ops, new low_water=[${hlcPhys},${hlcCnt},${hlcNode}]`,
  );
}

/**
 * SQL to initialize sync tables. Run once during aio.run().

 *  @internal Engine/framework wiring (alpha52 sweep) — not public API.
 */
export const SYNC_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS sync_ops (
    id TEXT PRIMARY KEY, cell TEXT NOT NULL, action TEXT NOT NULL,
    payload TEXT NOT NULL, hlc_phys INTEGER NOT NULL, hlc_cnt INTEGER NOT NULL,
    hlc_node TEXT NOT NULL, server_ts INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_sync_ops_cell_hlc
    ON sync_ops(cell, hlc_phys, hlc_cnt, hlc_node)`,
  // Delivery reads by server_ts (`loadOpsSince`), and the cursor reservation
  // reads MAX(server_ts) on every sync round (`server-store.highWaterTs`) —
  // both are index lookups with these, full scans without them. Idempotent, so
  // existing databases pick them up on the next boot (no migration needed).
  `CREATE INDEX IF NOT EXISTS idx_sync_ops_cell_ts ON sync_ops(cell, server_ts)`,
  `CREATE INDEX IF NOT EXISTS idx_sync_ops_ts ON sync_ops(server_ts)`,
  `CREATE TABLE IF NOT EXISTS sync_snapshots (
    cell TEXT PRIMARY KEY, version INTEGER NOT NULL, state TEXT NOT NULL,
    hlc_phys INTEGER NOT NULL, hlc_cnt INTEGER NOT NULL, hlc_node TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sync_meta (
    cell TEXT PRIMARY KEY, low_water TEXT NOT NULL,
    last_compact INTEGER NOT NULL, op_count INTEGER NOT NULL,
    compacted_ts INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS sync_compacted_ids (
    id TEXT PRIMARY KEY, compacted_at INTEGER NOT NULL,
    server_ts INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS idx_sync_compacted_at
    ON sync_compacted_ids(compacted_at)`,
];

/** Schema changes for databases created by an EARLIER aio.
 *
 *  `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists,
 *  so a column added later never reaches an existing app's database. Each
 *  statement here is applied on boot and is expected to fail with "duplicate
 *  column" once it has been applied — see `applySyncMigrations`. */
export const SYNC_MIGRATIONS: string[] = [
  `ALTER TABLE sync_meta ADD COLUMN compacted_ts INTEGER NOT NULL DEFAULT 0`,
  // 0 = "this tombstone predates the column": an unknown position, which
  // `getOpServerTs` reports as unknown rather than guessing (a wrong cursor on
  // an ack is worse than no cursor).
  `ALTER TABLE sync_compacted_ids ADD COLUMN server_ts INTEGER NOT NULL DEFAULT 0`,
];

/** Apply {@linkcode SYNC_MIGRATIONS}, tolerating the already-applied case.
 *
 *  Anything else is FATAL. This used to warn and continue — after which the
 *  app ran against a schema it did not have: every query on the missing
 *  column failed at some random later moment (or worse, a compaction wrote a
 *  cursor position the tombstone table could not hold), far from the boot
 *  that knew. A schema the app cannot evolve is a boot failure, named at
 *  boot.
 *
 *  The tolerate-duplicate-column / fatal-on-anything-else rule lives in ONE
 *  decider ({@linkcode applyDdl}, src/db/ddl.ts) shared with the `db:` table
 *  reconciler — it regressed per-seam when each carried its own copy. These
 *  are epoch-1 reconcilers: idempotent, run on EVERY boot; a strictly-once
 *  future move belongs on the versioned ladder (`AIO_DDL_STEPS`) instead. */
export async function applySyncMigrations(
  db: DB,
  log?: { debug: (m: string) => void; warn: (m: string) => void },
): Promise<void> {
  for (const sql of SYNC_MIGRATIONS) {
    const table = /ALTER TABLE\s+(\S+)/i.exec(sql)?.[1] ?? "(unknown)";
    const outcome = await applyDdl(db, sql, {
      ns: "sync",
      subject: `table "${table}"`,
      source: "applySyncMigrations, src/sync/compact.ts",
    });
    if (outcome === "applied") log?.debug(`[sync:schema] applied: ${sql}`);
  }
}
