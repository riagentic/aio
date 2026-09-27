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
import {
  readTablesIn,
  statementVerb,
  writesRows,
  writeTablesIn,
} from "./sql-shape.ts";

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

  /** What SQLite itself does beyond the statement's text: a trigger on a
   *  table writes others, an `ON DELETE CASCADE` (or SET NULL / SET DEFAULT)
   *  rewrites the child, and a view reads its base tables. Matching the text
   *  alone left a live query on `mail` showing rows a cascade had deleted, a
   *  trigger's audit row never shown, and a query over a view never refreshed
   *  — silently. Read once from the schema, re-read after any DDL. */
  type Graph = {
    effects: Map<string, Set<string>>;
    views: Map<string, Set<string>>;
  };
  let graph: Promise<Graph | null> | null = null;
  const add = (m: Map<string, Set<string>>, k: string, v: string) => {
    let s = m.get(k);
    if (!s) m.set(k, s = new Set());
    s.add(v);
  };
  async function readGraph(): Promise<Graph | null> {
    try {
      const effects = new Map<string, Set<string>>();
      const views = new Map<string, Set<string>>();
      type Row = {
        type: string;
        name: string;
        tbl_name: string;
        sql: string | null;
      };
      // Read on the WRITER (a callback transaction): TEMP triggers and views
      // live in `sqlite_temp_master`, which is per CONNECTION — a reader's is
      // empty, so with `readers > 0` a temp trigger writing a table stayed
      // invisible and the live queries on that table stale.
      const { rows } = await (db.transaction as (
        fn: (tx: Tx) => Promise<QueryResult<Row>>,
      ) => Promise<QueryResult<Row>>)((tx) =>
        tx.query<Row>(
          "SELECT type, name, tbl_name, sql FROM sqlite_master " +
            "WHERE type IN ('table', 'view', 'trigger') UNION ALL " +
            "SELECT type, name, tbl_name, sql FROM sqlite_temp_master " +
            "WHERE type IN ('table', 'view', 'trigger')",
        )
      );
      for (const r of rows) {
        const name = r.name.toLowerCase();
        if (r.type === "view" && r.sql) {
          for (const t of readTablesIn(r.sql).tables) add(views, name, t);
        } else if (r.type === "trigger" && r.sql) {
          for (const t of writeTablesIn(r.sql)) {
            add(effects, r.tbl_name.toLowerCase(), t);
          }
        } else if (r.type === "table" && !name.startsWith("sqlite_")) {
          const fks = await db.query<
            { table: string; on_update: string; on_delete: string }
          >(`SELECT * FROM pragma_foreign_key_list(?)`, [r.name]);
          for (const fk of fks.rows) {
            const acts = [fk.on_update, fk.on_delete].map((a) =>
              String(a).toUpperCase()
            );
            if (acts.some((a) => a !== "NO ACTION" && a !== "RESTRICT")) {
              add(effects, String(fk.table).toLowerCase(), name);
            }
          }
        }
      }
      return { effects, views };
    } catch (err) {
      // Without the schema, refresh everything on every write: a superset is
      // slower, never stale. Said once, so it is not a mystery.
      if (!_unattributed.has("graph")) {
        _unattributed.add("graph");
        log.warn(
          "db",
          `reactive: could not read the schema for triggers, cascades and ` +
            `views (${err}) — every write now refreshes every live query`,
        );
      }
      return null;
    }
  }
  /** `start` plus everything reachable through `edges`. */
  const closure = (
    start: Iterable<string>,
    edges: Map<string, Set<string>>,
  ) => {
    const out = new Set(start);
    const todo = [...out];
    while (todo.length) {
      for (const n of edges.get(todo.pop()!) ?? []) {
        if (!out.has(n)) {
          out.add(n);
          todo.push(n);
        }
      }
    }
    return out;
  };
  /** A schema change: the graph is stale. A DROP or ALTER can also change
   *  what a live query returns (a dropped or renamed table), so those refresh
   *  every live query; a CREATE adds a table, trigger or view no live query
   *  has read yet, and changes no rows. `sql` absent: unknown, so refresh. */
  async function schemaChanged(sql?: string): Promise<void> {
    graph = null;
    if (sql === undefined || statementVerb(sql) !== "CREATE") {
      await invalidateAll();
    }
  }
  const isDDL = (sql: string) =>
    /^(CREATE|DROP|ALTER)$/.test(statementVerb(sql));

  async function invalidate(written: Set<string>): Promise<void> {
    if (written.size === 0 || entries.size === 0) return;
    const p = graph ??= readGraph();
    const g = await p;
    if (!g) {
      // A failure is not cached: one transient SQLITE_BUSY must not make
      // every later write refresh every live query until the next DDL.
      if (graph === p) graph = null;
      return invalidateAll();
    }
    const reach = closure(written, g.effects);
    for (const e of entries) {
      for (const t of closure(e.tables, g.views)) {
        if (reach.has(t)) {
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
      if (isDDL(sql)) await schemaChanged(sql);
      else if (writesRows(sql)) await invalidate(_written(sql));
      return r;
    },
    lastWriterError: db.lastWriterError?.bind(db),
    close: () => db.close(),
    // Pass-through: neither changes table contents, so no query invalidation.
    snapshot: db.snapshot ? (path: string) => db.snapshot!(path) : undefined,
    checkIntegrity: db.checkIntegrity ? () => db.checkIntegrity!() : undefined,

    async execute(sql: string, params?: unknown[]): Promise<QueryResult> {
      const r = await db.execute(sql, params);
      if (isDDL(sql)) await schemaChanged(sql);
      else await invalidate(_written(sql));
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
            // …and its SQL may have changed the schema, too.
            await schemaChanged();
            return r;
          });
      }
      const stmts = arg as { sql: string; params?: unknown[] }[];
      return (db.transaction as (s: typeof stmts) => Promise<QueryResult[]>)(
        stmts,
      )
        .then(async (r) => {
          const ddl = stmts.filter((s) => isDDL(s.sql));
          if (ddl.some((s) => statementVerb(s.sql) !== "CREATE")) {
            await schemaChanged();
            return r;
          }
          if (ddl.length) graph = null;
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
      // Re-runs overlap (two writes, two refreshes), and with reader workers
      // they can FINISH out of order: the older result landed last and left
      // the rows showing the state before the newer write. Each run takes a
      // ticket; a result older than one already applied is dropped.
      let issued = 0;
      let applied = 0;
      const rerun = async () => {
        const ticket = ++issued;
        const res = await db.query<T>(sql, params);
        if (ticket < applied) return;
        applied = ticket;
        // Copied in place (the array's identity is the contract), in a loop:
        // `push(...rows)` passes every row as an argument and overflows the
        // stack past ~150k rows.
        const next = res.rows;
        rows.length = next.length;
        for (let i = 0; i < next.length; i++) rows[i] = next[i]!;
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
      // Registered BEFORE the initial fill: a write that commits while the
      // fill is in flight (a reader worker answering from an older snapshot)
      // must re-run this query. Registered after, its invalidation had
      // already passed and the query kept the pre-write rows until some
      // unrelated write. The tickets drop the older result either way.
      const entry: Entry = { tables, rerun };
      entries.add(entry);
      try {
        await rerun(); // initial fill (no subscribers yet → no spurious notify)
      } catch (e) {
        entries.delete(entry);
        throw e;
      }
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
