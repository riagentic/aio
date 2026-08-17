// src/sync/server-store.ts — DB persistence layer for server-side sync
import type { DB } from "../db/types.ts";
import type { HLC, SyncOp } from "./types.ts";
import { log } from "../diagnostics/logger-api.ts";

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
    // The op's POSITION, carried to the client. A catch-up is a batch of ops
    // the server applied in the past, and the client rebuilds confirmed state
    // by replaying them — which only reproduces the server's state if it
    // replays them in the server's order, interleaved with the acks for its
    // own ops that the same response is answering. Without the position it
    // cannot do that (see the ordered fold in sync-engine's
    // `handleSyncResponse`); broadcasts have always carried it.
    ...(typeof r.server_ts === "number" ? { serverTs: r.server_ts } : {}),
  };
}

// Strictly monotonic server_ts issuance. Bare Date.now() ties within one ms,
// and the sync cursor is a strict `server_ts > ?` — an op stamped in the same
// ms as the last one a client saw would never be delivered (silent divergence).
let _lastServerTs = 0;
// Which DATABASES this process has already seeded from. The high-water mark is
// a property of a database, not of a process: a single `_seeded` boolean meant
// the SECOND store opened in one process (a profile restore, a test server, a
// reopened db) skipped its seed entirely and could stamp new ops underneath its
// own log — undeliverable to any client already holding that cursor.
let _seededDbs = new WeakSet<DB>();

/**
 * The DURABLE high-water mark of the `server_ts` sequence: the greatest value
 * the store itself can still prove was issued, after any restart.
 *
 * PROTOCOL INVARIANT (the one this file exists to keep):
 *   a `server_ts` handed to a client as a catch-up cursor must NEVER be
 *   crossed backwards by a later-issued op — including across a restart.
 *   `loadOpsSince` is a strict `server_ts > cursor`, so an op stamped at or
 *   below a cursor a client already holds is undeliverable to that client
 *   FOREVER, and nothing anywhere reports it. Silent, permanent op loss.
 *
 * The in-memory issuer (`_lastServerTs`) is only a CACHE of this sequence, and
 * it runs AHEAD of the log in ways `MAX(server_ts) FROM sync_ops` cannot see:
 *   - a duplicate `INSERT OR IGNORE` used to consume a ts that no row carries;
 *   - compaction DELETEs op rows (their max survives only in `compacted_ts`);
 *   - a D11-rejected op is DELETEd after being stamped.
 * So "highest surviving row" is NOT the high-water mark, and seeding from it
 * after a restart re-issues values that were already echoed as cursors (chaos
 * seed 3858958063: `_lastServerTs` had run to …2231 through duplicate persists,
 * a client held the echoed cursor …2224, the restart re-seeded to the row max
 * and stamped the next op …2222 — invisible to that client for good).
 *
 * The fix is structural rather than per-source: everything derived from this
 * sequence that leaves the server (`reserveServerTs`) is taken from durable
 * state, and the issuer is re-seeded from the same expression. A future delete
 * path or a burned ts therefore cannot re-open the hole.
 */
async function highWaterTs(db: DB): Promise<number> {
  try {
    const { rows } = await db.query<{ ts: number | null }>(
      `SELECT MAX(ts) AS ts FROM (
         SELECT MAX(server_ts) AS ts FROM sync_ops
         UNION ALL
         SELECT MAX(compacted_ts) AS ts FROM sync_meta)`,
    );
    return rows[0]?.ts ?? 0;
  } catch {
    // Pre-migration DB (no compacted_ts column) — the op-log alone still
    // covers every ts that has a row.
    try {
      const { rows } = await db.query<{ ts: number | null }>(
        "SELECT MAX(server_ts) AS ts FROM sync_ops",
      );
      return rows[0]?.ts ?? 0;
    } catch {
      return 0; // fresh DB / no table yet — wall clock is correct
    }
  }
}

/** Seed the issuer from the durable high-water mark once per database, so a
 *  restart — or a switch to another store in the same process — resumes
 *  strictly ABOVE every value that store ever issued (see
 *  {@linkcode highWaterTs}). Best-effort: on query failure the wall clock
 *  still applies. */
async function seedServerTs(db: DB): Promise<void> {
  if (_seededDbs.has(db)) return;
  _seededDbs.add(db);
  const hw = await highWaterTs(db);
  if (hw > _lastServerTs) _lastServerTs = hw;
}

function nextServerTs(): number {
  _lastServerTs = Math.max(Date.now(), _lastServerTs + 1);
  return _lastServerTs;
}

/** TEST ONLY: simulate a process restart (issuer forgets, next call re-seeds). */
export function _resetServerTsForTest(): void {
  _lastServerTs = 0;
  _seededDbs = new WeakSet<DB>();
}

/**
 * Reserve the current cursor position: every op persisted AFTER this call gets
 * a strictly greater server_ts. Taking this inside a cell's lock before reading
 * ops/state makes `lastServerTs` echoed to clients race-free — nothing the
 * client hasn't seen can sit at or below the cursor.
 *
 * The reservation is the DURABLE high-water mark, never the in-memory issuer:
 * a cursor the client keeps must be reproducible by the store after a restart,
 * or the restarted issuer stamps new ops underneath it and they are
 * undeliverable to that client forever (see {@linkcode highWaterTs}).
 * Both halves hold:
 *   - everything persisted so far is ≤ it (it IS the max over the log), and
 *   - everything persisted later is > it (the issuer is bumped to ≥ it here,
 *     and `nextServerTs` is strictly increasing).
 */
export async function reserveServerTs(db: DB): Promise<number> {
  await seedServerTs(db);
  const hw = await highWaterTs(db);
  if (hw > _lastServerTs) _lastServerTs = hw;
  return hw;
}

/**
 * Issue the cursor position a freshly written snapshot reflects.
 *
 * A snapshot is the cell's LIVE state, which is strictly more than its op log:
 * a server-origin write (effect, cron, serverFn) changes state without
 * producing any op at all, and compaction folds it in. So "the client has
 * every op above its cursor" does NOT mean "the client's state matches the
 * server's" — the only honest answer is the position of the snapshot itself,
 * compared against the client's cursor.
 *
 * It BURNS a value from the same sequence rather than reusing the log's max:
 * with an empty log the max is 0, and a cursorless client (`0 < 0` is false)
 * was told it was up to date while every byte of the cell lived in a snapshot
 * it never received. A burned position is strictly above every op persisted so
 * far and strictly below every op persisted after, which is exactly what the
 * comparison needs, and `highWaterTs` already counts it as durable.
 */
export async function issueSnapshotTs(db: DB): Promise<number> {
  await seedServerTs(db);
  const hw = await highWaterTs(db);
  if (hw > _lastServerTs) _lastServerTs = hw;
  return nextServerTs();
}

/**
 * Persist a sync op to the op-log (INSERT OR IGNORE — idempotent).
 * Returns the issued server_ts when the row was newly inserted, or null for a
 * duplicate — callers must not re-dispatch/re-broadcast a duplicate, and must
 * stamp broadcasts with the returned ts so peers can advance their cursor.

 *  @internal Engine/framework wiring (alpha52 sweep) — not public API.
 */
export async function persistOp(
  db: DB,
  op: { id: string; hlc: HLC; cell: string; action: string; payload: unknown },
): Promise<number | null> {
  await seedServerTs(db);
  // Known-id check, both halves in one round trip (both are PK lookups):
  //  - sync_compacted_ids: compaction DELETEs op rows, so INSERT OR IGNORE
  //    alone forgets ids the log rolled over — a client re-sending such an op
  //    (ack lost → resend after compaction) would be re-inserted and
  //    re-dispatched (server double-apply). Tombstones keep dedup sound.
  //  - sync_ops: a duplicate reaching the INSERT would still have CONSUMED a
  //    server_ts that no row ever carries, pushing the in-memory issuer above
  //    anything the store can prove after a restart. Duplicates are routine
  //    (every reconnect re-sends its pending buffer), so this was the main
  //    engine of issuer/log drift. Checking first makes the sequence advance
  //    only for ops that actually get a row.
  const { rows: known } = await db.query<{ id: string }>(
    `SELECT id FROM sync_compacted_ids WHERE id = ?
     UNION ALL
     SELECT id FROM sync_ops WHERE id = ?
     LIMIT 1`,
    [op.id, op.id],
  );
  if (known.length > 0) return null;
  const [hlcPhys, hlcCnt, hlcNode] = op.hlc;
  // INSERT OR IGNORE stays the authority (`changes === 0` ⇒ duplicate): the
  // check above is an optimization, not the correctness boundary.
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

/** The `server_ts` an op was stamped with, wherever that fact still lives —
 *  the live row, or the compaction tombstone that replaced it. `null` when the
 *  op is unknown, or when the tombstone predates the `server_ts` column
 *  (0 = unknown, never a real position).
 *
 *  This exists because an ack must state the op's cursor position even when
 *  the op is a DUPLICATE (a resend after a lost ack): `persistOp` returns null
 *  for a duplicate — correctly, it must not be re-dispatched — but "don't
 *  re-apply it" and "where does it sit in the log" are two different facts,
 *  and answering the second with silence made the client apply an op its
 *  snapshot already contained a second time (see `handleAck`'s snapshot
 *  watermark). */
export async function getOpServerTs(
  db: DB,
  id: string,
): Promise<number | null> {
  try {
    const { rows } = await db.query<{ ts: number | null }>(
      `SELECT server_ts AS ts FROM sync_ops WHERE id = ?
       UNION ALL
       SELECT server_ts AS ts FROM sync_compacted_ids WHERE id = ?`,
      [id, id],
    );
    for (const r of rows) {
      if (typeof r.ts === "number" && r.ts > 0) return r.ts;
    }
    return null;
  } catch {
    // Pre-migration tombstone table (no server_ts column) — unknown, and the
    // ack degrades to its pre-alpha43 shape rather than lying.
    return null;
  }
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

 *  @internal Engine/framework wiring (alpha52 sweep) — not public API.
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
      `SELECT id, cell, action, payload, hlc_phys, hlc_cnt, hlc_node, server_ts
       FROM sync_ops WHERE cell = ? AND server_ts > ?
       ORDER BY server_ts`,
      [cell, lastServerTs],
    );
    return rows.map(rowToOp);
  }

  // No cursor → full op-log in dispatch (server_ts) order, so a replay or a
  // fresh client folds ops in exactly the order the live server applied them.
  const { rows } = await db.query<OpRow>(
    `SELECT id, cell, action, payload, hlc_phys, hlc_cnt, hlc_node, server_ts
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

/** Write a boot-time BASE snapshot for a cell the sync store has never seen.
 *
 *  The moment `localFirst` / `sync: true` adopts a cell that already has
 *  KV-persisted data, that data's only durable home stops being written (sync
 *  cells are excluded from KV on the next persist) — without this seed, the
 *  first restart after the flip restores the cell from initialState + an empty
 *  op-log and the pre-flip data exists NOWHERE. Zero HLC so every real op
 *  sorts after it; sync_meta low-water is untouched, so no client is forced
 *  into a resync. `DO NOTHING` keeps any real compaction snapshot authoritative. */
export async function seedSyncSnapshot(
  db: DB,
  cell: string,
  state: unknown,
): Promise<void> {
  await db.execute(
    `INSERT INTO sync_snapshots (cell, version, state, hlc_phys, hlc_cnt, hlc_node)
       VALUES (?, 1, ?, 0, 0, 'seed')
       ON CONFLICT(cell) DO NOTHING`,
    [cell, JSON.stringify(state)],
  );
}

/**
 * Read the compaction low_water mark for a cell, or null if none.

 *  @internal Engine/framework wiring (alpha52 sweep) — not public API.
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

/** The cursor position the cell's SNAPSHOT reflects (0 = never compacted).
 *
 *  A client whose server_ts cursor sits below this cannot be served
 *  incrementally: the ops it would need may have been deleted, and the
 *  snapshot may also hold server-origin state that never was an op (see
 *  {@linkcode issueSnapshotTs}). Below the mark ⇒ send the snapshot. */
export async function getCompactedTs(db: DB, cell: string): Promise<number> {
  try {
    const { rows } = await db.query<{ compacted_ts: number | null }>(
      "SELECT compacted_ts FROM sync_meta WHERE cell = ?",
      [cell],
    );
    return rows[0]?.compacted_ts ?? 0;
  } catch {
    // Pre-migration database (column absent): treat as "unknown", which the
    // caller handles conservatively.
    return 0;
  }
}
