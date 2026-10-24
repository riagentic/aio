import { log } from "../diagnostics/logger-api.ts";
import { blockingServerOnly } from "./blocking-reason.ts";
import { callSignal } from "./call-signal.ts";
import { abortedByShutdown } from "./method-cancel.ts";

// blocking.ts — schedule.blocking(): a named, cancellable, backpressured worker
// pool for FFI/CPU/sync work. A wedged USB ioctl or a
// heavy compute runs OFF the main isolate, so it can never freeze rendering or
// the dispatch loop. Same family as schedule.after/every — named + cancellable —
// but imperative (returns a Promise), because it moves *work*, not an action.
//
// Contract: the function must be SELF-CONTAINED (no closure over outer scope —
// it's serialized to source and rebuilt in the worker) and its `arg`/result must
// be structured-cloneable. Do FFI/`Deno.dlopen` setup INSIDE the function.
//
// Or hand the POOL a module instead of a function: `pool.run(id, new
// URL("./job.ts", import.meta.url), arg)` — the worker imports it and calls its
// default export.
// A real module has its own imports, constants and helpers, and no build
// transform (minify, a bundler helper) can change what its text means.

type Task = {
  id: string;
  n: number;
  src: string;
  /** `fn.name` — re-applied in the worker (see blocking-worker.ts). */
  name: string;
  /** The module form: the worker imports this and calls its default export. */
  url?: string;
  arg: unknown;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
};

type WorkerRes =
  | { n: number; ok: true; data: unknown }
  | { n: number; ok: false; error: string; stack?: string };
/** An uncaught error on a worker's loop and the task it belongs to (see
 *  blocking-worker.ts); `id` is absent when it ran outside every task. */
type WorkerStray = {
  stray: true;
  n: number;
  id?: string;
  error: string;
  stack?: string;
};

export type BlockingPool = {
  /** Run a self-contained fn — or a module's default export, given its URL —
   *  off-thread; rejects if cancelled or the fn throws. */
  run<T = unknown>(
    id: string,
    fn: ((arg?: unknown) => T | Promise<T>) | URL,
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
  /** The ids of the tasks holding the pool open — what a refused
   *  `disposeIdle()` is waiting for. Empty when nothing is in flight. */
  inFlight(): string[];
  /** Max concurrent workers. */
  readonly size: number;
};

/** The default pool size — read on first use, not at import: a module-scope
 *  initializer is a statement no bundler can drop, so it rode along into every
 *  bundle that merely re-exported this module. */
const defaultSize = (): number => {
  const hw =
    (globalThis.navigator as { hardwareConcurrency?: number } | undefined)
      ?.hardwareConcurrency;
  return Math.max(1, (hw ?? 4) - 1); // leave a core for the main isolate
};

/**
 * Where the worker module lives — resolved on FIRST USE, not at import.
 *
 * This used to be a module-level `new URL(..., import.meta.url)`. In a bundle
 * there is no module URL to be relative to: esbuild rewrites `import.meta` to a
 * shim whose `url` is not a valid absolute URL, so the constructor threw while
 * the module was still evaluating — before any app code ran, and long before
 * anything asked for a worker. One `throw` at that point takes the WHOLE bundle
 * down, so an Android app that never calls `schedule.blocking()` came up as a
 * blank screen with a single `Failed to construct 'URL'` in the console and no
 * line of its own in the stack.
 *
 * Deferring it means a bundle that never spawns a worker never builds the URL,
 * and one that does gets an error naming the thing it actually asked for.
 */
let _workerUrl: URL | string | null = null;
function workerUrl(): URL | string {
  if (_workerUrl) return _workerUrl;
  try {
    _workerUrl = new URL("./blocking-worker.ts", import.meta.url);
  } catch {
    throw new Error(
      "schedule.blocking() needs a module URL to start its worker from, and " +
        "this build has none (a bundled/standalone target). Run the blocking " +
        "work on the server, or keep it on the main thread.",
    );
  }
  return _workerUrl;
}

/** Classify a worker startup failure, or null when it is something else.
 *
 *  `new Worker(new URL("./blocking-worker.ts", import.meta.url))` is invisible
 *  to `deno compile`'s module graph, so a binary built without `--include` for
 *  it runs perfectly on the build box — where the VFS falls through to the real
 *  file still on disk — and dies in the user's hands with a bare
 *  `Module not found`, from a file they have never heard of, naming a path
 *  inside `/tmp/deno-compile-…`. Same failure, and the same answer, as
 *  `db-worker.ts` (see `src/db/async-db.ts`). Pure. */
export function blockingWorkerMissingHint(message: string): string | null {
  if (!/module not found/i.test(message)) return null;
  if (!message.includes("blocking-worker.ts")) return null;
  return `${message}\n\n` +
    `schedule.blocking() runs its work in a Worker, and this binary does not ` +
    `carry the worker module. \`new Worker(new URL(…))\` is invisible to ` +
    `\`deno compile\`'s module graph, so the module has to be embedded ` +
    `explicitly:\n` +
    `    deno compile -A --include <aio-src>/src/state/blocking-worker.ts <your-entry.ts>\n` +
    `aio's own build does this; a hand-rolled compile script gets the exact ` +
    `flags from \`import { dbWorkerInclude } from "aio/build"\`. This is NOT a ` +
    `permissions problem and NOT a bug in your function.`;
}

/** The rejection of a task whose calling method the app's shutdown aborted. */
function shutdownError(id: string): Error {
  const e = new Error(
    `blocking task '${id}' stopped: the method that started it was aborted ` +
      `by the app's shutdown (s.$signal)`,
  );
  e.name = "AbortError";
  return e;
}

export function createBlockingPool(opts?: { size?: number }): BlockingPool {
  const size = Math.max(1, opts?.size ?? defaultSize());
  const _warnedDupId = new Set<string>();
  const idle: Worker[] = [];
  const all = new Set<Worker>();
  const active = new Map<Worker, Task>();
  const queue: Task[] = [];
  /** Workers a settled task's stray landed on: retired once their running
   *  task settles, never reused (their loop may hold more of it). */
  const tainted = new WeakSet<Worker>();
  /** Per worker: 1 while it is inside its task's synchronous call. */
  const busyFlag = new WeakMap<Worker, Int32Array>();
  let seq = 0;
  let disposed = false;

  function spawn(): Worker {
    const w = new Worker(workerUrl(), { type: "module" });
    all.add(w);
    busyFlag.set(w, new Int32Array(new SharedArrayBuffer(4)));
    w.onmessage = ({ data }: MessageEvent<WorkerRes | WorkerStray>) => {
      const task = active.get(w);
      if ("stray" in data) {
        if (task && task.n === data.n) {
          // The running task's own: its crash, as an uncaught error always
          // was — a task that never settles would otherwise hang its caller.
          active.delete(w);
          const err = new Error(`blocking worker crashed: ${data.error}`);
          if (data.stack) err.stack = `${err.message}\n${data.stack}`;
          task.reject(err);
          retire(w);
          pump();
          return;
        }
        // A settled task's leftover (or nobody's): reported under its own id,
        // and the task running now goes on. The worker is not reused after it.
        log.error(
          "blocking",
          (data.id !== undefined
            ? `blocking task '${data.id}' left an uncaught error behind ` +
              `after it settled: `
            : `an idle blocking worker crashed: `) + (data.stack ?? data.error),
        );
        if (task) tainted.add(w);
        else {
          retire(w);
          pump();
        }
        return;
      }
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
      const hint = blockingWorkerMissingHint(e.message ?? "");
      // ALWAYS handled here: the crash is reported — as the task's rejection,
      // or logged below when nothing was in flight. Un-prevented, Deno
      // re-raised any crash but the missing-module one in the PARENT isolate,
      // so one stray throw in a blocking task took the whole server down (the
      // worker-cell host has always prevented).
      e.preventDefault?.();
      if (task) {
        active.delete(w);
        task.reject(
          new Error(hint ?? `blocking worker crashed: ${e.message}`),
        );
      } else if (hint) {
        // Nothing was in flight to reject — the module is missing for every
        // task that will ever run here, so say it once rather than let a bare
        // "Module not found" reach the user with no context.
        log.error("blocking", hint);
      } else {
        // An IDLE worker died (a stray timer or FFI callback after its task
        // settled): nothing to reject, and no longer re-raised — so say it.
        log.error("blocking", `an idle blocking worker crashed: ${e.message}`);
      }
      retire(w); // don't reuse a crashed worker
      pump();
    };
    return w;
  }

  // A finished worker becomes available again; feed it the next queued task.
  function release(w: Worker): void {
    if (disposed || tainted.has(w)) {
      retire(w);
      pump();
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
    } catch {
      // aio-ok: worker may already be gone — retire's terminate is best-effort
      // teardown and its absence is the outcome we want.
    }
  }

  function assign(w: Worker, task: Task): void {
    active.set(w, task);
    try {
      w.postMessage({
        n: task.n,
        id: task.id,
        src: task.src,
        name: task.name,
        url: task.url,
        arg: task.arg,
        busy: busyFlag.get(w)!.buffer,
      });
    } catch (e) {
      // `postMessage` refuses an uncloneable `arg` SYNCHRONOUSLY. The throw
      // used to unwind out of `pump()` and out of the caller's promise
      // executor — so the caller was rejected (fine) and the worker was left
      // in `active` FOREVER: never released, never retired, capacity
      // permanently one lower. On a 2-core box (`defaultSize()` = hw-1 = 1)
      // that means every later `blocking()` call returns a promise that never
      // settles, and `disposeIdle()` returns false at shutdown so the process
      // cannot exit — a silent hang, from one bad argument.
      //
      // Same words as the worker-cell boundary (`cell-worker.ts`), because it
      // is the same mistake: one message, one clone, one explanation.
      active.delete(w);
      retire(w);
      task.reject(
        new Error(
          `blocking("${task.id}") argument cannot cross a worker boundary: ${
            e instanceof Error ? e.message : String(e)
          }.\nIt is reached by postMessage, so the argument is ` +
            `structured-cloned. Pass plain data (no functions, class ` +
            `instances, or live cell proxies); \`{ ...obj }\` off a proxy is ` +
            `already materialised.`,
        ),
      );
    }
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

  /** Drop every queued task `match` picks and stop every running one —
   *  rejected with `err`. Returns whether any matched. */
  function cancelWhere(match: (t: Task) => boolean, err: Error): boolean {
    let cancelled = false;
    for (let i = queue.length - 1; i >= 0; i--) {
      if (!match(queue[i]!)) continue;
      const [t] = queue.splice(i, 1);
      t!.reject(err);
      cancelled = true;
    }
    // Running task → terminate its worker (can't interrupt a busy thread) and
    // spawn a fresh one to keep capacity, then re-feed the queue.
    for (const [w, t] of [...active]) {
      if (match(t)) {
        // Deno's terminate() does not interrupt running synchronous code
        // (Deno 2.9.7, measured): a cancelled CPU loop kept its core until
        // it returned, outside the pool's size — three cancels on a size-1
        // pool left three cores busy. The caller is released either way;
        // the thread's survival is said, not hidden.
        if (Atomics.load(busyFlag.get(w)!, 0) === 1) {
          log.warn(
            "blocking",
            `blocking task '${t.id}' was cancelled inside synchronous code ` +
              `(a CPU loop, a *Sync or FFI call). Its caller is released, ` +
              `but Deno cannot interrupt synchronous code: the thread keeps ` +
              `running — and a CPU core busy — until that call returns, ` +
              `outside the pool's limit of ${size}. To make a long task ` +
              `stoppable, yield between chunks of work ` +
              `(\`await new Promise((r) => setTimeout(r))\`) — a cancel ` +
              `stops it at the next yield.`,
          );
        }
        t.reject(err);
        retire(w);
        cancelled = true;
      }
    }
    if (cancelled) pump();
    return cancelled;
  }

  return {
    size,
    run<T>(
      id: string,
      fn: ((arg?: unknown) => T | Promise<T>) | URL,
      arg?: unknown,
    ) {
      if (disposed) {
        return Promise.reject(new Error("blocking pool disposed"));
      }
      const isUrl = fn instanceof URL;
      // A source STRING (`"(a) => a * 2"`) — and anything else whose
      // `toString()` is a function's text — ran through 1.0.19 untyped: the
      // task has always been `fn.toString()`, rebuilt in the worker. It still
      // does, identically. What never ran (a number, null) is named here.
      const isText = typeof fn === "string" ||
        (typeof fn === "object" && fn !== null);
      if (!isUrl && !isText && typeof fn !== "function") {
        return Promise.reject(
          new Error(
            `blocking('${id}', …): the second argument must be a function or ` +
              `a module URL (new URL("./job.ts", import.meta.url)) — got ${
                fn === null ? "null" : typeof fn
              }`,
          ),
        );
      }
      // A second task under an id that is already in flight is almost always a
      // mistake: `schedule.after(id, …)` REPLACES by id, so an app reasonably
      // reads an id as a slot. Here it is a group — both run, and their results
      // are indistinguishable to the caller. Dev-only, once per id, observe-only.
      if (
        (globalThis as Record<string, unknown>).__aioDev === true &&
        !_warnedDupId.has(id) &&
        (queue.some((t) => t.id === id) ||
          [...active.values()].some((t) => t.id === id))
      ) {
        _warnedDupId.add(id);
        log.warn(
          "blocking",
          `a second task started under id '${id}' while the ` +
            `first is still in flight. Unlike schedule.after(id, …), blocking ` +
            `ids do NOT replace: both run, and cancel('${id}') stops BOTH. ` +
            `Use a distinct id per task if you need to cancel them separately. ` +
            `(dev only, once per id)`,
        );
      }
      // Started from a method body: the app's SHUTDOWN aborting that call
      // ends its task too. The method's caller is released at the drain
      // deadline either way; the task kept its worker thread — and in
      // libraryMode / `testServer()` the process — alive after the app had
      // closed. (A cancelOn abort is left alone: the body may still want the
      // result it is awaiting.)
      const sig = callSignal();
      if (sig && abortedByShutdown(sig)) {
        return Promise.reject(shutdownError(id));
      }
      const p = new Promise<T>((resolve, reject) => {
        queue.push({
          id,
          n: ++seq,
          ...(isUrl
            ? { src: "", name: "", url: fn.href }
            : { src: fn.toString(), name: fn.name }),
          arg,
          resolve: resolve as (v: unknown) => void,
          // A string that is not a function's text (a path, say) fails in
          // the worker's parse, with nothing saying what a string means here.
          reject: typeof fn === "string"
            ? (e) => {
              if (e instanceof Error) {
                e.message += `\n\nblocking('${id}', "…"): a string is run ` +
                  `as the SOURCE of a function ("(arg) => …"). For a module, ` +
                  `pass new URL("./job.ts", import.meta.url).`;
              }
              reject(e);
            }
            : reject,
        });
        pump();
      });
      if (sig) {
        const n = seq;
        const onAbort = () => {
          if (abortedByShutdown(sig)) {
            cancelWhere((t) => t.n === n, shutdownError(id));
          }
        };
        sig.addEventListener("abort", onAbort, { once: true });
        const off = () => sig.removeEventListener("abort", onAbort);
        p.then(off, off);
      }
      return p;
    },
    cancel(id: string): boolean {
      // EVERY task under this id — queued and running alike.
      //
      // It used to stop at the first match: one queued task, or (only if none
      // was queued) one running task. `blocking("scan", …)` called twice
      // concurrently — which nothing prevents — left `cancel("scan")` reporting
      // true with the other copy still burning a thread, and a caller who
      // cancelled precisely to stop the work had no way to know. "Cancel by id"
      // means the id, not one arbitrary holder of it.
      return cancelWhere(
        (t) => t.id === id,
        new Error(`blocking task '${id}' cancelled`),
      );
    },
    inFlight(): string[] {
      return [
        ...[...active.values()].map((t) => t.id),
        ...queue.map((t) => t.id),
      ];
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

/** Why `blocking` cannot run here, or null when it can. It needs a Deno
 *  worker pool; a browser bundle or the android/standalone WebView runtime
 *  has none. Named so the refusal reads as a platform fact with a fix, not as
 *  `Worker is not defined` three frames down. */
export function blockingUnavailableReason(
  id: string,
  deno: { execPath?: unknown } | null = globalThis.Deno ?? null,
): string | null {
  if (typeof deno?.execPath === "function") return null;
  return blockingServerOnly(id);
}

/** Run a self-contained fn off the main thread — or, given a module URL
 *  (`new URL("./job.ts", import.meta.url)`), that module's default export.
 *  See BlockingPool.run. */
export function blocking<T = unknown>(
  id: string,
  fn: ((arg?: unknown) => T | Promise<T>) | URL,
  arg?: unknown,
): Promise<T> {
  const why = blockingUnavailableReason(id);
  if (why) return Promise.reject(new Error(why));
  return pool().run(id, fn, arg);
}
/** Cancel a running/queued blocking task by id. */
blocking.cancel = (id: string): boolean => (_pool ? _pool.cancel(id) : false);
/** Terminate the global pool's IDLE workers (no-op when work is in flight, and
 *  when no pool was ever created). What app shutdown calls: threads must not
 *  outlive the app that spawned them, but the pool is process-global and a
 *  co-hosted app may still be using it. */
blocking.disposeIdle = (): boolean => (_pool ? _pool.disposeIdle() : true);
/** The task ids holding the global pool open — what a refused `disposeIdle()`
 *  is waiting for. NOT on the `blocking` facade: that is public surface and
 *  this is a shutdown diagnostic. @internal */
export function _blockingInFlight(): string[] {
  return _pool ? _pool.inFlight() : [];
}

/** Tear down the global pool (terminate workers) — call on shutdown/in tests. */
blocking.dispose = async (): Promise<void> => {
  if (_pool) {
    await _pool.dispose();
    _pool = null;
  }
};
