// Foreign store writes — a store saved by a run that kept no journal of it.
//
// The journal's tail is "writes newer than the store's last save": replayed
// at boot on top of the store. That is only true while every save of the
// store is a save this journal knows about. A run that saves the store and
// journals nothing — 1.0.9 with `journal: false`, a tool writing the file
// while the app is down — makes the store NEWER than the tail, and replaying
// the tail then rolls the newer data back (a `set` write) or applies it late.
// This build's own journal-off runs move the journal aside at boot
// (`moveJournalAside`); an older build does not.
//
// So the store notes foreign writes itself, in SQL: a trigger on every store
// row (the snapshot row(s) in `aio_kv`, every bound table) sets
// `aio_store_gen.dirty` — triggers live in the schema, so any build's writes
// fire them (1.0.9 runs them as plain SQL). Every save of this build clears
// it again as the last statement of its own transaction, with the record of
// the journal watermark it leaves (`planStoreGenRecord`) — so a committed
// `dirty = 1` means someone else wrote the store after this build's last
// save. At boot, dirty while the watermark is where the record left it ⇒ a
// writer that journals nothing saved the store after this journal's tail
// was written ⇒ the tail is stale. (A writer that journals — 1.0.9 with the
// journal on — moves the watermark, and its own tail governs.) The trigger
// writes once per transaction (the flag is read per row, set once).
//
// This build's own boot writes (a migrated snapshot, a scrubbed slice) set
// the flag too, until the boot records its picture of the store: a kill in
// that window reads as a foreign save next boot, and the journal is moved
// aside, loudly (never silently replayed or dropped).
import type { DB } from "../db/types.ts";
import type { SkvStmt } from "./skv.ts";

export const STORE_GEN_TABLE = "aio_store_gen";
/** The `aio_kv` row holding `{gen, wm}` as of this build's last journalled
 *  save (or boot). */
export const storeGenKey = (appId: string): string => `${appId}:__journal_gen`;

const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;
const ident = (s: string) => `"${s.replaceAll('"', '""')}"`;
/** Trigger names are identifiers derived from the table's: hex, so any table
 *  name maps to a valid, distinct one. */
const tag = (s: string) =>
  [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");

type Ev = { on: "INSERT" | "UPDATE" | "DELETE"; row: "NEW" | "OLD" };
const EVENTS: Ev[] = [
  { on: "INSERT", row: "NEW" },
  { on: "UPDATE", row: "NEW" },
  { on: "DELETE", row: "OLD" },
];

/** The snapshot row(s) of `persistKey`: the one row (single mode) or one per
 *  cell, keyed `<persistKey>\x1f<cell>` (multi mode). */
const kvWhen = (persistKey: string, row: string) =>
  `(${row}.k = ${lit(persistKey)} OR substr(${row}.k, 1, length(${
    lit(persistKey)
  }) + 1) = ${lit(persistKey)} || char(31))`;

const CLEAN = `(SELECT dirty FROM ${STORE_GEN_TABLE} WHERE id = 1) = 0`;
const SET_DIRTY =
  `BEGIN UPDATE ${STORE_GEN_TABLE} SET dirty = 1 WHERE id = 1; END`;

function triggers(persistKey: string, tables: readonly string[]): string[] {
  const out: string[] = [];
  for (const e of EVENTS) {
    const ev = e.on.toLowerCase();
    out.push(
      `CREATE TRIGGER IF NOT EXISTS aio_gen_kv_${ev} AFTER ${e.on} ON aio_kv ` +
        `WHEN ${kvWhen(persistKey, e.row)} AND ${CLEAN} ${SET_DIRTY}`,
    );
    for (const t of tables) {
      out.push(
        `CREATE TRIGGER IF NOT EXISTS aio_gen_t${tag(t)}_${ev} AFTER ${e.on} ` +
          `ON ${ident(t)} WHEN ${CLEAN} ${SET_DIRTY}`,
      );
    }
  }
  return out;
}

/** The last statements of every save of this build: the store is its own
 *  again, and `{wm}` records the journal watermark as it stands inside that
 *  transaction (after the watermark row the same save writes). */
export function planStoreGenRecord(appId: string, wmKey: string): SkvStmt[] {
  return [
    { sql: `UPDATE ${STORE_GEN_TABLE} SET dirty = 0 WHERE id = 1` },
    {
      sql: `INSERT INTO aio_kv (k, v)
              SELECT ?, json_object('wm', COALESCE(
                (SELECT CAST(v AS INTEGER) FROM aio_kv WHERE k = ?), 0))
              ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      params: [storeGenKey(appId), wmKey],
    },
  ];
}

/** Boot, before this build writes any store row: install the counter, read
 *  what it says, and cancel this connection's writes from here on.
 *  `foreign`: a writer that journals nothing saved the store since this
 *  build last recorded it. */
export async function bootStoreGen(
  db: DB,
  appId: string,
  persistKey: string,
  tables: readonly string[],
  wmKey: string,
  /** The journal is on: watch from here. Off: this run replays nothing, so
   *  the triggers are dropped (no cost), to be reinstalled by the next run
   *  with the journal on. */
  active: boolean,
): Promise<{ foreign: boolean }> {
  await db.execute(
    `CREATE TABLE IF NOT EXISTS ${STORE_GEN_TABLE} ` +
      `(id INTEGER PRIMARY KEY CHECK (id = 1), dirty INTEGER NOT NULL)`,
  );
  await db.execute(
    `INSERT OR IGNORE INTO ${STORE_GEN_TABLE} (id, dirty) VALUES (1, 0)`,
  );
  const { rows } = await db.query<
    { dirty: number; rec: string | null; wm: string | null }
  >(
    `SELECT dirty,
       (SELECT v FROM aio_kv WHERE k = ?) AS rec,
       (SELECT v FROM aio_kv WHERE k = ?) AS wm
     FROM ${STORE_GEN_TABLE} WHERE id = 1`,
    [storeGenKey(appId), wmKey],
  );
  const row = rows[0];
  let foreign = false;
  if (row && row.dirty === 1 && row.rec) {
    try {
      const rec = JSON.parse(row.rec) as { wm?: unknown };
      const wm = row.wm === null ? 0 : Number(JSON.parse(row.wm));
      foreign = rec.wm === wm;
    } catch { /* aio-ok: an unreadable record is no evidence either way */ }
  }
  // Recreated each boot: the persist key or the bound tables may have
  // changed since the last.
  const { rows: old } = await db.query<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'trigger' ` +
      `AND substr(name, 1, 8) = 'aio_gen_'`,
  );
  for (const { name } of old) {
    await db.execute(`DROP TRIGGER IF EXISTS ${ident(name)}`);
  }
  if (active) {
    for (const s of triggers(persistKey, tables)) await db.execute(s);
  }
  return { foreign };
}

/** Record this boot's picture of the store — once it has dealt with a stale
 *  journal (or found none). */
export async function recordStoreGen(
  db: DB,
  appId: string,
  wmKey: string,
): Promise<void> {
  await db.transaction(planStoreGenRecord(appId, wmKey));
}
