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
  /** Close all workers and release resources */
  close(): Promise<void>;
}
