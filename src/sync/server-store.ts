// src/sync/server-store.ts — DB persistence layer for server-side sync
import type { DB } from "../db/types.ts";
import type { HLC, SyncOp } from "./types.ts";
import { log } from "../logger.ts";

/** Row shape returned by sync_ops queries. */
interface OpRow {
  id: string;
  cell: string;
  action: string;
  payload: string;
  hlc_phys: number;
  hlc_cnt: number;
  hlc_node: string;
  server_ts?: number;
}

function rowToOp(r: OpRow): SyncOp {
  return {
    id: r.id,
    cell: r.cell,
    action: r.action,
    payload: JSON.parse(r.payload),
    hlc: [r.hlc_phys, r.hlc_cnt, r.hlc_node] as HLC,
    confirmed: true,
  };
}

/**
 * Persist a sync op to the op-log (INSERT OR IGNORE — idempotent).
 * @experimental Excluded from the 1.0 stability guarantee.
 */
export async function persistOp(
  db: DB,
  op: { id: string; hlc: HLC; cell: string; action: string; payload: unknown },
): Promise<void> {
  const [hlcPhys, hlcCnt, hlcNode] = op.hlc;
  await db.execute(
    `INSERT OR IGNORE INTO sync_ops (id, cell, action, payload, hlc_phys, hlc_cnt, hlc_node, server_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      op.id,
      op.cell,
      op.action,
      JSON.stringify(op.payload),
      hlcPhys,
      hlcCnt,
      hlcNode,
      Date.now(),
    ],
  );
}

/**
 * Load all ops for a cell since the given cursor. Uses server_ts when available (strictly monotonic), falls back to HLC for backwards compat.
 * @experimental Excluded from the 1.0 stability guarantee.
 */
export async function loadOpsSince(
  db: DB,
  cell: string,
  hlc: HLC | null,
  lastServerTs?: number | null,
): Promise<SyncOp[]> {
  // Use server_ts cursor when available — strictly monotonic per-server, no concurrency ambiguity
  if (lastServerTs != null && lastServerTs > 0) {
    const { rows } = await db.query<OpRow>(
      `SELECT id, cell, action, payload, hlc_phys, hlc_cnt, hlc_node
       FROM sync_ops WHERE cell = ? AND server_ts > ?
       ORDER BY server_ts`,
      [cell, lastServerTs],
    );
    return rows.map(rowToOp);
  }

  // Fallback to HLC cursor for backwards compat
  if (!hlc) {
    const { rows } = await db.query<OpRow>(
      `SELECT id, cell, action, payload, hlc_phys, hlc_cnt, hlc_node
       FROM sync_ops WHERE cell = ? ORDER BY hlc_phys, hlc_cnt`,
      [cell],
    );
    return rows.map(rowToOp);
  }

  const [phys, cnt] = hlc;
  const { rows } = await db.query<OpRow>(
    `SELECT id, cell, action, payload, hlc_phys, hlc_cnt, hlc_node
     FROM sync_ops WHERE cell = ?
     AND (hlc_phys > ? OR (hlc_phys = ? AND hlc_cnt > ?))
     ORDER BY hlc_phys, hlc_cnt`,
    [cell, phys, phys, cnt],
  );
  return rows.map(rowToOp);
}

/**
 * Read the compaction low_water mark for a cell, or null if none.
 * @experimental Excluded from the 1.0 stability guarantee.
 */
export async function getLowWater(
  db: DB,
  cell: string,
): Promise<HLC | null> {
  const { rows } = await db.query<{ low_water: string }>(
    "SELECT low_water FROM sync_meta WHERE cell = ?",
    [cell],
  );
  if (!rows[0]) return null;
  try {
    return JSON.parse(rows[0].low_water) as HLC;
  } catch (e) {
    log.warn(
      "sync",
      `low_water corrupted for ${cell}: ${e} — triggering full snapshot`,
    );
    return null;
  }
}
