// src/sync/server-store.ts — DB persistence layer for server-side sync
import type { DB } from "../db/types.ts";
import type { HLC, SyncOp } from "./types.ts";
import { log } from "../diagnostics/logger.ts";

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

// Strictly monotonic server_ts issuance. Bare Date.now() ties within one ms,
// and the sync cursor is a strict `server_ts > ?` — an op stamped in the same
// ms as the last one a client saw would never be delivered (silent divergence).
let _lastServerTs = 0;
let _seeded = false;

/** Seed the issuer from the op-log's MAX(server_ts) once per process. A
 *  same-ms burst inflates server_ts past wall-clock; if the server restarts
 *  inside that window an unseeded issuer could stamp a new op BELOW a cursor
 *  already echoed to clients — silently undeliverable. Best-effort: on query
 *  failure the wall clock still applies. */
async function seedServerTs(db: DB): Promise<void> {
  if (_seeded) return;
  _seeded = true;
  try {
    const { rows } = await db.query<{ max_ts: number | null }>(
      "SELECT MAX(server_ts) AS max_ts FROM sync_ops",
    );
    const max = rows[0]?.max_ts;
    if (typeof max === "number" && max > _lastServerTs) _lastServerTs = max;
  } catch { /* fresh DB / no table yet — wall clock is correct */ }
}

function nextServerTs(): number {
  _lastServerTs = Math.max(Date.now(), _lastServerTs + 1);
  return _lastServerTs;
}

/** TEST ONLY: simulate a process restart (issuer forgets, next call re-seeds). */
export function _resetServerTsForTest(): void {
  _lastServerTs = 0;
  _seeded = false;
}

/**
 * Reserve the current cursor position: every op persisted AFTER this call gets
 * a strictly greater server_ts. Taking this inside a cell's lock before reading
 * ops/state makes `lastServerTs` echoed to clients race-free — nothing the
 * client hasn't seen can sit at or below the cursor. Seeded from the op-log
 * first: an unseeded reserve after a restart could echo a cursor BELOW
 * already-persisted (burst-inflated) ops → re-delivery → double-apply.
 */
export async function reserveServerTs(db: DB): Promise<number> {
  await seedServerTs(db);
  _lastServerTs = Math.max(Date.now(), _lastServerTs);
  return _lastServerTs;
}

/**
 * Persist a sync op to the op-log (INSERT OR IGNORE — idempotent).
 * Returns the issued server_ts when the row was newly inserted, or null for a
 * duplicate — callers must not re-dispatch/re-broadcast a duplicate, and must
 * stamp broadcasts with the returned ts so peers can advance their cursor.
 */
export async function persistOp(
  db: DB,
  op: { id: string; hlc: HLC; cell: string; action: string; payload: unknown },
): Promise<number | null> {
  await seedServerTs(db);
  const [hlcPhys, hlcCnt, hlcNode] = op.hlc;
  const serverTs = nextServerTs();
  const { changes } = await db.execute(
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
      serverTs,
    ],
  );
  return changes > 0 ? serverTs : null;
}

/**
 * Load all ops for a cell since the given cursor. Uses server_ts when available (strictly monotonic), falls back to HLC for backwards compat.
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
       FROM sync_ops WHERE cell = ? ORDER BY hlc_phys, hlc_cnt, hlc_node`,
      [cell],
    );
    return rows.map(rowToOp);
  }

  const [phys, cnt] = hlc;
  const { rows } = await db.query<OpRow>(
    `SELECT id, cell, action, payload, hlc_phys, hlc_cnt, hlc_node
     FROM sync_ops WHERE cell = ?
     AND (hlc_phys > ? OR (hlc_phys = ? AND hlc_cnt > ?))
     ORDER BY hlc_phys, hlc_cnt, hlc_node`,
    [cell, phys, phys, cnt],
  );
  return rows.map(rowToOp);
}

/**
 * Read the compaction low_water mark for a cell, or null if none.
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
