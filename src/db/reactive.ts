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

const READ_TABLES = /\b(?:from|join)\s+["'`]?([A-Za-z_]\w*)/gi;
const WRITE_TABLES =
  /\b(?:insert\s+into|update|delete\s+from|replace\s+into)\s+["'`]?([A-Za-z_]\w*)/gi;

/** Lowercased table names matched by `re` in `sql`. */
export function tablesIn(sql: string, re: RegExp): Set<string> {
  const out = new Set<string>();
  for (const m of sql.matchAll(re)) out.add(m[1]!.toLowerCase());
  return out;
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

  async function invalidate(written: Set<string>): Promise<void> {
    if (written.size === 0) return;
    for (const e of entries) {
      for (const t of e.tables) {
        if (written.has(t)) {
          await e.rerun();
          break;
        }
      }
    }
  }

  async function invalidateAll(): Promise<void> {
    for (const e of entries) await e.rerun();
  }

  return {
    query: (sql, params) => db.query(sql, params),
    lastWriterError: db.lastWriterError?.bind(db),
    close: () => db.close(),
    // Pass-through: neither changes table contents, so no query invalidation.
    snapshot: db.snapshot ? (path: string) => db.snapshot!(path) : undefined,
    checkIntegrity: db.checkIntegrity ? () => db.checkIntegrity!() : undefined,

    async execute(sql: string, params?: unknown[]): Promise<QueryResult> {
      const r = await db.execute(sql, params);
      await invalidate(tablesIn(sql, WRITE_TABLES));
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
            for (const t of tablesIn(s.sql, WRITE_TABLES)) written.add(t);
          }
          await invalidate(written);
          return r;
        });
    },

    async select<T = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<ReactiveQuery<T>> {
      const tables = tablesIn(sql, READ_TABLES);
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
            console.error(
              `[aio:db] a live-query subscriber threw — the write is COMMITTED ` +
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
