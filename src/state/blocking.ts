// blocking.ts — schedule.blocking(): a named, cancellable, backpressured worker
// pool for FFI/CPU/sync work. A wedged USB ioctl or a
// heavy compute runs OFF the main isolate, so it can never freeze rendering or
// the dispatch loop. Same family as schedule.after/every — named + cancellable —
// but imperative (returns a Promise), because it moves *work*, not an action.
//
// Contract: the function must be SELF-CONTAINED (no closure over outer scope —
// it's serialized to source and rebuilt in the worker) and its `arg`/result must
// be structured-cloneable. Do FFI/`Deno.dlopen` setup INSIDE the function.

type Task = {
  id: string;
  n: number;
  src: string;
  arg: unknown;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
};

type WorkerRes =
  | { n: number; ok: true; data: unknown }
  | { n: number; ok: false; error: string; stack?: string };

export type BlockingPool = {
  /** Run a self-contained fn off-thread; rejects if cancelled or the fn throws. */
  run<T = unknown>(
    id: string,
    fn: (arg?: unknown) => T | Promise<T>,
    arg?: unknown,
  ): Promise<T>;
  /** Cancel by id — a queued task is dropped; a running one terminates its
   *  worker (the only way to stop a busy thread). Returns true if it cancelled. */
  cancel(id: string): boolean;
  /** Terminate every worker and reject all in-flight/queued tasks. */
  dispose(): Promise<void>;
  /** Terminate IDLE workers when nothing is running or queued; keeps the pool
   *  usable (it respawns on demand). Returns false when work is in flight. */
  disposeIdle(): boolean;
  /** Max concurrent workers. */
  readonly size: number;
};

const DEFAULT_SIZE = (() => {
  const hw =
    (globalThis.navigator as { hardwareConcurrency?: number } | undefined)
      ?.hardwareConcurrency;
  return Math.max(1, (hw ?? 4) - 1); // leave a core for the main isolate
})();

const WORKER_URL = new URL("./blocking-worker.ts", import.meta.url);

export function createBlockingPool(opts?: { size?: number }): BlockingPool {
  const size = Math.max(1, opts?.size ?? DEFAULT_SIZE);
  const idle: Worker[] = [];
  const all = new Set<Worker>();
  const active = new Map<Worker, Task>();
  const queue: Task[] = [];
  let seq = 0;
  let disposed = false;

  function spawn(): Worker {
    const w = new Worker(WORKER_URL, { type: "module" });
    all.add(w);
    w.onmessage = ({ data }: MessageEvent<WorkerRes>) => {
      const task = active.get(w);
      if (!task || task.n !== data.n) return; // stale (cancelled) — ignore
      active.delete(w);
      if (data.ok) task.resolve(data.data);
      else {
        const err = new Error(data.error);
        if (data.stack) err.stack = data.stack;
        task.reject(err);
      }
      release(w);
    };
    w.onerror = (e) => {
      const task = active.get(w);
      if (task) {
        active.delete(w);
        task.reject(new Error(`blocking worker crashed: ${e.message}`));
      }
      retire(w); // don't reuse a crashed worker
      pump();
    };
    return w;
  }

  // A finished worker becomes available again; feed it the next queued task.
  function release(w: Worker): void {
    if (disposed) {
      retire(w);
      return;
    }
    idle.push(w);
    pump();
  }

  function retire(w: Worker): void {
    all.delete(w);
    active.delete(w);
    const i = idle.indexOf(w);
    if (i >= 0) idle.splice(i, 1);
    try {
      w.terminate();
    } catch { /* already gone */ }
  }

  function assign(w: Worker, task: Task): void {
    active.set(w, task);
    w.postMessage({ n: task.n, src: task.src, arg: task.arg });
  }

  // Backpressure: only `size` workers ever run at once; the rest wait in queue.
  function pump(): void {
    while (queue.length > 0) {
      let w = idle.pop();
      if (!w) {
        if (all.size >= size) break; // at capacity — leave the rest queued
        w = spawn();
      }
      assign(w, queue.shift()!);
    }
  }

  return {
    size,
    run<T>(id: string, fn: (arg?: unknown) => T | Promise<T>, arg?: unknown) {
      if (disposed) {
        return Promise.reject(new Error("blocking pool disposed"));
      }
      return new Promise<T>((resolve, reject) => {
        queue.push({
          id,
          n: ++seq,
          src: fn.toString(),
          arg,
          resolve: resolve as (v: unknown) => void,
          reject,
        });
        pump();
      });
    },
    cancel(id: string): boolean {
      // Queued task → just drop it.
      const qi = queue.findIndex((t) => t.id === id);
      if (qi >= 0) {
        const [t] = queue.splice(qi, 1);
        t!.reject(new Error(`blocking task '${id}' cancelled`));
        return true;
      }
      // Running task → terminate its worker (can't interrupt a busy thread) and
      // spawn a fresh one to keep capacity, then re-feed the queue.
      for (const [w, t] of active) {
        if (t.id === id) {
          t.reject(new Error(`blocking task '${id}' cancelled`));
          retire(w);
          pump();
          return true;
        }
      }
      return false;
    },
    disposeIdle(): boolean {
      // An app shutting down must not leave worker threads alive (they keep
      // the process — and a `testServer()` test run — from exiting), but the
      // pool is process-global: a SECOND app in the same isolate (D2,
      // libraryMode, every testServer pair) shares it, and a full dispose
      // would reject its in-flight tasks with "pool disposed". So: retire the
      // idle threads only, and only when nobody is using the pool at all. The
      // pool stays live and spawns again on the next run().
      if (active.size > 0 || queue.length > 0) return false;
      for (const w of [...all]) retire(w);
      return true;
    },
    async dispose(): Promise<void> {
      disposed = true;
      for (const t of queue.splice(0)) {
        t.reject(new Error("blocking pool disposed"));
      }
      for (const [, t] of active) t.reject(new Error("blocking pool disposed"));
      for (const w of [...all]) retire(w);
      await Promise.resolve();
    },
  };
}

// ── Process-global default pool (the schedule.blocking(...) entry) ───────────
let _pool: BlockingPool | null = null;
function pool(): BlockingPool {
  return (_pool ??= createBlockingPool());
}

/** Run a self-contained fn off the main thread. See BlockingPool.run. */
export function blocking<T = unknown>(
  id: string,
  fn: (arg?: unknown) => T | Promise<T>,
  arg?: unknown,
): Promise<T> {
  return pool().run(id, fn, arg);
}
/** Cancel a running/queued blocking task by id. */
blocking.cancel = (id: string): boolean => (_pool ? _pool.cancel(id) : false);
/** Terminate the global pool's IDLE workers (no-op when work is in flight, and
 *  when no pool was ever created). What app shutdown calls: threads must not
 *  outlive the app that spawned them, but the pool is process-global and a
 *  co-hosted app may still be using it. */
blocking.disposeIdle = (): boolean => (_pool ? _pool.disposeIdle() : true);
/** Tear down the global pool (terminate workers) — call on shutdown/in tests. */
blocking.dispose = async (): Promise<void> => {
  if (_pool) {
    await _pool.dispose();
    _pool = null;
  }
};
