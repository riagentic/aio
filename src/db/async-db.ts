// Main thread — promise bridge, lazy init, ready gate, optional read replicas

import type { DB, QueryResult, WorkerMsg, WorkerResponse } from './types.ts'

export const DEFAULT_PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA cache_size = -64000',  // 64MB
  'PRAGMA busy_timeout = 5000',
  'PRAGMA foreign_keys = ON',
]

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
  let nextId = 0
  let writerWorker: Worker | null = null
  let readerWorkers: Worker[] = []
  let readerIndex = 0
  let ready: Promise<void> | null = null

  // Wire a worker's message handler into the shared pending map
  function wire(w: Worker): void {
    w.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
      const p = pending.get(data.id)
      if (!p) return
      pending.delete(data.id)
      if (data.ok) p.resolve(data.data)
      else {
        const err = new Error(data.error)
        if (data.stack) err.stack = data.stack
        p.reject(err)
      }
    }
    w.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(`db worker error: ${e.message}`))
      pending.clear()
    }
  }

  // Send a message to a specific worker (no gate — used for open and close)
  function sendTo<T>(w: Worker, msg: WorkerMsg): Promise<T> {
    const id = nextId++
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
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

  return {
    // Reads route to replica pool (or writer if no replicas configured)
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
      return gate<QueryResult<T>>({ type: 'query', sql, params }, false)
    },
    // Writes always go to the single writer
    execute(sql: string, params?: unknown[]): Promise<QueryResult> {
      return gate<QueryResult>({ type: 'execute', sql, params })
    },
    transaction(stmts: { sql: string; params?: unknown[] }[]): Promise<QueryResult[]> {
      return gate<QueryResult[]>({ type: 'transaction', stmts })
    },
    async close(): Promise<void> {
      if (!ready) return
      await ensureWorkers()
      // Close all workers in parallel, then terminate
      await Promise.all([writerWorker!, ...readerWorkers].map(async (w) => {
        await sendTo<QueryResult>(w, { type: 'close' })
        w.terminate()
      }))
      writerWorker = null
      readerWorkers = []
      ready = null
    },
  }
}
