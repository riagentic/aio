// Shared types for async SQLite worker protocol

/** Result shape for all DB operations */
export type QueryResult<T = Record<string, unknown>> = {
  rows: T[];
  changes: number;
  lastInsertRowId: bigint;
};

/** Message payload — no id, used for constructing requests in the promise bridge */
export type WorkerMsg =
  | { type: "open"; path: string; readonly?: boolean; pragmas?: string[] }
  | { type: "query"; sql: string; params?: unknown[] }
  | { type: "execute"; sql: string; params?: unknown[] }
  | { type: "transaction"; stmts: { sql: string; params?: unknown[] }[] }
  | { type: "close" };

/** Worker message with a correlation id for the promise bridge */
export type WorkerRequest = WorkerMsg & { id: number };

/** Success or error response sent back from the DB worker thread */
export type WorkerResponse =
  | { id: number; ok: true; data: QueryResult | QueryResult[] }
  | { id: number; ok: false; error: string; stack?: string };

/** Transaction context — subset of DB available inside a transaction callback */
export type Tx = {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
  execute(sql: string, params?: unknown[]): Promise<QueryResult>;
};

/** Framework-level async SQLite interface */
export interface DB {
  /** Run a read query — routes to replica pool if available */
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
  /** Run a write statement — serialized through the write lock */
  execute(sql: string, params?: unknown[]): Promise<QueryResult>;
  /** Batch: send pre-built statements as one atomic worker message */
  transaction(
    stmts: { sql: string; params?: unknown[] }[],
  ): Promise<QueryResult[]>;
  /** Callback: BEGIN/COMMIT wrapping an async function; rolls back on throw */
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Write a consistent copy of the database to `path` (SQLite `VACUUM INTO`).
   *
   *  Safe on a live database — SQLite takes the copy at a single point in time,
   *  so it is never half-written, and compacts it on the way out. This is the
   *  durable half of profile integrity: a rolling snapshot beside the app's
   *  data gives a corrupt file somewhere to come back to. `path` must not
   *  already exist.
   *
   *  Optional so a custom `DB` implementation (or a test fake) stays valid
   *  without it — aio's own `createDB` always provides it. */
  snapshot?(path: string): Promise<void>;
  /** Run SQLite's `PRAGMA quick_check` — the cheap integrity scan.
   *
   *  `ok: true` when the file is sound, otherwise the problems SQLite named.
   *  Cheap enough for boot: it skips the full index-content verification that
   *  `integrity_check` performs. */
  checkIntegrity?(): Promise<{ ok: boolean; problems: string[] }>;
  /** Close all workers and release resources */
  close(): Promise<void>;
  /** Returns the last error swallowed by the write-lock chain, or null if none.
   *  Primarily for diagnostics — callers should still await their own promise. */
  lastWriterError?(): Error | null;
}
