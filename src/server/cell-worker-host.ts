// cell-worker-host.ts — the WORKER side of a `worker: true` cell.
//
// The worker's entry module is the app's OWN entry, so every cell definition
// and every helper a method closes over exists here exactly as it does on the
// main isolate — no function serialization, no closure limits (unlike
// schedule.blocking, which moves a lone function). `aio.run()` notices it is
// running under a cell-host worker name and hands control here instead of
// booting a server.
//
// This host owns ONE cell's state and runs its methods. It streams the Immer
// patches each commit produces back to the main isolate, which keeps the
// authoritative replica — so persistence, broadcast, time-travel and the wire
// protocol are unchanged and unaware.
//
// What runs where:
//   - this cell's own effects (the async-method `__exec` machinery) run HERE,
//     otherwise the method body would execute on the main isolate again
//   - `own.set`/`own.dispose` run HERE: the factory closure and the resource it
//     opens (a subprocess, an FFI handle, a socket) belong to THIS thread
//   - schedule effects and cross-cell dispatches are forwarded to main, where
//     the scheduler and the other cells live

import type { Patch } from "immer";
import { nameIsTaken } from "../state/cell-helpers.ts";
import { composeCells } from "../state/cell-compose.ts";
import { getRegisteredCells } from "../state/cell-reactive.ts";
import { createDispatch } from "../state/dispatch.ts";
import { createOwnManager } from "../state/own.ts";
import { routeEffect } from "../state/route-effect.ts";
import type { CellDef, Msg } from "../state/cell-types.ts";
import {
  type AmbientContext,
  CELL_WORKER_PREFIX,
  type FromWorker,
  type ToWorker,
  WORKER_CLOSE_DRAIN_MS,
} from "./cell-worker-protocol.ts";
import { abortAllInflight, settlePending } from "../state/method-cancel.ts";
import {
  runWithRequest,
  runWithUser,
  type ServerRequest,
} from "./auth-context.ts";
import { _setCallTimeouts, registerCall } from "../state/cell-impl.ts";
import { log } from "../diagnostics/logger-api.ts";

/** The cell name this worker hosts, or null when this isn't a cell worker. */
export function hostedCellName(): string | null {
  const name = typeof self !== "undefined"
    ? (self as { name?: string }).name
    : undefined;
  return name && name.startsWith(CELL_WORKER_PREFIX)
    ? name.slice(CELL_WORKER_PREFIX.length)
    : null;
}

const post = (msg: FromWorker): void => {
  (self as unknown as { postMessage: (m: unknown) => void }).postMessage(msg);
};

/** Rebuild the ambient context from its plain-data form (a Headers instance and
 *  a frozen cookie map can't cross a thread). */
function reviveRequest(
  ctx: AmbientContext | undefined,
): ServerRequest | undefined {
  const r = ctx?.request;
  if (!r) return undefined;
  return {
    ip: r.ip,
    headers: new Headers(r.headers),
    cookies: Object.freeze({ ...r.cookies }),
    url: r.url,
    method: r.method,
    via: r.via,
  };
}

/** Make every OTHER cell's state read throw inside this worker.
 *
 *  The trap this closes: a worker holds only its own
 *  slice, but every imported cell def still carries the creation-time getters
 *  that return its DECLARED DEFAULTS. So `hw.connected` inside a worker cell's
 *  method read `false` forever — not stale data, never-updated data — with no
 *  error anywhere. Boot validation couldn't catch it: the misuse is in a method
 *  body, not in the config.
 *
 *  Calling a peer's method already throws (the unbound-runtime guard), so only
 *  reads were silent. Now they name the cell, the reason and the way out. */
function isolatePeerCells(hosted: string): void {
  for (const [name, def] of getRegisteredCells()) {
    if (name === hosted || def.__aio.bound) continue;
    for (const key of Object.keys(def.__aio.state)) {
      // Only replace a plain state getter — never a method/selector callable.
      if (nameIsTaken(def, key)) continue;
      try {
        Object.defineProperty(def, key, {
          get() {
            throw new Error(
              `[aio] cell "${hosted}" runs in a worker and cannot read ` +
                `"${name}.${key}" — a worker cell has ONLY its own state, so ` +
                `this read would silently return ${name}'s declared default ` +
                `forever. Pass the value in as a method argument, do the read ` +
                `on the main isolate and hand the result over, or keep the ` +
                `heavy work in one self-contained cell (the designated-thread ` +
                `idiom). See docs/state/cell-workers.md.`,
            );
          },
          enumerable: false,
          configurable: true,
        });
      } catch { /* non-configurable — leave it */ }
    }
  }
}

/** Boot the host for `cell` and serve calls until the main isolate closes us.
 *  Never resolves — the worker stays alive as long as its owner does. */
export function startCellWorkerHost(cell: CellDef): Promise<never> {
  const name = cell.__aio.id;
  const composed = composeCells([cell], { perfCheck: false });
  isolatePeerCells(name);

  // The MAIN isolate owns the caller-side ceiling (registerCall there carries
  // the app's configured timeouts). This side must wait for the method body
  // itself, however long it runs — a second, default-30s ceiling HERE would
  // silently cap every long method a worker hosts.
  _setCallTimeouts(0);

  // Root state shape is the same as the main isolate's, with one cell in it.
  let state: Record<string, unknown> = {
    [name]: {
      ...(composed.initialState as Record<string, unknown>)[name] as Record<
        string,
        unknown
      >,
    },
  };
  let pending: Patch[] = [];
  // Set while tearing down. Destroy runs the cell's onDestroy (its resources
  // were opened HERE, so they must be released here) — but the state changes a
  // teardown produces are NOT data: `__Destroy` resets the slice to its initial
  // shape, and streaming that home would overwrite the real state moments
  // before the final persist flush. Committed data already lives on the main
  // isolate; teardown noise dies with this thread.
  let closing = false;

  // Owned resources acquired by THIS cell, in THIS isolate.
  //
  // `own` effects used to be posted home with the schedule effects, on the
  // theory that "global-runtime effects belong to the main isolate". They do
  // not: `own.set` parks its factory in a module-level map that is per-isolate,
  // so the closure never crossed the thread — and the main isolate's runEffect
  // did not handle `__own` at all, dispatching it as an action type no cell
  // answers. `own.set(id, () => openDevice())` from a worker cell was a SILENT
  // no-op: no resource, no disposer, no log — while docs/state/methods.md
  // documents `own.set` as the way to hold exactly the kind of handle a worker
  // cell exists for (the hardware-wallet example is one).
  //
  // Running it here is not a workaround, it is the only correct isolate: the
  // factory runs where its closure lives, and the disposer runs on the thread
  // that owns the handle. Disposal happens on `close` below, next to the
  // cell's own onDestroy, for the same reason.
  const ownWorker = createOwnManager({
    info: (m) => log.info("cell-worker", `${name}: ${m}`),
    debug: (m) => log.debug(`cell-worker(${name}) ${m}`),
    warn: (m) => log.warn("cell-worker", `${name}: ${m}`),
    error: (m) => log.error("cell-worker", `${name}: ${m}`),
  });

  /** Ship whatever this commit produced. Streamed (not batched to the end of a
   *  call) so `s.status = "working"` before an await reaches clients now. */
  const flush = (): void => {
    if (closing) {
      pending = [];
      return;
    }
    if (pending.length === 0) return;
    post({ t: "patches", ops: pending });
    pending = [];
  };

  const dispatch = createDispatch<Record<string, unknown>, Msg, Msg>({
    reduce: (s, action) => {
      const r = composed.reduce(s, action);
      // ComposedCells types `reduce` without the patch side-channel (the main
      // runtime reads it the same way, aio-dispatch.ts).
      const p = (r as unknown as {
        patches?: { cell: string; ops: Patch[] } | {
          cell: string;
          ops: Patch[];
        }[];
      }).patches;
      if (p) {
        for (const entry of Array.isArray(p) ? p : [p]) {
          // Only this cell's patches exist here, but stay strict: a stray
          // foreign patch must never be attributed to us on the main side.
          if (entry.cell === name) pending.push(...entry.ops);
        }
      }
      return r;
    },
    execute: (effect) =>
      // ONE exhaustive classifier for all three effect runtimes — a new
      // framework effect kind is a compile error here (see route-effect.ts).
      // This host's SEMANTICS stay its own: resources local, timers forwarded,
      // app effects split by own-prefix.
      routeEffect<Msg>(effect, {
        // Resources are acquired and disposed on the thread that owns them.
        own: (e) => ownWorker.handle(e),
        // The scheduler is a main-isolate singleton — timers stay there.
        schedule: (e) => post({ t: "effects", list: [e as unknown as Msg] }),
        app: (e) => {
          const type = e.type;
          const prefix = typeof type === "string"
            ? type.slice(0, type.indexOf(":"))
            : "";
          if (prefix === name) {
            // Our own machinery (async-method triggers) — must run here.
            composed.execute(
              { dispatch: (a: Msg) => void dispatch(a), getState: () => state },
              e,
            );
            return;
          }
          post({ t: "effects", list: [e] }); // cross-cell → main
        },
      }),
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: flush,
    log: {
      debug: (m) => log.debug(`cell-worker(${name}) ${m}`),
      warn: (m) => log.warn("cell-worker", `${name}: ${m}`),
      error: (m) => log.error("cell-worker", `${name}: ${m}`),
    },
    debug: false,
    perfCheck: "off", // the main isolate measures; don't double-report
  });

  composed.initAll({
    dispatch: (a: Msg) => void dispatch(a),
    getState: () => state,
  });

  self.onmessage = async (ev: MessageEvent<ToWorker>) => {
    const msg = ev.data;
    if (msg.t === "init") {
      // Arm the same dev tripwires the owner runs with, BEFORE the first call
      // (`ready` is posted from here, and no call can arrive before it). A
      // worker gets a fresh global, so without this the worker isolate is more
      // permissive than the one that spawned it — the exact asymmetry
      // `testServer({ workers: "real" })` exists to close.
      if (msg.dev) (globalThis as Record<string, unknown>).__aioDev = true;
      // The authoritative slice — persistence and migrations already ran on the
      // main isolate, so this is the state of record, not our defaults.
      state = { [name]: { ...msg.state } };
      pending = []; // seeding is not a change to broadcast
      post({ t: "ready", cell: name });
      return;
    }
    if (msg.t === "close") {
      // Same contract as the main isolate's shutdown (shutdown.ts Phase 1):
      // an in-flight call gets to finish WRITING, it never gets to start new
      // work. The method registries live in THIS isolate — the main thread's
      // abortAllInflight cannot see them — so the abort+drain must run here,
      // while `closing` is still false so the final writes stream home.
      abortAllInflight();
      await settlePending(WORKER_CLOSE_DRAIN_MS);
      closing = true; // stop streaming BEFORE teardown mutates the slice
      composed.destroyAll({
        dispatch: (a: Msg) => void dispatch(a),
        getState: () => state,
      });
      // After onDestroy (which may itself dispose): the watchers, sockets and
      // subprocesses this thread opened die with it, not silently outlive it.
      ownWorker.disposeAll();
      post({ t: "closed" });
      self.close();
      return;
    }
    // t === "call"
    const { id, action, ctx } = msg;
    // An ASYNC method's return value does not ride the dispatch promise: the
    // body runs as this cell's `__exec` effect, and its completion lands in
    // resolveCall(_callId) — in THIS isolate's pending-call registry, which the
    // main isolate cannot see. Awaiting only dispatch() shipped `done` after
    // the sync prefix with ret=undefined, while the main-side registerCall()
    // pending — the promise `await cell.method()` actually holds — was settled
    // by NOBODY: every async worker-cell method hung to the caller's ceiling,
    // success and failure alike (a field report, a night of hardware-wallet
    // "stopped waiting" timeouts whose methods had long since finished).
    // Register the SAME callId here, before dispatch, and await it: the
    // executor settles it with the method's true value/error, and `done`/`fail`
    // carry that home, where the main side settles ITS registry.
    const callId = (action as { payload?: { _callId?: string } }).payload
      ?._callId;
    try {
      const settled = callId ? registerCall(callId) : null;
      if (settled) settled.catch(() => {}); // observed via await below; never unhandled
      const run = () => dispatch(action);
      const withCtx = () =>
        runWithRequest(reviveRequest(ctx), () => runWithUser(ctx?.user, run));
      const ret = await withCtx();
      const value = settled ? await settled : ret;
      flush(); // every commit this call produced, before the caller resolves
      post({ t: "done", id, ret: value as unknown });
    } catch (e) {
      flush(); // partial writes still happened — main must see them
      post({
        t: "fail",
        id,
        message: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
      });
    }
  };

  return new Promise<never>(() => {}); // hold the worker open
}
