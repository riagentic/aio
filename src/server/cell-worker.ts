// cell-worker.ts — the MAIN-ISOLATE side of a `worker: true` cell.
//
// Spawns one Deno worker per flagged cell (entry = the app's own module, so the
// worker rebuilds the real cell definition), routes that cell's actions to it,
// and applies the patches it streams back to the authoritative state here.
//
// The property this buys: an action for a worker cell NEVER enters the main
// dispatch queue, so a method that blocks for ten seconds cannot delay another
// cell's action, another client's action, or the socket loop that acks them.
//
// Ordering: the worker processes calls in the order they were posted, so a
// cell's own actions keep their FIFO guarantee. Across cells there was never an
// ordering guarantee for async methods, and there still isn't.

import type { Patch } from "immer";
import type { CellDef, Msg } from "../state/cell-types.ts";
import {
  type AmbientContext,
  CELL_WORKER_PREFIX,
  type FromWorker,
  type ToWorker,
} from "./cell-worker-protocol.ts";
import { serverRequest, serverUser } from "./auth-context.ts";
import { log } from "../diagnostics/logger.ts";

/** How long to wait for a spawned host to report `ready` before failing boot. */
const READY_TIMEOUT_MS = 30_000;

export type CellWorkerDeps = {
  /** The app entry to load in the worker — normally `Deno.mainModule`. */
  entry: string;
  /** Current authoritative slice for the cell (post-persistence, post-migration). */
  initialState: () => Record<string, unknown>;
  /** Apply patches the worker produced to the authoritative state. Runs through
   *  the normal dispatch path, so broadcast, persistence and time-travel see
   *  the change exactly as they see a local one. */
  applyPatches: (cell: string, ops: Patch[]) => void;
  /** Execute an effect the worker handed back (schedules, cross-cell actions). */
  runEffect: (effect: Msg) => void;
  prod: boolean;
};

export type CellWorker = {
  readonly cell: string;
  /** Route one action to the worker. Resolves with the method's return value,
   *  rejects with the method's error. */
  call(action: Msg): Promise<unknown>;
  /** Wait until the host is bound and serving. */
  ready(): Promise<void>;
  /** Replace the worker's copy of the slice. Used when the main isolate swaps
   *  state wholesale (time travel, snapshot load) — otherwise the worker would
   *  keep mutating the state we just discarded. */
  reseed(slice: Record<string, unknown>): void;
  /** Graceful stop, then terminate. Safe to call twice. */
  close(): Promise<void>;
  /** Kill the thread NOW — the only way to stop a method that never returns.
   *  In-flight calls reject; the cell keeps the state main already has. */
  terminate(reason: string): void;
};

/** Snapshot the ambient caller context as plain data for the thread hop. */
function ambient(): AmbientContext | undefined {
  const user = serverUser();
  const req = serverRequest();
  if (!user && !req) return undefined;
  return {
    ...(user ? { user: { id: user.id, role: user.role } } : {}),
    ...(req
      ? {
        request: {
          ip: req.ip,
          headers: [...req.headers.entries()],
          cookies: { ...req.cookies },
          url: req.url,
          method: req.method,
          via: req.via,
        },
      }
      : {}),
  };
}

export function createCellWorker(
  cell: CellDef,
  deps: CellWorkerDeps,
): CellWorker {
  const name = cell.__aio.id;
  const worker = new Worker(deps.entry, {
    type: "module",
    name: `${CELL_WORKER_PREFIX}${name}`,
  });

  let seq = 0;
  const inflight = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  let closed = false;
  let readyResolve: (() => void) | null = null;
  let readyReject: ((e: Error) => void) | null = null;
  const readyPromise = new Promise<void>((res, rej) => {
    readyResolve = res;
    readyReject = rej;
  });
  const readyTimer = setTimeout(() => {
    readyReject?.(
      new Error(
        `[aio] cell worker "${name}" did not become ready within ` +
          `${READY_TIMEOUT_MS}ms — does the app entry call aio.run()?`,
      ),
    );
  }, READY_TIMEOUT_MS);
  // A boot failure must not keep the process alive on this timer.
  if (typeof Deno !== "undefined") {
    Deno.unrefTimer?.(readyTimer as unknown as number);
  }

  /** Reject every in-flight call — used by terminate() and a worker crash. */
  const failAll = (err: Error): void => {
    for (const [, entry] of inflight) entry.reject(err);
    inflight.clear();
  };

  worker.onmessage = (ev: MessageEvent<FromWorker>) => {
    const msg = ev.data;
    switch (msg.t) {
      case "ready":
        clearTimeout(readyTimer);
        readyResolve?.();
        return;
      case "patches":
        deps.applyPatches(name, msg.ops);
        return;
      case "effects":
        for (const e of msg.list) deps.runEffect(e);
        return;
      case "done": {
        const entry = inflight.get(msg.id);
        inflight.delete(msg.id);
        entry?.resolve(msg.ret);
        return;
      }
      case "fail": {
        const entry = inflight.get(msg.id);
        inflight.delete(msg.id);
        const err = new Error(msg.message);
        if (msg.stack) err.stack = msg.stack;
        entry?.reject(err);
        return;
      }
      case "boot-error":
        clearTimeout(readyTimer);
        readyReject?.(new Error(`[aio] cell worker "${name}": ${msg.message}`));
        return;
    }
  };

  worker.onerror = (ev: ErrorEvent) => {
    // An uncaught error in the host thread. Loud, never silent: the cell is now
    // unreachable and every waiting caller has to learn that.
    ev.preventDefault?.();
    const err = new Error(
      `[aio] cell worker "${name}" crashed: ${ev.message ?? "unknown error"}`,
    );
    log.error("cell-worker", err.message);
    clearTimeout(readyTimer);
    readyReject?.(err);
    failAll(err);
  };

  const send = (msg: ToWorker) => worker.postMessage(msg);

  send({ t: "init", state: deps.initialState(), prod: deps.prod });

  return {
    cell: name,
    ready: () => readyPromise,
    reseed(slice: Record<string, unknown>): void {
      if (closed) return;
      send({ t: "init", state: slice, prod: deps.prod });
    },
    call(action: Msg): Promise<unknown> {
      if (closed) {
        return Promise.reject(
          new Error(
            `[aio] cell worker "${name}" is closed — action "${action.type}" was not applied`,
          ),
        );
      }
      const id = ++seq;
      const p = new Promise<unknown>((resolve, reject) => {
        inflight.set(id, { resolve, reject });
      });
      send({ t: "call", id, action, ctx: ambient() });
      return p;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clearTimeout(readyTimer);
      try {
        send({ t: "close" });
        // Give the host a beat to drain its final patches, then stop it. The
        // authoritative state already lives here, so this can't lose committed
        // work — only an in-flight method's unwritten tail.
        await new Promise((r) => setTimeout(r, 50));
      } catch { /* already gone */ }
      failAll(new Error(`[aio] cell worker "${name}" closed`));
      worker.terminate();
    },
    terminate(reason: string): void {
      if (closed) return;
      closed = true;
      clearTimeout(readyTimer);
      log.warn("cell-worker", `${name}: terminated — ${reason}`);
      failAll(new Error(`[aio] cell worker "${name}" terminated: ${reason}`));
      worker.terminate();
    },
  };
}
