// src/sync/compact.ts — Server-side op-log compaction
import type { DB } from "../db/types.ts";
import type { HLC } from "./types.ts";
import { SYNC_DEFAULTS } from "./types.ts";

/** Dependencies for server-side op-log compaction. */
export interface CompactDeps {
  db: DB;
  feature: string;
  getState: () => Record<string, unknown>;
  serverHlc: HLC;
  compactOps?: number;
  log: {
    debug: (msg: string, data?: Record<string, unknown>) => void;
    warn: (msg: string, data?: Record<string, unknown>) => void;
    error: (msg: string, data?: Record<string, unknown>) => void;
  };
}

/** Compact sync_ops into a snapshot when op count exceeds threshold. */
export async function compactSyncOps(deps: CompactDeps): Promise<void> {
  const threshold = deps.compactOps ?? SYNC_DEFAULTS.compactOps;

  const { rows } = await deps.db.query<{ count: number }>(
    "SELECT COUNT(*) as count FROM sync_ops WHERE feature = ?",
    [deps.feature],
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
        `INSERT INTO sync_snapshots (feature, version, state, hlc_phys, hlc_cnt, hlc_node)
            VALUES (?, COALESCE((SELECT version FROM sync_snapshots WHERE feature = ?), 0) + 1, ?, ?, ?, ?)
            ON CONFLICT(feature) DO UPDATE SET
              version = excluded.version, state = excluded.state,
              hlc_phys = excluded.hlc_phys, hlc_cnt = excluded.hlc_cnt, hlc_node = excluded.hlc_node`,
      params: [deps.feature, deps.feature, stateJson, hlcPhys, hlcCnt, hlcNode],
    },
    {
      // Use <= for counter to include ops AT the snapshot boundary (already in snapshot)
      sql:
        `DELETE FROM sync_ops WHERE feature = ? AND (hlc_phys < ? OR (hlc_phys = ? AND hlc_cnt <= ?))`,
      params: [deps.feature, hlcPhys, hlcPhys, hlcCnt],
    },
    {
      sql: `INSERT INTO sync_meta (feature, low_water, last_compact, op_count)
            VALUES (?, ?, ?, 0)
            ON CONFLICT(feature) DO UPDATE SET
              low_water = excluded.low_water, last_compact = excluded.last_compact,
              op_count = (SELECT COUNT(*) FROM sync_ops WHERE feature = ?)`,
      params: [
        deps.feature,
        JSON.stringify([hlcPhys, hlcCnt, hlcNode]),
        now,
        deps.feature,
      ],
    },
  ]);

  deps.log.debug(
    `[sync:compact] ${deps.feature}: compacted ${opCount} ops, new low_water=[${hlcPhys},${hlcCnt},${hlcNode}]`,
  );
}

/** SQL to initialize sync tables. Run once during aio.run(). */
export const SYNC_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sync_ops (
    id TEXT PRIMARY KEY, feature TEXT NOT NULL, action TEXT NOT NULL,
    payload TEXT NOT NULL, hlc_phys INTEGER NOT NULL, hlc_cnt INTEGER NOT NULL,
    hlc_node TEXT NOT NULL, server_ts INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_sync_ops_feat_hlc
    ON sync_ops(feature, hlc_phys, hlc_cnt, hlc_node)`,
  `CREATE TABLE IF NOT EXISTS sync_snapshots (
    feature TEXT PRIMARY KEY, version INTEGER NOT NULL, state TEXT NOT NULL,
    hlc_phys INTEGER NOT NULL, hlc_cnt INTEGER NOT NULL, hlc_node TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sync_meta (
    feature TEXT PRIMARY KEY, low_water TEXT NOT NULL,
    last_compact INTEGER NOT NULL, op_count INTEGER NOT NULL)`,
];
