// stored-state.ts — read an app's PERSISTED state without booting it, and
// without writing a byte (`am state --offline`). Through aio's own store code:
// the worker-thread DB opened read-only, the `aio_kv` reader (`sqliteKv`) and
// the persistence-schema migration the boot applies — so a caller never
// hand-parses `aio_kv` and couples itself to the layout.
//
// What the snapshot holds is what the store holds: a `db:`-bound array lives
// in its SQL table and a `sync: true` cell in its op-log, not here, and a
// running app may be up to one persist window ahead of it.

import { createDB } from "../db/async-db.ts";
import { sqliteKv } from "./skv-sqlite.ts";
import { migrateSchema } from "./persist-schema.ts";
import { storedLayoutKey, storedPersistKeyKey } from "./boot-restore.ts";

/** The multi-layout row separator (skv-sqlite.ts). */
const SEP = "\x1f";

/** Pure: which persistKey the store's keys were written under. `state` (the
 *  default) when it is there; else the one head that is not an aio meta key
 *  (`<appId>:__…`, `aio:__…`); null for an empty store. Several candidates
 *  throw — guessing would answer with another document. */
export function _storedPersistKey(keys: readonly string[]): string | null {
  const heads = new Set(
    keys.map((k) => k.split(SEP, 1)[0]!).filter((h) => !/:__/.test(h)),
  );
  if (heads.has("state")) return "state";
  if (heads.size > 1) {
    throw new Error(
      `the store holds several documents (${
        [...heads].join(", ")
      }) and none is the default "state" — which one this app reads is its ` +
        `persistKey; it cannot be told from the store`,
    );
  }
  return heads.size === 1 ? [...heads][0]! : null;
}

/** The persisted state of app `appId` in the store at `dbPath`, opened
 *  read-only — null when nothing is stored. Framework-parked slices (`__…`)
 *  are not state and are left out. Throws on a store that cannot be opened,
 *  one written by a NEWER aio (`PERSIST_SCHEMA`), and an ambiguous one. A
 *  document in both layouts is read from the one the app boots on, as its
 *  boot recorded it (`storedLayoutKey`) — told to `warn`, as the boot says
 *  it. */
export async function readStoredState(
  dbPath: string,
  appId: string,
  warn?: (msg: string) => void,
): Promise<Record<string, unknown> | null> {
  await Deno.stat(dbPath); // NotFound says "no store here", not "cannot open"
  const db = createDB(dbPath, { readonly: true });
  try {
    const hasKv = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'aio_kv'`,
    );
    if (!hasKv.rows[0]?.n) return null;
    const { rows } = await db.query<{ k: string }>(`SELECT k FROM aio_kv`);
    const kv = sqliteKv(db);
    // The key this app's own saves stamped beats any guess from the rows.
    const stamped = await kv.get<string>(storedPersistKeyKey(appId));
    const key = typeof stamped === "string"
      ? stamped
      : _storedPersistKey(rows.map((r) => r.k));
    if (key === null) return null;
    const single = await kv.get<Record<string, unknown>>(key);
    const multi = await kv.getMulti<Record<string, unknown>>(key);
    // Key order aside (one blob vs rows ordered by key), the same document
    // twice is an interrupted layout migration — not an ambiguity.
    const canon = (v: unknown): string =>
      JSON.stringify(
        v,
        (_k, x) =>
          x && typeof x === "object" && !Array.isArray(x)
            ? Object.fromEntries(
              Object.entries(x).sort(([a], [b]) => a < b ? -1 : 1),
            )
            : x,
      );
    const isDoc = (v: unknown) =>
      !!v && typeof v === "object" && !Array.isArray(v);
    let doc = single ?? multi;
    // A leftover single row that is no document (`0`, `""`, `false`) beside
    // real rows: a multi-mode boot never reads it, so it is not what the app
    // runs on — unless the boot recorded "single", which refuses it below.
    if (single !== null && !isDoc(single) && isDoc(multi)) {
      const layout = await kv.get(storedLayoutKey(appId));
      if (layout !== "single") doc = multi;
    }
    if (isDoc(single) && multi && canon(single) !== canon(multi)) {
      const layout = await kv.get(storedLayoutKey(appId));
      if (layout !== "single" && layout !== "multi") {
        throw new Error(
          `"${key}" is stored in BOTH layouts with different contents — the ` +
            `app's persistMode decides which one it boots on; start it once ` +
            `and it says which copy it ignores`,
        );
      }
      doc = layout === "multi" ? multi : single;
      warn?.(
        `"${key}" is stored in BOTH layouts with different contents — read ` +
          `the "${layout}" one the app boots on; the "${
            layout === "multi" ? "single" : "multi"
          }" copy is IGNORED, as the app's boot says`,
      );
    }
    if (doc == null) return null;
    if (typeof doc !== "object" || Array.isArray(doc)) {
      throw new Error(
        `"${key}" holds ${
          JSON.stringify(doc).slice(0, 80)
        }, not an object of cells — the app refuses to boot over it`,
      );
    }
    const schema = await kv.get<number>(`${appId}:__schema`) ?? 0;
    const { state } = migrateSchema(doc, schema);
    return Object.fromEntries(
      Object.entries(state).filter(([k]) => !k.startsWith("__")),
    );
  } finally {
    await db.close();
  }
}
