// Shared types for async SQLite worker protocol

/** Result shape for all DB operations */
export type QueryResult<T = Record<string, unknown>> = {
  rows: T[]
  changes: number
  lastInsertRowId: bigint
}

/** Message payload — no id, used for constructing requests in the promise bridge */
export type WorkerMsg =
  | { type: 'open'; path: string; readonly?: boolean; pragmas?: string[] }
  | { type: 'query'; sql: string; params?: unknown[] }
  | { type: 'execute'; sql: string; params?: unknown[] }
  | { type: 'transaction'; stmts: { sql: string; params?: unknown[] }[] }
  | { type: 'close' }

export type WorkerRequest = WorkerMsg & { id: number }

export type WorkerResponse =
  | { id: number; ok: true; data: QueryResult | QueryResult[] }
  | { id: number; ok: false; error: string; stack?: string }

/** Framework-level async SQLite interface */
export interface DB {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>
  execute(sql: string, params?: unknown[]): Promise<QueryResult>
  transaction(stmts: { sql: string; params?: unknown[] }[]): Promise<QueryResult[]>
  close(): Promise<void>
}
