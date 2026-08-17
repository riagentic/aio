// Main thread — promise bridge, lazy init, ready gate, optional read replicas

import type {
  DB,
  QueryResult,
  Tx,
  WorkerMsg,
  WorkerResponse,
} from "./types.ts";
import { isCompiled } from "../server/paths.ts";
import { log } from "../diagnostics/logger-api.ts";

/** Marker phrase every "the db worker isn't in this binary" error carries, so
 *  the condition is recognised by ONE predicate wherever it surfaces. */
const DB_WORKER_MISSING = "db worker module is not embedded";

/** THE message for a compiled binary whose SQLite worker was never embedded.
 *
 *  `new Worker(new URL("./db-worker.ts", import.meta.url))` is invisible to
 *  `deno compile`'s module graph, so the worker is in the binary ONLY if it was
 *  passed with `--include`. The framework's own builder always passes it
 *  (`dbWorkerInclude()` in src/build/build-compile.ts, re-exported from
 *  `aio/build`); a hand-rolled `deno compile` of the app's entry does not — and
 *  the resulting binary boots, then dies on the first DB call. The message that
 *  used to reach the user ("Fix permissions or set persist: false") named a
 *  cause that is not this one, which is worse than no message. */
export function dbWorkerMissingMessage(workerUrl: string): string {
  return `${DB_WORKER_MISSING} — SQLite cannot start (looked for ${workerUrl}).

\`new Worker(new URL("./db-worker.ts", import.meta.url))\` is invisible to \`deno compile\`'s
module graph: the worker is only inside the binary if the build embedded it explicitly.

  deno compile -A --include <aio-src>/src/db/db-worker.ts  <your-entry.ts>

<aio-src> is wherever aio resolved for this build (dep/aio, node_modules/.deno/@riagentic+aio@…, …).
Don't hand-write that path — \`aio build\` / \`deno task build\` already pass it, and a custom
compile script can get the exact flags from \`import { dbWorkerInclude } from "aio/build"\`.

This is NOT a permissions problem, and \`persist: false\` is not the fix.`;
}

/** The corrected message for `e`, or null when `e` is some other db failure.
 *
 *  THE classifier: a missing worker surfaces as a `Module not found` worker
 *  error naming db-worker.ts (or, when the pre-flight below caught it first,
 *  already as the precise message). Every call site that would otherwise
 *  attribute a db failure to permissions asks here first. */
export function dbWorkerMissingHint(e: unknown): string | null {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes(DB_WORKER_MISSING)) return msg;
  return /module not found/i.test(msg) && msg.includes("db-worker.ts")
    ? `${msg}\n\n${dbWorkerMissingMessage("db-worker.ts")}`
    : null;
}

/** The pre-flight: the missing-worker message when `workerUrl` is NOT in this
 *  binary, else null. `compiled` is injected so the decision is testable.
 *
 *  `deno compile` materialises every embedded file in the binary's virtual FS
 *  next to the module, so a plain `stat` of the worker URL separates "embedded"
 *  from "not embedded" exactly (verified both ways: without `--include` the
 *  stat is NotFound and the Worker dies with `Module not found`; with it, both
 *  succeed). Uncompiled, the module graph IS the filesystem and there is
 *  nothing to check. Only NotFound blocks — any other stat failure (no read
 *  permission, an exotic FS) must never take down a binary that would work. */
export function dbWorkerMissingIn(
  workerUrl: URL,
  compiled: boolean,
): string | null {
  if (!compiled || workerUrl.protocol !== "file:") return null;
  try {
    Deno.statSync(workerUrl);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return dbWorkerMissingMessage(workerUrl.href);
    }
  }
  return null;
}

/** How many SQL statements `sql` contains — string literals, quoted
 *  identifiers and comments do not count. A `CREATE TRIGGER` body is one
 *  statement however many semicolons its `BEGIN … END` block holds. */
export function countSqlStatements(sql: string): number {
  if (
    /^\s*CREATE\s+(OR\s+REPLACE\s+)?(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(sql)
  ) {
    return 1;
  }
  let count = 0;
  let hasContent = false; // anything meaningful since the last ';'
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (c === "'" || c === '"' || c === "`") {
      hasContent = true;
      i++;
      while (i < sql.length) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) { // doubled → escaped, stay inside
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "[") {
      hasContent = true;
      while (i < sql.length && sql[i] !== "]") i++;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i++;
      continue;
    }
    if (c === ";") {
      if (hasContent) count++;
      hasContent = false;
      continue;
    }
    if (!/\s/.test(c)) hasContent = true;
  }
  if (hasContent) count++;
  return count;
}

/** The message for a multi-statement `execute()`, or null when `sql` is one
 *  statement. Rejecting is the fix, not multi-exec: single-statement execution
 *  is a security property the `am sql` route depends on. */
export function multiStatementRejection(sql: string): string | null {
  const n = countSqlStatements(sql);
  if (n <= 1) return null;
  return `db.execute() runs exactly ONE statement — this SQL has ${n}. ` +
    `SQLite prepares the FIRST and discards the rest, so a pasted ` +
    `multi-statement migration applied partially, returned changes: 0, and ` +
    `raised no error. Run them atomically instead:\n` +
    `  db.transaction([{ sql: "…" }, { sql: "…" }])\n` +
    `or call execute() once per statement. (One statement per call is also ` +
    `what keeps the \`am sql\` route from being a multi-statement injection ` +
    `surface, so it is enforced, not relaxed.)`;
}

/** Default SQLite PRAGMA statements for WAL mode, cache, and foreign keys */
export const DEFAULT_PRAGMAS = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = NORMAL",
  "PRAGMA cache_size = -64000", // 64MB
  "PRAGMA busy_timeout = 5000",
  "PRAGMA foreign_keys = ON",
];

/** Options for createDB — readonly mode, custom pragmas, read replicas */
export type DBOpts = {
  readonly?: boolean;
  pragmas?: string[];
  /** Spawn N additional readonly Workers on the same WAL-mode file.
   *  query() round-robins across readers; execute()/transaction() always go to the writer.
   *  Enables parallel reads without write contention. Default: 0 (writer-only). */
  readers?: number;
};

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** Create an async SQLite DB backed by a dedicated Worker thread (+ optional read replicas).
 *  Workers spawn lazily on first call — zero overhead if SQLite is never used. */
export function createDB(path: string, opts: DBOpts = {}): DB {
  const pending = new Map<number, Pending>();
  // Track which pending IDs belong to which worker (for per-worker error isolation)
  const workerPending = new WeakMap<Worker, Set<number>>();
  let nextId = 0;
  let writerWorker: Worker | null = null;
  let readerWorkers: Worker[] = [];
  let readerIndex = 0;
  let ready: Promise<void> | null = null;

  // Wire a worker's message handler into the shared pending map
  function wire(w: Worker): void {
    workerPending.set(w, new Set());
    w.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      workerPending.get(w)?.delete(data.id);
      if (data.ok) p.resolve(data.data);
      else {
        const err = new Error(data.error);
        if (data.stack) err.stack = data.stack;
        p.reject(err);
      }
    };
    w.onerror = (e) => {
      // Only reject requests belonging to THIS worker — don't cascade to other workers
      const ids = workerPending.get(w);
      if (ids) {
        for (const id of ids) {
          const p = pending.get(id);
          if (p) {
            p.reject(new Error(`db worker error: ${e.message}`));
            pending.delete(id);
          }
        }
        ids.clear();
      }
      // Terminate zombie worker and clear refs so next call respawns
      try {
        w.terminate();
      } catch { /* ignore */ }
      ready = null;
      if (writerWorker === w) writerWorker = null;
      readerWorkers = readerWorkers.filter((rw) => rw !== w);
    };
  }

  // Send a message to a specific worker (no gate — used for open and close)
  function sendTo<T>(w: Worker, msg: WorkerMsg): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      workerPending.get(w)?.add(id);
      w.postMessage({ ...msg, id });
    });
  }

  // Spawn worker + send open, returns its ready promise
  function spawnAndOpen(
    readonly: boolean,
  ): { worker: Worker; opening: Promise<QueryResult> } {
    const workerUrl = new URL("./db-worker.ts", import.meta.url);
    // Fail here, with the real cause, rather than as an opaque worker error
    // after the app has already booted and told the user it was fine.
    const missing = dbWorkerMissingIn(workerUrl, isCompiled());
    if (missing) throw new Error(missing);
    const w = new Worker(workerUrl, { type: "module" });
    wire(w);
    const opening = sendTo<QueryResult>(w, {
      type: "open",
      path,
      readonly,
      pragmas: opts.pragmas ?? DEFAULT_PRAGMAS,
    });
    return { worker: w, opening };
  }

  // Lazily spawn writer + all readers, wait for all to be ready.
  // Writer opens first so the file exists before readers try readonly open.
  function ensureWorkers(): Promise<void> {
    if (ready) return ready;

    let numReaders = opts.readers ?? 0;
    // AIO-421: an in-memory DB lives inside ONE Worker — reader Workers
    // would each open a SEPARATE empty `:memory:` DB and silently return no rows.
    // `createDB(":memory:")` is the intended ephemeral/test mode; keep it single-
    // Worker rather than let a stray `readers` option produce empty reads.
    if (numReaders > 0 && (path === ":memory:" || path === "")) {
      log.warn(
        "db",
        `readers>0 ignored for an in-memory DB — each Worker gets its ` +
          `own :memory: DB; using writer-only.`,
        { detail: String() },
      );
      numReaders = 0;
    }
    const { worker: w, opening: writerOpen } = spawnAndOpen(
      opts.readonly ?? false,
    );
    writerWorker = w;

    // NOTE deliberately NO `PRAGMA user_version` write here (or anywhere in
    // aio). `user_version` is the standard SQLite idiom for an APP's own
    // "have I run this migration" marker — stamping it on open silently
    // defeated exactly that in the field (a fresh file opened at 1, so every
    // `at >= version` app correction skipped). One integer cannot serve two
    // owners; the app owns it. aio tracks its own schema era in its private
    // `aio_schema` table instead (src/db/ddl.ts).
    ready = writerOpen.then(() => {
      const readerOpenings: Promise<QueryResult>[] = [];
      for (let i = 0; i < numReaders; i++) {
        const { worker: r, opening } = spawnAndOpen(true);
        readerWorkers.push(r);
        readerOpenings.push(opening);
      }
      return Promise.all(readerOpenings);
    }).then(() => undefined);
    return ready;
  }

  // Route to next reader (round-robin) if available, else writer
  function pickReader(): Worker {
    if (readerWorkers.length === 0) return writerWorker!;
    const w = readerWorkers[readerIndex % readerWorkers.length]!;
    readerIndex++;
    return w;
  }

  async function gate<T>(msg: WorkerMsg, toWriter = true): Promise<T> {
    await ensureWorkers();
    const w = toWriter ? writerWorker! : pickReader();
    return sendTo<T>(w, msg);
  }

  // Serial write lock — all writes (execute + transaction) queue through this so
  // standalone execute() calls can never interleave into an open transaction.
  let _writerLock: Promise<void> = Promise.resolve();
  let _inTransaction = false;
  let _lastWriterError: Error | null = null;
  function withWriterLock<T>(fn: () => Promise<T>): Promise<T> {
    const result: Promise<T> = _writerLock.then(fn);
    _writerLock = result.then(
      () => {},
      (err: Error) => {
        _lastWriterError = err;
        return undefined;
      },
    ); // advance chain regardless of outcome, but capture the error
    return result;
  }

  return {
    // Reads route to replica pool (or writer if no replicas configured)
    query<T = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<QueryResult<T>> {
      return gate<QueryResult<T>>({ type: "query", sql, params }, false);
    },
    // Writes serialize through the lock so they can't sneak into an open transaction
    execute(sql: string, params?: unknown[]): Promise<QueryResult> {
      const bad = multiStatementRejection(sql);
      if (bad) return Promise.reject(new Error(bad));
      return withWriterLock(() =>
        gate<QueryResult>({ type: "execute", sql, params })
      );
    },
    transaction(
      stmts_or_fn:
        | { sql: string; params?: unknown[] }[]
        // deno-lint-ignore no-explicit-any
        | ((tx: Tx) => Promise<any>),
      // deno-lint-ignore no-explicit-any
    ): Promise<any> {
      if (_inTransaction) {
        throw new Error(
          "nested db.transaction() would deadlock — use savepoints if needed",
        );
      }

      // Batch form: goes through write lock for consistency (no execute() can interleave)
      if (Array.isArray(stmts_or_fn)) {
        return withWriterLock(() =>
          gate<QueryResult[]>({ type: "transaction", stmts: stmts_or_fn })
        );
      }

      // Callback form: acquire write lock, BEGIN/COMMIT wrapping the async callback
      return withWriterLock(async () => {
        _inTransaction = true;
        try {
          await gate<QueryResult>({ type: "execute", sql: "BEGIN" });
          const tx: Tx = {
            // tx.query goes to writer — must see current transaction's own writes
            query: <T>(sql: string, params?: unknown[]) =>
              gate<QueryResult<T>>({ type: "query", sql, params }, true),
            execute: (sql: string, params?: unknown[]) => {
              const bad = multiStatementRejection(sql);
              if (bad) return Promise.reject(new Error(bad));
              return gate<QueryResult>({ type: "execute", sql, params });
            },
          };
          const result = await stmts_or_fn(tx);
          await gate<QueryResult>({ type: "execute", sql: "COMMIT" });
          return result;
        } catch (e) {
          // Only ROLLBACK if BEGIN succeeded (we're actually in a transaction)
          try {
            await gate<QueryResult>({ type: "execute", sql: "ROLLBACK" });
          } catch {
            /* ROLLBACK may fail if BEGIN never succeeded — safe to ignore */
          }
          throw e;
        } finally {
          _inTransaction = false;
        }
      });
    },
    lastWriterError(): Error | null {
      return _lastWriterError;
    },
    // `VACUUM INTO` runs on the WRITER and cannot sit inside a transaction, so
    // it goes through the same serial write lock every other write uses — a
    // snapshot can never catch a half-applied transaction.
    async snapshot(path: string): Promise<void> {
      await withWriterLock(() =>
        gate<QueryResult>({
          type: "execute",
          sql: "VACUUM INTO ?",
          params: [path],
        })
      );
    },
    async checkIntegrity(): Promise<{ ok: boolean; problems: string[] }> {
      const { rows } = await gate<QueryResult<{ quick_check: string }>>(
        { type: "query", sql: "PRAGMA quick_check" },
        false,
      );
      const problems = rows
        .map((r) => r.quick_check)
        .filter((v) => typeof v === "string" && v !== "ok");
      return { ok: problems.length === 0, problems };
    },
    async close(): Promise<void> {
      if (!ready) return;
      await ensureWorkers();
      // FIRST drain the writer-lock chain. A write queued BEHIND another has
      // not been posted to the worker yet, so it is absent from `pending` —
      // the loop below would not wait for it, `w.terminate()` would kill the
      // worker under it, and its `gate()` would then post to a dead worker:
      // the write silently lost and its promise never settling. On a dirty
      // shutdown that is the most recent state change.
      //
      // The chain never rejects (withWriterLock captures errors), and a write
      // that lands while we wait extends it — so re-check until it stops
      // moving, bounded by the same 5s ceiling the pending drain uses.
      {
        const deadline = Date.now() + 5000;
        for (let i = 0; i < 100; i++) {
          const chain = _writerLock;
          await Promise.race([
            chain,
            new Promise<void>((r) =>
              setTimeout(r, Math.max(0, deadline - Date.now()))
            ),
          ]);
          if (_writerLock === chain || Date.now() >= deadline) break;
        }
      }
      // Wait for all in-flight requests to settle before closing
      const allPending = [...pending.values()].map((p) =>
        new Promise<void>((resolve) => {
          const origResolve = p.resolve;
          const origReject = p.reject;
          p.resolve = (v) => {
            origResolve(v);
            resolve();
          };
          p.reject = (e) => {
            origReject(e);
            resolve();
          };
        })
      );
      if (allPending.length > 0) {
        await Promise.race([
          Promise.all(allPending),
          new Promise<void>((resolve) => setTimeout(resolve, 5000)), // 5s max wait for pending
        ]);
      }
      // Close all workers with 5s timeout — terminate regardless
      await Promise.all([writerWorker!, ...readerWorkers].map(async (w) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            sendTo<QueryResult>(w, { type: "close" }),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("close timeout")),
                5000,
              );
            }),
          ]);
        } catch { /* timeout or worker error — terminate anyway */ }
        if (timer) clearTimeout(timer);
        w.terminate();
      }));
      writerWorker = null;
      readerWorkers = [];
      ready = null;
      pending.clear(); // drop settled/stale entries so a respawn starts clean
    },
  };
}
