// src/sync/compact.ts — Server-side op-log compaction
import type { DB } from "../db/types.ts";
import type { HLC } from "./types.ts";
import { SYNC_DEFAULTS } from "./types.ts";

/**
 * Dependencies for server-side op-log compaction.
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

/**
 * Compact sync_ops into a snapshot when op count exceeds threshold.
 */
export async function compactSyncOps(deps: CompactDeps): Promise<void> {
  const threshold = deps.compactOps ?? SYNC_DEFAULTS.compactOps;

  const { rows } = await deps.db.query<{ count: number }>(
    "SELECT COUNT(*) as count FROM sync_ops WHERE cell = ?",
    [deps.cell],
  );
  const opCount = rows[0]?.count ?? 0;
  if (opCount < threshold) return;

  // Freeze HLC at the moment of state capture — ensures DELETE boundary
  // matches the state snapshot exactly (no ops arrive between capture and delete)
  const [hlcPhys, hlcCnt, hlcNode] = deps.serverHlc;
  const state = deps.getState();
  const stateJson = JSON.stringify(state);
  const now = Date.now();

  await deps.db.transaction([
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
      // Use <= for counter to include ops AT the snapshot boundary (already in snapshot)
      sql:
        `DELETE FROM sync_ops WHERE cell = ? AND (hlc_phys < ? OR (hlc_phys = ? AND hlc_cnt <= ?))`,
      params: [deps.cell, hlcPhys, hlcPhys, hlcCnt],
    },
    {
      sql: `INSERT INTO sync_meta (cell, low_water, last_compact, op_count)
            VALUES (?, ?, ?, 0)
            ON CONFLICT(cell) DO UPDATE SET
              low_water = excluded.low_water, last_compact = excluded.last_compact,
              op_count = (SELECT COUNT(*) FROM sync_ops WHERE cell = ?)`,
      params: [
        deps.cell,
        JSON.stringify([hlcPhys, hlcCnt, hlcNode]),
        now,
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
 */
export const SYNC_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS sync_ops (
    id TEXT PRIMARY KEY, cell TEXT NOT NULL, action TEXT NOT NULL,
    payload TEXT NOT NULL, hlc_phys INTEGER NOT NULL, hlc_cnt INTEGER NOT NULL,
    hlc_node TEXT NOT NULL, server_ts INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_sync_ops_cell_hlc
    ON sync_ops(cell, hlc_phys, hlc_cnt, hlc_node)`,
  `CREATE TABLE IF NOT EXISTS sync_snapshots (
    cell TEXT PRIMARY KEY, version INTEGER NOT NULL, state TEXT NOT NULL,
    hlc_phys INTEGER NOT NULL, hlc_cnt INTEGER NOT NULL, hlc_node TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sync_meta (
    cell TEXT PRIMARY KEY, low_water TEXT NOT NULL,
    last_compact INTEGER NOT NULL, op_count INTEGER NOT NULL)`,
];
