// reactive.ts — reactive SQL views. Wrap a DB so a `select(sql)` is
// a LIVE query: it re-runs and notifies whenever a write through this wrapper
// touches one of the tables it reads. Big data-heavy apps (10k-account wallets)
// keep derived views in SQL instead of paying full-array-in-RAM + manual
// recompute — the NFT-cache Worker dance becomes a one-liner.
//
// Change detection is by TABLE (parsed from the SQL): a write to a table
// invalidates every live query that reads it. Writes must go through this
// wrapper's execute/transaction for the feed to see them (direct writes to the
// underlying DB are invisible — that's the seam).
import type { DB, QueryResult, Tx } from "./types.ts";
import { log } from "../diagnostics/logger-api.ts";
import { readTablesIn, writesRows, writeTablesIn } from "./sql-shape.ts";

// Which tables a statement reads and writes — and whether it writes at all —
// is answered by `sql-shape.ts`, the same lexer `db.query()`'s writer-lock gate
// uses. This file used to carry its own two regexes, and every shape they
// missed was a live query that silently stopped refreshing: `INSERT OR IGNORE
// INTO mail` (no table), `UPDATE OR IGNORE mail` (the table "or"),
// `FROM main.mail` (the table "main"), `FROM [mail]` (none), `FROM folders,
// mail` (only "folders"), and a `WITH … DELETE` or `INSERT … RETURNING` sent
// through `query()` (never invalidated anything).
//
// This file's own rule: "Loud, never silent — a live query that stopped
// refreshing is a UI quietly showing stale rows, which is exactly what this
// file exists to prevent."
const _unattributed = new Set<string>();

/** Warn once per shape when a write names no table this can invalidate. */
function _warnUnattributed(sql: string): void {
  const head = sql.trim().slice(0, 60);
  if (_unattributed.has(head)) return;
  _unattributed.add(head);
  log.warn(
    `reactive: could not tell which table this write touches, so no live ` +
      `query was refreshed — rows already on screen are now stale: ` +
      `${head}${sql.trim().length > 60 ? "…" : ""}`,
  );
}

/** Warn once per shape when a live query names no table a write could
 *  invalidate — it would be filled once and then never refresh. */
function _warnUnattributedRead(sql: string): void {
  const head = "read:" + sql.trim().slice(0, 60);
  if (_unattributed.has(head)) return;
  _unattributed.add(head);
  log.warn(
    `reactive: could not tell which table this live query reads, so no ` +
      `write will ever refresh it — its rows stay as they are now: ` +
      `${sql.trim().slice(0, 60)}${sql.trim().length > 60 ? "…" : ""}. ` +
      `Name the table plainly in FROM/JOIN, or call refresh() yourself.`,
  );
}

/** The tables a write statement touches, warning when it writes but names
 *  none this wrapper can recognise. */
function _written(sql: string): Set<string> {
  const touched = writeTablesIn(sql);
  if (touched.size === 0 && writesRows(sql)) _warnUnattributed(sql);
  return touched;
}

/** @internal test seam — forget which unattributed writes have been reported.
 *  The dedupe is per PROCESS on purpose (the same statement repeats on every
 *  write), so a test that wants to observe the warning has to clear it.
 *  Product code must never call this: clearing it would repeat the line on
 *  every write of a hot path, which is what the dedupe exists to stop. */
// aio-ok: a test-only reset; calling it from product code is the bug it guards
export function _resetReactiveWarnings(): void {
  _unattributed.clear();
}

/** A live SQL query — its rows stay current as writes land, and subscribers are
 *  notified on every refresh. Dispose it when the view goes away. */
export type ReactiveQuery<T = Record<string, unknown>> = {
  /** Latest rows — refreshed in place after each invalidating write. */
  readonly rows: T[];
  /** Tables this query reads (what it's invalidated by). */
  readonly tables: ReadonlySet<string>;
  /** Notify on every subsequent refresh; returns an unsubscribe fn. */
  subscribe(cb: (rows: T[]) => void): () => void;
  /** Force a re-run + notify now. */
  refresh(): Promise<void>;
  /** Stop tracking this query (removes it from the change feed). */
  dispose(): void;
};

/** A `DB` whose `select()` returns live queries instead of a one-shot snapshot. */
export type ReactiveDB = DB & {
  /** A live query: re-runs + notifies whenever a write touches its tables. */
  select<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<ReactiveQuery<T>>;
};

type Entry = { tables: Set<string>; rerun: () => Promise<void> };

/** Wrap a `DB` so `select()` yields live queries — every write invalidates the
 *  queries that read the written tables and re-runs exactly those. */
export function reactiveDB(db: DB): ReactiveDB {
  const entries = new Set<Entry>();

  /** Refresh one live query on the WRITE path, where a throw would be a lie.
   *
   *  The subscriber half of this is isolated where the callbacks are called
   *  (see `rerun`), but the re-run itself — `db.query(sql)` — can throw too: a
   *  busy database, a view whose SQL no longer resolves. That throw travelled
   *  the same road (`invalidate` → `execute`/`transaction`) and rejected a
   *  write that had ALREADY COMMITTED, so the caller retries a landed write or
   *  reports a failure that did not happen. One rule for the whole path: after
   *  the commit, nothing a REFRESH does can describe the write as undone.
   *
   *  Loud, never silent — a live query that stopped refreshing is a UI quietly
   *  showing stale rows, which is exactly what this file exists to prevent.
   *
   *  The initial fill in `select()` is deliberately NOT routed through here: no
   *  write has happened there, and a query that cannot run must fail at the
   *  `select()` that asked for it. */
  async function refreshAfterWrite(e: Entry): Promise<void> {
    try {
      await e.rerun();
    } catch (err) {
      log.error(
        "db",
        `a live query failed to refresh after a write — the write is ` +
          `COMMITTED, and this query's rows are now STALE: ${err}`,
      );
    }
  }

  async function invalidate(written: Set<string>): Promise<void> {
    if (written.size === 0) return;
    for (const e of entries) {
      for (const t of e.tables) {
        if (written.has(t)) {
          await refreshAfterWrite(e);
          break;
        }
      }
    }
  }

  async function invalidateAll(): Promise<void> {
    for (const e of entries) await refreshAfterWrite(e);
  }

  return {
    // A write can arrive through `query()` too — `INSERT … RETURNING` is
    // only readable that way — and it changes rows exactly like `execute()`.
    async query<T = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<QueryResult<T>> {
      const r = await db.query<T>(sql, params);
      if (writesRows(sql)) await invalidate(_written(sql));
      return r;
    },
    lastWriterError: db.lastWriterError?.bind(db),
    close: () => db.close(),
    // Pass-through: neither changes table contents, so no query invalidation.
    snapshot: db.snapshot ? (path: string) => db.snapshot!(path) : undefined,
    checkIntegrity: db.checkIntegrity ? () => db.checkIntegrity!() : undefined,

    async execute(sql: string, params?: unknown[]): Promise<QueryResult> {
      const r = await db.execute(sql, params);
      await invalidate(_written(sql));
      return r;
    },

    // deno-lint-ignore no-explicit-any
    transaction(arg: any): any {
      if (typeof arg === "function") {
        // Callback form — the SQL isn't visible up front, so invalidate every
        // live query after commit (a correct superset; never misses a change).
        return (db.transaction as (
          fn: (tx: Tx) => Promise<unknown>,
        ) => Promise<unknown>)(arg)
          .then(async (r) => {
            await invalidateAll();
            return r;
          });
      }
      const stmts = arg as { sql: string; params?: unknown[] }[];
      return (db.transaction as (s: typeof stmts) => Promise<QueryResult[]>)(
        stmts,
      )
        .then(async (r) => {
          const written = new Set<string>();
          for (const s of stmts) {
            for (const t of _written(s.sql)) written.add(t);
          }
          await invalidate(written);
          return r;
        });
    },

    async select<T = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<ReactiveQuery<T>> {
      const read = readTablesIn(sql);
      if (read.unattributed) _warnUnattributedRead(sql);
      const tables = read.tables;
      const rows: T[] = [];
      const subs = new Set<(r: T[]) => void>();
      const rerun = async () => {
        const res = await db.query<T>(sql, params);
        rows.length = 0;
        rows.push(...res.rows);
        // Subscribers are APP code, and app code has bugs. A throw here used
        // to propagate out of `rerun` → `invalidate` → `execute`/`transaction`,
        // so `db.execute()` REJECTED for a write that had already committed:
        // the caller either retries (duplicate write) or reports a failure that
        // did not happen. The write is done; a listener's bug cannot un-do it,
        // and must not be able to describe it as undone.
        for (const cb of subs) {
          try {
            cb(rows);
          } catch (e) {
            log.error(
              "db",
              `a live-query subscriber threw — the write is COMMITTED ` +
                `and the other subscribers still ran: ${e}`,
            );
          }
        }
      };
      await rerun(); // initial fill (no subscribers yet → no spurious notify)
      const entry: Entry = { tables, rerun };
      entries.add(entry);
      return {
        get rows() {
          return rows;
        },
        tables,
        subscribe(cb) {
          subs.add(cb);
          return () => subs.delete(cb);
        },
        refresh: rerun,
        dispose() {
          entries.delete(entry);
          subs.clear();
        },
      };
    },
  };
}
