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

import { noteScheduleOwner } from "../state/schedule.ts";
import type { WirePatch as Patch } from "../protocol/patch-ops.ts";
import type { CellDef, Msg } from "../state/cell-types.ts";
import {
  type AmbientContext,
  cellWorkerName,
  type FromWorker,
  type ToWorker,
  WORKER_CLOSE_DEADLINE_MS,
} from "./cell-worker-protocol.ts";
import { serverRequest, serverUser } from "./auth-context.ts";
import { resolveCall } from "../state/cell-impl.ts";
import { log } from "../diagnostics/logger-api.ts";

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
  /** The owner's resolved `freezeState` — forwarded to the worker so both
   *  isolates freeze on one decision (see ToWorker["init"]). */
  freezeState: boolean;
  /** The owner's resolved appId, handed to the worker (see cellWorkerName). */
  appId?: string;
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
  /** Tell the worker a cancelOn TRIGGER fired on the main isolate.
   *
   *  The cancel registry is per-isolate, so main aborting its own in-flight
   *  calls says nothing about this thread's. Fire-and-forget: an abort has no
   *  reply, and a worker with nothing in flight simply finds no entry. */
  cancel(actionType: string): void;
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
    // The owner's resolved appId travels in the name: the worker re-runs the
    // app's entry, and must take ITS identity from here, never re-derive it
    // (see cellWorkerName for why it cannot).
    name: cellWorkerName(name, deps.appId),
  });

  let seq = 0;
  // `callId` is set for ASYNC-method calls: the value the app awaits lives in
  // the main isolate's pending-call registry (registerCall, cell-catalog), so
  // `done`/`fail` must settle THAT — the dispatch promise here is transport.
  const inflight = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      callId?: string;
    }
  >();
  let closed = false;
  /** Why the worker is gone, when it went on its own.
   *
   *  A CRASH used to log, reject `ready` and fail the in-flight calls — and
   *  then leave `closed` false, so every LATER `call()` took the live path and
   *  posted to a dead thread. An async method was bounded by the 30 s call
   *  ceiling; a SYNC method has no ceiling at all and never settled. Measured:
   *  one stray unhandled rejection inside a worker cell made the cell
   *  permanently unreachable, with two subsequent calls still pending after
   *  six seconds and no answer coming. */
  let crashError: Error | null = null;
  let readyResolve: (() => void) | null = null;
  let readyReject: ((e: Error) => void) | null = null;
  let closedResolve: (() => void) | null = null;
  const readyPromise = new Promise<void>((res, rej) => {
    readyResolve = res;
    readyReject = rej;
  });
  const readyTimer = setTimeout(() => {
    readyReject?.(
      new Error(
        // The old text ("does the app entry call aio.run()?") named the one
        // thing that is almost always TRUE, and cost a bisect to rule out
        //. A worker cell re-imports the app entry, so
        // every top-level side effect in it runs again inside the worker,
        // before the handshake — ~20ms of file I/O was enough to stall boot.
        // Lead with that, and name the guard.
        `[aio] cell worker "${name}" did not become ready within ` +
          `${READY_TIMEOUT_MS}ms.\n` +
          `  A worker cell re-imports the app entry, so anything that entry ` +
          `does at the top level (mkdir, open a database, start a listener) ` +
          `runs a second time INSIDE the worker before it can hand shake — ` +
          `and slow or throwing setup stalls it here.\n` +
          `  Fix: guard that work with \`if (!isCellWorker()) …\` ` +
          `(exported from "aio").\n` +
          `  Less commonly: the entry never reaches aio.run() at all.`,
      ),
    );
  }, READY_TIMEOUT_MS);
  // A boot failure must not keep the process alive on this timer.
  if (typeof Deno !== "undefined") {
    Deno.unrefTimer?.(readyTimer as unknown as number);
  }

  /** Reject every in-flight call — used by terminate() and a worker crash.
   *  Async-method awaiters wait in the pending-call registry, not on the
   *  transport promise — settle them there, or a crash leaves every
   *  `await cell.method()` hanging to its ceiling. */
  const failAll = (err: Error): void => {
    for (const [, entry] of inflight) {
      if (entry.callId) {
        resolveCall(entry.callId, undefined, err);
        entry.resolve(undefined); // transport promise is fire-and-forget here
      } else entry.reject(err);
    }
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
        for (const e of msg.list) {
          // The issuer does not survive structured clone (it is a WeakMap
          // entry on the worker's object), so re-record it here: disabling a
          // worker cell cancels the schedules it issued, prefixed or not.
          noteScheduleOwner(e, name);
          deps.runEffect(e);
        }
        return;
      case "done": {
        const entry = inflight.get(msg.id);
        inflight.delete(msg.id);
        // Async method: the awaiter holds the registry promise — settle it
        // with the value the worker's executor produced. (No-op if the
        // caller-side ceiling already gave up; the late value is dropped,
        // exactly as it is for a slow local method.)
        if (entry?.callId) resolveCall(entry.callId, msg.ret);
        entry?.resolve(msg.ret);
        return;
      }
      case "fail": {
        const entry = inflight.get(msg.id);
        inflight.delete(msg.id);
        const err = new Error(msg.message) as Error & { code?: string };
        if (msg.stack) err.stack = msg.stack;
        if (msg.name) err.name = msg.name;
        if (msg.code !== undefined) err.code = msg.code;
        if (entry?.callId) {
          // The awaiter sees the rejection via the registry; the transport
          // promise resolves so the fire-and-forget dispatch inside the bound
          // method (cell-catalog) can't become an unhandled rejection.
          resolveCall(entry.callId, undefined, err);
          entry.resolve(undefined);
        } else entry?.reject(err);
        return;
      }
      case "boot-error":
        clearTimeout(readyTimer);
        readyReject?.(new Error(`[aio] cell worker "${name}": ${msg.message}`));
        return;
      case "closed":
        closedResolve?.();
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
    // The cell is gone. SAY so for every later call rather than posting into
    // a dead thread: the `closed` branch in `call()` already answers by name
    // and settles both the transport promise and the registry one.
    crashError = err;
    closed = true;
    try {
      worker.terminate();
    } catch {
      // aio-ok: it already died — terminating a dead worker is the no-op we
      // want, and a throw here must not replace the crash we are reporting.
    }
  };

  const send = (msg: ToWorker) => worker.postMessage(msg);

  /** `__aioDev` as this isolate sees it — see the `dev` field on ToWorker. */
  const devFlag = (): boolean =>
    (globalThis as Record<string, unknown>).__aioDev === true;

  send({
    t: "init",
    state: deps.initialState(),
    prod: deps.prod,
    freezeState: deps.freezeState,
    dev: devFlag(),
  });

  return {
    cell: name,
    ready: () => readyPromise,
    reseed(slice: Record<string, unknown>): void {
      if (closed) return;
      send({
        t: "init",
        state: slice,
        prod: deps.prod,
        freezeState: deps.freezeState,
        dev: devFlag(),
      });
    },
    cancel(actionType: string): void {
      if (closed) return;
      send({ t: "cancel", type: actionType });
    },
    call(action: Msg): Promise<unknown> {
      const callId = (action as { payload?: { _callId?: string } }).payload
        ?._callId;
      if (closed) {
        const err = new Error(
          crashError
            ? `${crashError.message} — action "${action.type}" was not ` +
              `applied, and this cell is unreachable for the life of the ` +
              `process. Restart the app, or keep the work that can throw out ` +
              `of the worker isolate.`
            : `[aio] cell worker "${name}" is closed — action "${action.type}" was not applied`,
        );
        // An ASYNC method's caller awaits the REGISTRY promise (`_callId`), not
        // this one — so rejecting only the transport left that caller hanging
        // for the full 30 s call ceiling and then telling it the opposite of
        // what happened ("the METHOD did not give up — it may still be
        // running, and if it finishes its writes will still commit"). Nothing
        // ran. Same shape the clone-failure branch 30 lines below was fixed
        // for, and reachable BY DESIGN: shutdown closes the worker pool before
        // it closes dispatch and the HTTP server, so there is a deliberate
        // window in which the server still accepts calls and every worker cell
        // is closed.
        if (callId) {
          resolveCall(callId, undefined, err);
          return Promise.resolve(undefined);
        }
        return Promise.reject(err);
      }
      const id = ++seq;
      const p = new Promise<unknown>((resolve, reject) => {
        inflight.set(id, { resolve, reject, callId });
      });
      try {
        send({ t: "call", id, action, ctx: ambient() });
      } catch (e) {
        // `postMessage` refuses an uncloneable argument SYNCHRONOUSLY, so this
        // used to throw out of a call the contract says always returns a
        // promise (cell-catalog: "All bound methods return a Promise") — a
        // `.catch()` on the call would not see it, and neither would the
        // in-isolate path, which rejects with a teachable message instead. Two
        // shapes for one mistake, decided by whether a worker happened to be
        // hosted. Reject, in the same words.
        inflight.delete(id);
        const why = e instanceof Error ? e.message : String(e);
        const err = new Error(
          `cell "${name}" is a worker cell, and its action payload cannot ` +
            `cross a worker boundary: ${why}.\n` +
            `It is reached by postMessage, so every argument is ` +
            `structured-cloned. Pass plain data (no functions, class ` +
            `instances, or live cell proxies); \`{ ...obj }\` off a proxy is ` +
            `already materialised.`,
        );
        if (callId) {
          resolveCall(callId, undefined, err);
          return Promise.resolve(undefined);
        }
        return Promise.reject(err);
      }
      return p;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clearTimeout(readyTimer);
      try {
        const acked = new Promise<void>((r) => closedResolve = r);
        send({ t: "close" });
        // The worker aborts its in-flight methods (their `s.$signal` lives in
        // ITS isolate — ours cannot reach it), streams their final writes home
        // as patches, then acks `closed` — patches win the FIFO race against
        // the ack, so everything written has landed by the time this resolves.
        // Deadline-bounded like the main isolate's own drain (shutdown.ts): a
        // method that ignores its signal cannot hold the process open.
        let t: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          acked,
          // aiol-ok: shutdown's drain deadline — a bare timer racing the ack
          // is the point; schedule.* is app-side machinery.
          new Promise<void>((r) => t = setTimeout(r, WORKER_CLOSE_DEADLINE_MS)),
        ]);
        if (t !== undefined) clearTimeout(t);
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
