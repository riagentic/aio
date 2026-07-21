// skv-sqlite.ts — the SkvInstance interface on SQLite (perfect-aio D4:
// SQLite-only persistence). Same surface Deno.Kv's wrapper had — callers
// unchanged — backed by one table in the app's single data.db. Kills the
// unstable-KV flag and KV's 64KiB value limit (already hit in the field),
// and gives `am sql` visibility into persisted state.
//
// Legacy Deno.Kv data auto-migrates on first boot (see migrateLegacyKv).

import type { DB } from "../db/types.ts";
import type { SkvInstance } from "./skv.ts";

/** Key separator for multi-key rows. Unit Separator (U+001F) — cell names
 *  are identifier-safe by validation, so it can never collide. */
const SEP = "";
/** Upper bound for prefix range scans (max BMP char). */
const HIGH = "￿";

export const SKV_SCHEMA =
  `CREATE TABLE IF NOT EXISTS aio_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`;

/** SkvInstance backed by SQLite. JSON values; multi-key writes atomic. */
export function sqliteKv(db: DB): SkvInstance {
  return {
    set: async (key, val) => {
      await db.execute(
        `INSERT INTO aio_kv (k, v) VALUES (?, ?)
         ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
        [key, JSON.stringify(val) ?? "null"],
      );
      return { ok: true as const, versionstamp: "" };
    },
    get: async <T>(key: string) => {
      const { rows } = await db.query<{ v: string }>(
        `SELECT v FROM aio_kv WHERE k = ?`,
        [key],
      );
      return rows[0] ? JSON.parse(rows[0].v) as T : null;
    },
    del: async (key) => {
      await db.execute(`DELETE FROM aio_kv WHERE k = ?`, [key]);
    },
    close: () => Promise.resolve(), // db lifecycle owned by the app
    setMulti: async (prefix, obj, prevKeys = []) => {
      const stmts: { sql: string; params?: unknown[] }[] = [];
      for (const [k, v] of Object.entries(obj)) {
        stmts.push({
          sql: `INSERT INTO aio_kv (k, v) VALUES (?, ?)
                ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
          params: [`${prefix}${SEP}${k}`, JSON.stringify(v) ?? "null"],
        });
      }
      for (const k of prevKeys) {
        if (!(k in obj)) {
          stmts.push({
            sql: `DELETE FROM aio_kv WHERE k = ?`,
            params: [`${prefix}${SEP}${k}`],
          });
        }
      }
      await db.transaction(stmts);
      return { ok: true as const, versionstamp: "" };
    },
    getMulti: async <T>(prefix: string) => {
      const { rows } = await db.query<{ k: string; v: string }>(
        `SELECT k, v FROM aio_kv WHERE k >= ? AND k < ?`,
        [`${prefix}${SEP}`, `${prefix}${SEP}${HIGH}`],
      );
      if (rows.length === 0) return null;
      const result: Record<string, unknown> = {};
      for (const r of rows) {
        result[r.k.slice(prefix.length + 1)] = JSON.parse(r.v);
      }
      return result as T;
    },
  };
}

/** One-time migration: copy a legacy Deno.Kv store into aio_kv. Best-effort,
 *  loud on success; the old file is left in place (never delete user data). */
export async function migrateLegacyKv(
  db: DB,
  kvPath: string | undefined,
  log: { info: (m: string) => void; warn: (m: string) => void },
): Promise<void> {
  // Only migrate once — if aio_kv has rows, migration already happened.
  const { rows } = await db.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM aio_kv`,
  );
  if ((rows[0]?.n ?? 0) > 0) return;
  // Feature-detect: new apps don't carry the unstable-kv flag, so openKv may
  // not exist — then there's nothing legacy to migrate.
  // deno-lint-ignore no-explicit-any
  const openKv = (Deno as any).openKv as
    | ((path?: string) => Promise<Deno.Kv>)
    | undefined;
  if (typeof openKv !== "function") return;
  let kv: Deno.Kv | null = null;
  try {
    kv = await openKv(kvPath);
    let copied = 0;
    const stmts: { sql: string; params?: unknown[] }[] = [];
    for await (const entry of kv.list({ prefix: [] })) {
      const key = entry.key.length === 1
        ? String(entry.key[0])
        : entry.key.map(String).join(SEP);
      stmts.push({
        sql: `INSERT OR IGNORE INTO aio_kv (k, v) VALUES (?, ?)`,
        params: [key, JSON.stringify(entry.value) ?? "null"],
      });
      copied++;
    }
    if (copied > 0) {
      await db.transaction(stmts);
      log.info(
        `persist: migrated ${copied} entr${
          copied === 1 ? "y" : "ies"
        } from legacy Deno.Kv → SQLite (old store left untouched)`,
      );
    }
  } catch {
    // No legacy store / KV unavailable — nothing to migrate.
  } finally {
    try {
      kv?.close();
    } catch { /* already closed */ }
  }
}
