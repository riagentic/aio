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
  // Compaction DELETEs op rows, so INSERT OR IGNORE alone forgets ids the log
  // rolled over — a client re-sending such an op (ack lost → resend after
  // compaction) would be re-inserted and re-dispatched (server double-apply).
  // Tombstoned ids (see compact.ts) keep the dedup sound; PK lookup is cheap.
  const { rows: tomb } = await db.query<{ id: string }>(
    "SELECT id FROM sync_compacted_ids WHERE id = ? LIMIT 1",
    [op.id],
  );
  if (tomb.length > 0) return null;
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
 * Load ops for a cell after the given server_ts cursor (strictly monotonic,
 * matches dispatch order). Without a cursor the FULL op-log is returned, in
 * server_ts (dispatch) order.
 *
 * There is deliberately NO HLC-based filtering (chaos-suite finding,
 * 2026-07-21): HLC order ≠ persist order — same-ms ties and cross-node
 * counters mean a client's HLC watermark can sit "above" concurrently
 * stamped peer ops it never received, so filtering by it silently skipped
 * ops (permanent divergence once the cursor echo sealed them). Re-delivery
 * to a cursorless client that already applied some ops is absorbed by the
 * client-side op-id dedup. `_hlc` is kept in the signature for call-site
 * stability; it must never be used as a delivery filter again (it remains
 * valid as a conservative compaction watermark — see server-handler).
 */
export async function loadOpsSince(
  db: DB,
  cell: string,
  _hlc: HLC | null,
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

  // No cursor → full op-log in dispatch (server_ts) order, so a replay or a
  // fresh client folds ops in exactly the order the live server applied them.
  const { rows } = await db.query<OpRow>(
    `SELECT id, cell, action, payload, hlc_phys, hlc_cnt, hlc_node
     FROM sync_ops WHERE cell = ? ORDER BY server_ts`,
    [cell],
  );
  return rows.map(rowToOp);
}

/** The compacted base state for a cell, or null when it was never compacted.
 *
 *  Compaction folds every op at/below an HLC boundary into `sync_snapshots` and
 *  DELETEs those ops — so after the first compaction the op log alone no longer
 *  describes the cell. Anything that rebuilds state from the log (boot replay)
 *  MUST start from this snapshot, or it silently resurrects the cell as it was
 *  at the last compaction boundary… which is to say, empty. */
export async function loadSnapshot(
  db: DB,
  cell: string,
): Promise<{ state: Record<string, unknown>; hlc: HLC } | null> {
  const { rows } = await db.query<{
    state: string;
    hlc_phys: number;
    hlc_cnt: number;
    hlc_node: string;
  }>(
    `SELECT state, hlc_phys, hlc_cnt, hlc_node FROM sync_snapshots WHERE cell = ?`,
    [cell],
  );
  const row = rows[0];
  if (!row) return null;
  try {
    return {
      state: JSON.parse(row.state) as Record<string, unknown>,
      hlc: [row.hlc_phys, row.hlc_cnt, row.hlc_node],
    };
  } catch (e) {
    log.error(
      "sync",
      `snapshot for "${cell}" is corrupt (${e}) — cannot restore compacted state`,
    );
    return null;
  }
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
