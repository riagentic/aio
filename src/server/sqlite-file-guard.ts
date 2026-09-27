// A SQLite file deleted under a running process must fail loud.
//
// SQLite keeps writing into an unlinked inode: every commit "succeeds", and the
// data is gone at the next open. state.db guards this per persist window
// (`_dbFileGone` in persistence.ts); this is the same guard for a
// `DatabaseSync` that writes statement by statement (auth.db).

import type { DatabaseSync } from "node:sqlite";

/** A write refused because the database file was deleted under the process. */
export class DbFileGoneError extends Error {}

/** Make every write statement `db` prepares from here on throw while `path`
 *  is missing. Reads are untouched (the open inode still answers them); a
 *  `stat` error other than NotFound is not evidence of deletion — the write
 *  itself answers. `:memory:` and empty paths are never guarded. */
export function guardDeletedDbFile(
  db: DatabaseSync,
  path: string,
  what: string,
): void {
  if (path === "" || path === ":memory:") return;
  const prepare = db.prepare.bind(db);
  db.prepare = (sql: string) => {
    const st = prepare(sql);
    if (/^\s*(SELECT|PRAGMA)\b/i.test(sql)) return st;
    const run = st.run.bind(st);
    st.run = ((...args: Parameters<typeof run>) => {
      try {
        Deno.statSync(path);
      } catch (e) {
        if (e instanceof Deno.errors.NotFound) {
          throw new DbFileGoneError(
            `${what}: the database file is GONE (${path}) — it was deleted ` +
              `while the app was running, so this write would land in the ` +
              `unlinked file and vanish at the next start. Nothing was ` +
              `written. fix: restart the app (it creates a fresh database).`,
          );
        }
      }
      return run(...args);
    }) as typeof st.run;
    return st;
  };
}
