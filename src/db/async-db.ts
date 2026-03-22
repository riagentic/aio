// Main thread — promise bridge, lazy init, ready gate, optional read replicas

import type { DB, Tx, QueryResult, WorkerMsg, WorkerResponse } from './types.ts'

/** Default SQLite PRAGMA statements for WAL mode, cache, and foreign keys */
export const DEFAULT_PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA cache_size = -64000',  // 64MB
  'PRAGMA busy_timeout = 5000',
  'PRAGMA foreign_keys = ON',
]

/** Options for createDB — readonly mode, custom pragmas, read replicas */
export type DBOpts = {
  readonly?: boolean
  pragmas?: string[]
  /** Spawn N additional readonly Workers on the same WAL-mode file.
   *  query() round-robins across readers; execute()/transaction() always go to the writer.
   *  Enables parallel reads without write contention. Default: 0 (writer-only). */
  readers?: number
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

/** Create an async SQLite DB backed by a dedicated Worker thread (+ optional read replicas).
 *  Workers spawn lazily on first call — zero overhead if SQLite is never used. */
export function createDB(path: string, opts: DBOpts = {}): DB {
  const pending = new Map<number, Pending>()
  // Track which pending IDs belong to which worker (for per-worker error isolation)
  const workerPending = new WeakMap<Worker, Set<number>>()
  let nextId = 0
  let writerWorker: Worker | null = null
  let readerWorkers: Worker[] = []
  let readerIndex = 0
  let ready: Promise<void> | null = null

  // Wire a worker's message handler into the shared pending map
  function wire(w: Worker): void {
    workerPending.set(w, new Set())
    w.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
      const p = pending.get(data.id)
      if (!p) return
      pending.delete(data.id)
      workerPending.get(w)?.delete(data.id)
      if (data.ok) p.resolve(data.data)
      else {
        const err = new Error(data.error)
        if (data.stack) err.stack = data.stack
        p.reject(err)
      }
    }
    w.onerror = (e) => {
      // Only reject requests belonging to THIS worker — don't cascade to other workers
      const ids = workerPending.get(w)
      if (ids) {
        for (const id of ids) {
          const p = pending.get(id)
          if (p) { p.reject(new Error(`db worker error: ${e.message}`)); pending.delete(id) }
        }
        ids.clear()
      }
    }
  }

  // Send a message to a specific worker (no gate — used for open and close)
  function sendTo<T>(w: Worker, msg: WorkerMsg): Promise<T> {
    const id = nextId++
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      workerPending.get(w)?.add(id)
      w.postMessage({ ...msg, id })
    })
  }

  // Spawn worker + send open, returns its ready promise
  function spawnAndOpen(readonly: boolean): { worker: Worker; opening: Promise<QueryResult> } {
    const w = new Worker(new URL('./db-worker.ts', import.meta.url), { type: 'module' })
    wire(w)
    const opening = sendTo<QueryResult>(w, {
      type: 'open', path, readonly,
      pragmas: opts.pragmas ?? DEFAULT_PRAGMAS,
    })
    return { worker: w, opening }
  }

  // Lazily spawn writer + all readers, wait for all to be ready
  function ensureWorkers(): Promise<void> {
    if (ready) return ready

    const numReaders = opts.readers ?? 0
    const { worker: w, opening: writerOpen } = spawnAndOpen(opts.readonly ?? false)
    writerWorker = w

    const readerOpenings: Promise<QueryResult>[] = []
    for (let i = 0; i < numReaders; i++) {
      const { worker: r, opening } = spawnAndOpen(true)
      readerWorkers.push(r)
      readerOpenings.push(opening)
    }

    ready = Promise.all([writerOpen, ...readerOpenings]).then(() => undefined)
    return ready
  }

  // Route to next reader (round-robin) if available, else writer
  function pickReader(): Worker {
    if (readerWorkers.length === 0) return writerWorker!
    const w = readerWorkers[readerIndex % readerWorkers.length]!
    readerIndex++
    return w
  }

  async function gate<T>(msg: WorkerMsg, toWriter = true): Promise<T> {
    await ensureWorkers()
    const w = toWriter ? writerWorker! : pickReader()
    return sendTo<T>(w, msg)
  }

  // Serial write lock — all writes (execute + transaction) queue through this so
  // standalone execute() calls can never interleave into an open transaction.
  let _writerLock: Promise<void> = Promise.resolve()
  let _inTransaction = false
  function withWriterLock<T>(fn: () => Promise<T>): Promise<T> {
    const result: Promise<T> = _writerLock.then(fn)
    _writerLock = result.then(() => {}, () => {}) // advance chain regardless of outcome
    return result
  }

  return {
    // Reads route to replica pool (or writer if no replicas configured)
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
      return gate<QueryResult<T>>({ type: 'query', sql, params }, false)
    },
    // Writes serialize through the lock so they can't sneak into an open transaction
    execute(sql: string, params?: unknown[]): Promise<QueryResult> {
      return withWriterLock(() => gate<QueryResult>({ type: 'execute', sql, params }))
    },
    // deno-lint-ignore no-explicit-any
    transaction(stmts_or_fn: { sql: string; params?: unknown[] }[] | ((tx: Tx) => Promise<any>)): Promise<any> {
      if (_inTransaction) throw new Error('nested db.transaction() would deadlock — use savepoints if needed')

      // Batch form: goes through write lock for consistency (no execute() can interleave)
      if (Array.isArray(stmts_or_fn)) {
        return withWriterLock(() => gate<QueryResult[]>({ type: 'transaction', stmts: stmts_or_fn }))
      }

      // Callback form: acquire write lock, BEGIN/COMMIT wrapping the async callback
      return withWriterLock(async () => {
        _inTransaction = true
        await gate<QueryResult>({ type: 'execute', sql: 'BEGIN' })
        const tx: Tx = {
          // tx.query goes to writer — must see current transaction's own writes
          query: <T>(sql: string, params?: unknown[]) => gate<QueryResult<T>>({ type: 'query', sql, params }, true),
          execute: (sql: string, params?: unknown[]) => gate<QueryResult>({ type: 'execute', sql, params }),
        }
        try {
          const result = await stmts_or_fn(tx)
          await gate<QueryResult>({ type: 'execute', sql: 'COMMIT' })
          return result
        } catch (e) {
          await gate<QueryResult>({ type: 'execute', sql: 'ROLLBACK' })
          throw e
        } finally {
          _inTransaction = false
        }
      })
    },
    async close(): Promise<void> {
      if (!ready) return
      await ensureWorkers()
      // Wait for all in-flight requests to settle before closing
      const allPending = [...pending.values()].map(p =>
        new Promise<void>(resolve => {
          const origResolve = p.resolve
          const origReject = p.reject
          p.resolve = (v) => { origResolve(v); resolve() }
          p.reject = (e) => { origReject(e); resolve() }
        })
      )
      if (allPending.length > 0) {
        await Promise.race([
          Promise.all(allPending),
          new Promise<void>(resolve => setTimeout(resolve, 5000)), // 5s max wait for pending
        ])
      }
      // Close all workers with 5s timeout — terminate regardless
      await Promise.all([writerWorker!, ...readerWorkers].map(async (w) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            sendTo<QueryResult>(w, { type: 'close' }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('close timeout')), 5000) }),
          ])
        } catch { /* timeout or worker error — terminate anyway */ }
        if (timer) clearTimeout(timer)
        w.terminate()
      }))
      writerWorker = null
      readerWorkers = []
      ready = null
    },
  }
}
