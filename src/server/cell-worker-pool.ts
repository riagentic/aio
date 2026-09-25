// cell-worker-pool.ts — the runtime's view of every `worker: true` cell:
// validation at boot, one worker each, dispatch routing, and shutdown.
//
// Routing happens BEFORE the main dispatch queue on purpose. If a worker cell's
// action were queued here first, a ten-second method would still hold the queue
// — the isolation would be a lie. Instead the action goes straight to its
// worker, and only the patches it commits come back through dispatch (as the
// internal WORKER_PATCH_ACTION), so persistence, broadcast and time-travel are
// driven by the same path as a local cell.

import type { WirePatch as Patch } from "../protocol/patch-ops.ts";
import type { CellDef, Msg } from "../state/cell-types.ts";
import { WORKER_PATCH_ACTION } from "../state/cell-compose-reduce.ts";
import { markInflight } from "../state/dispatch.ts";
import { _dispatchUnsaved, _noteUnsaved } from "./action-ack.ts";
import {
  _cancelTargetPrefixes,
  notifyMethodCancel,
} from "../state/method-cancel.ts";
import { type CellWorker, createCellWorker } from "./cell-worker.ts";
import { log } from "../diagnostics/logger-api.ts";
import { bumpPending } from "../protocol/pending-calls.ts";
import type { AioError } from "../diagnostics/error.ts";
import type { RemoteLifecycle } from "../state/cell-compose-registry.ts";

/** Refuse at boot what the thread boundary can't honour. Every one of these is
 *  a silent-wrong-behavior trap if allowed through, so they fail loudly with the
 *  reason and the fix. */
export function validateWorkerCells(cells: CellDef[]): void {
  for (const f of cells) {
    const a = f.__aio;
    const name = a.id;
    const bad = (why: string, fix: string) => {
      throw new Error(
        `[aio] cell "${name}" has worker: true but ${why}. ${fix} ` +
          `(docs/state/cell-workers.md)`,
      );
    };
    if (a.scope === "client") {
      bad(
        "is client-scoped",
        "A client cell runs in the browser, where a Deno worker doesn't exist — drop worker: true.",
      );
    }
    if (a.syncConfig) {
      bad(
        "also has sync: true",
        "CRDT sync replays ops through the cell on the main isolate; the two owners would fight. Pick one.",
      );
    }
    if (a.foreignActions && a.foreignActions.length > 0) {
      bad(
        "uses listensTo",
        "Foreign-action fan-out runs inside the main reduce, which a worker cell is not part of. Have the other cell call this one's method instead.",
      );
    }
    if (a.machine !== false) {
      bad(
        "declares a machine",
        "Machine transitions are evaluated in the main reduce. Model the states in plain fields, or drop worker: true.",
      );
    }
    if (a.selectors && Object.keys(a.selectors).length > 0) {
      bad(
        "declares selectors",
        "Selectors are computed against the main isolate's state; a worker cell's slice arrives as patches. Read the fields directly, or compute in a method.",
      );
    }
  }
}

export type CellWorkerPool = {
  /** Number of worker cells (0 = the feature is entirely inert). */
  readonly size: number;
  /** True when this action belongs to a cell that lives in a worker. */
  owns(action: Msg): boolean;
  /** Wrap the app's dispatch so worker-cell actions bypass the main queue. */
  route(dispatch: (a: Msg) => Promise<unknown>): (a: Msg) => Promise<unknown>;
  /** Wait until every host is bound (or fail boot with its error). */
  ready(): Promise<void>;
  /** Run every worker cell's `onInit` — call when the main isolate runs its
   *  own cells' (the bridge's `onStart`), never earlier: before it, a patch
   *  an `onInit` dispatches cannot be applied here. Once per boot. */
  start(): void;
  /** Re-seed every worker from the current authoritative state — call after a
   *  wholesale replacement (time travel, snapshot load). */
  reseed(): void;
  /** Stop every worker. Safe to call twice. */
  close(): Promise<void>;
  /** Each CLOSED worker cell's reason — `closedBy()` by cell name, as plain
   *  data, so a released app's cells answer as the closed pool did. */
  closedBy(): Record<string, string | null>;
};

const EMPTY_POOL: CellWorkerPool = {
  size: 0,
  owns: () => false,
  route: (d) => d,
  ready: () => Promise.resolve(),
  start: () => {},
  reseed: () => {},
  close: () => Promise.resolve(),
  closedBy: () => ({}),
};

/** Can a worker be spawned from this entry? Only a local module can be
 *  re-imported as one (a compiled binary's embedded entry reports `file:`). */
function hostableEntry(entry: string | undefined): boolean {
  return !!entry && entry.startsWith("file:");
}

/** Will this boot run its `worker: true` cells on real threads? ONE decider,
 *  asked by the pool (below) and by the cells bridge, which skips those cells'
 *  `onInit`/`onDestroy` on the main isolate exactly when their worker runs
 *  them. The bridge used to decide from `libraryMode`/`_workerEntry` alone, so
 *  an entry the pool cannot host (not a local module) ran the cells on the
 *  main isolate — and ran their `onInit` NOWHERE. */
export function _hostsWorkerThreads(
  libraryMode: boolean | undefined,
  workerEntry: string | undefined,
): boolean {
  if (libraryMode && workerEntry === undefined) return false;
  return hostableEntry(workerEntry ?? Deno.mainModule);
}

export function createCellWorkerPool(opts: {
  cells: CellDef[];
  entry: string;
  prod: boolean;
  /** The owner's resolved `freezeState`, forwarded to every worker. */
  freezeState: boolean;
  /** The owner's `refusalsReject`, forwarded to every worker — it decides what
   *  an in-process caller sees for a REFUSED write, and a worker that never
   *  learned it answered differently from the cell beside it. */
  refusalsReject: boolean;
  /** Read a cell's authoritative slice (post-restore) to seed its worker. */
  getSlice: (cell: string) => Record<string, unknown>;
  /** The RAW dispatch — worker patches are applied through it. */
  dispatch: (a: Msg) => Promise<unknown> | unknown;
  /** Execute an effect a worker handed back: schedules go to the main
   *  isolate's scheduler, cross-cell actions are dispatched. */
  runEffect: (effect: Msg) => void;
  /** The owning app's identity, as `composeCells` was given it. Scopes the
   *  cancel registry the same way the composed reduce does — `""` is the
   *  wildcard the registry already treats as "app unknown". */
  appId?: string;
  /** Is the main dispatch door refusing everything right now (time travel
   *  paused)? A worker call is routed AROUND that door, so the pool asks. */
  isPaused?: () => boolean;
  /** The app's cell-error sink — what a worker's composition reports through
   *  (see FromWorker "cell-error"). */
  reportError?: (err: AioError) => void;
  /** The owner's circuit breaker (`AioConfig._cellBreaker`): a worker cell's
   *  failures are counted there, and a cell it disabled is not routed. */
  breaker?: {
    count: (cell: string) => void;
    /** Record a routed method call as the cell's `health()` lastAction. */
    note?: (cell: string, type: string) => void;
    isEnabled: (cell: string) => boolean;
    bindWorkers?: (remote: RemoteLifecycle) => void;
  };
  /** Whether this boot hosts workers at all (default true). `false` under
   *  libraryMode without a worker entry: the cells run in-isolate, and are
   *  still VALIDATED here — a harness must refuse what the app refuses. */
  host?: boolean;
}): CellWorkerPool {
  const {
    cells,
    entry,
    prod,
    freezeState,
    refusalsReject,
    getSlice,
    dispatch,
    runEffect,
  } = opts;
  const appId = opts.appId ?? "";
  validateWorkerCells(cells);
  if (cells.length === 0 || opts.host === false) return EMPTY_POOL;

  if (!hostableEntry(entry)) {
    // An entry that is not a local module can't be re-imported as a worker.
    // Degrade LOUDLY to in-isolate execution rather than failing the app: the
    // cell still works, it just isn't isolated.
    //
    // This does NOT cover compiled binaries, though it once said so: Deno
    // embeds the entry and reports it as `file:///…`, so a compiled app takes
    // the normal path above and its worker cells really do run off-isolate —
    // proven in build-e2e ("a `worker: true` cell still runs off-isolate in a
    // compiled binary"), which measures the isolation rather than trusting
    // this message. The claim outlived the constraint by a long way; do not
    // re-add it without a failing test.
    log.warn(
      "cell-worker",
      `cannot host worker cells from entry "${entry}" (not a local module) — ` +
        `${cells.map((c) => c.__aio.id).join(", ")} will run on the main ` +
        `isolate this run.`,
    );
    return EMPTY_POOL;
  }

  const byCell = new Map<string, CellWorker>();
  /** Per worker cell: its patch batches still being dispatched on main —
   *  a call's own batches arrive before its `done` (FIFO), and each resolves
   *  only once what its commit owes is durable (aio.ts `_durableFor`), so
   *  the call is answered after them, with their `unsaved` verdict. */
  const patching = new Map<string, Set<Promise<string | undefined>>>();
  for (const f of cells) {
    const name = f.__aio.id;
    byCell.set(
      name,
      createCellWorker(f, {
        entry,
        prod,
        freezeState,
        refusalsReject,
        // `""` (app unknown) is no identity to hand over — the worker then
        // resolves as it always did.
        ...(appId ? { appId } : {}),
        ...(opts.reportError ? { reportError: opts.reportError } : {}),
        countError: () => opts.breaker?.count(name),
        initialState: () => getSlice(name),
        applyPatches: (cell: string, ops: Patch[]) => {
          // In-flight (dispatch.ts INFLIGHT): these ARE a method's writes
          // arriving from the worker isolate — if they land inside the
          // shutdown drain window (dispatch draining, not yet sealed) they
          // must be let through exactly like a local method's commits, not
          // refused as new input. Server-constructed only; every network
          // entry point strips the flag.
          const batch = markInflight({
            type: WORKER_PATCH_ACTION,
            payload: { cell, ops },
            _source: "Effect",
          }) as unknown as Msg;
          const set = patching.get(cell) ?? new Set();
          patching.set(cell, set);
          const p: Promise<string | undefined> = Promise.resolve(
            dispatch(batch),
          ).then(
            () => _dispatchUnsaved(batch),
            // Refused or thrown: reported by dispatch itself; the call's own
            // answer is the worker's `done`/`fail`.
            () => undefined,
          ).finally(() => set.delete(p));
          set.add(p);
        },
        runEffect,
      }),
    );
  }

  // `app.cells.disable`/`enable` (and the breaker's trip) of a hosted cell run
  // its `onDestroy`/`onInit` and state reset in ITS worker, where every other
  // hook of it runs — never on this isolate's copy alone.
  opts.breaker?.bindWorkers?.({
    owns: (cell) => byCell.has(cell),
    disable: (cell, done) => byCell.get(cell)!.disable(done),
    enable: (cell) => byCell.get(cell)!.enable(),
  });

  const methodTypes = new Set(
    cells.flatMap((f) => [...f.__aio.actionTypeToKey.keys()]),
  );
  const lifecycleTypes = new Set(
    cells.flatMap((f) => [f.__aio.initType, f.__aio.destroyType]),
  );
  const ownerOf = (action: Msg): CellWorker | undefined => {
    const type = action?.type;
    if (typeof type !== "string") return undefined;
    const i = type.indexOf(":");
    if (i <= 0) return undefined;
    return byCell.get(type.slice(0, i));
  };

  log.info(
    "aio",
    `cell workers: ${[...byCell.keys()].join(", ")} (own thread each)`,
  );

  // ── cancelOn across the thread ───────────────────────────────────────────
  //
  // The cancel registry (`src/state/method-cancel.ts`) is module-scoped, so
  // each isolate holds its own copy and `notifyMethodCancel` can only abort
  // controllers that live in the isolate that ran the reduce. That leaves two
  // holes, and this pool is the one place that can see both:
  //
  //   main → worker: a PEER cell's action reduces on main and fires main's
  //     registry, where the worker cell's AbortController does not exist. So
  //     `cancelOn: { slow: [peer.stop] }` on a `worker: true` cell was inert
  //     in production. Forward the trigger; the worker fires its own registry.
  //
  //   worker → main: `route` hands a worker-cell action straight to its
  //     thread and NEVER touches the main dispatch, so main's reduce — the
  //     only caller of `notifyMethodCancel` there — never runs for it. A main
  //     cell's method listing a worker cell's action as its trigger was inert
  //     the same way, in the other direction.
  //
  // Both are invisible to the in-isolate harness, which has one registry and
  // so happens to hold the trigger and the controller in the same map.
  const forwardCancel = (action: Msg, owner: CellWorker | undefined): void => {
    const type = action?.type;
    if (typeof type !== "string") return;
    const targets = _cancelTargetPrefixes(type, appId);
    if (targets.length === 0) return;
    for (const prefix of targets) {
      const w = byCell.get(prefix);
      // The owner already fires its own registry when it reduces the action.
      if (w && w !== owner) w.cancel(type);
    }
    // A worker-cell action bypasses the main queue entirely, so nothing on
    // this isolate would otherwise sweep for it.
    if (owner) notifyMethodCancel(type, appId);
  };

  // ── `cell.$pending(m)` for a worker cell ────────────────────────────────
  //
  // The count is bumped by the executor that RUNS the method (`trackCall`),
  // and for a worker cell that executor lives in the other isolate — so on
  // the main isolate, where every component and every `await` reads it,
  // `heavy.$pending("scan")` said 0 for the whole of a running call. In
  // process (every harness) the same read said 1. Count the call here, around
  // the hop, for exactly the methods the executor would count: async ones.
  // The transport settles when the worker reports the method DONE, so the
  // count spans the method, not the postMessage.
  //
  // …for a call that RUNS. A `concurrency: "first"` adopter or a `ttl` hit is
  // never counted by the executor (`trackCall` runs only for a call that
  // runs), and only the worker's executor knows which calls those are: it
  // reports each one (`onAdopted`), and the count is released then — once.
  // Counting it until its adopted outcome landed made two overlapping
  // `scan("a")` read 2 here and 1 on the main isolate. What is left is one
  // thread hop of over-count before the report arrives.
  const asyncTypes = new Set(
    cells.flatMap((f) =>
      [...(f.__aio.asyncMethods ?? [])].map((m) => `${f.__aio.id}:${m}`)
    ),
  );
  const counted = (
    type: string,
    run: (onAdopted: () => void) => Promise<unknown>,
  ): Promise<unknown> => {
    if (!asyncTypes.has(type)) return run(() => {});
    bumpPending(type, 1);
    let released = false;
    const release = () => {
      if (released) return; // adopted AND settled — decrement once
      released = true;
      bumpPending(type, -1);
    };
    const p = run(release);
    p.then(release, release);
    return p;
  };

  return {
    size: byCell.size,
    owns: (action) => ownerOf(action) !== undefined,
    route: (dispatchFn) => (action: Msg) => {
      // Paused time travel refuses every action at the main door — and a
      // worker call never reaches that door. So the method RAN in its worker
      // and answered its caller, while the patches it streamed home were
      // refused by the paused door: a write the caller was told succeeded,
      // kept only in the worker's copy until the next re-seed dropped it.
      // Hand it to the door instead; it refuses with its own words (and
      // settles an async caller's registration), exactly as for any cell.
      if (opts.isPaused?.()) return dispatchFn(action);
      const owner = ownerOf(action);
      forwardCancel(action, owner);
      // A worker cell's `__init`/`__destroy` maintain THIS isolate's copy
      // (the registry's enable/disable); the worker runs its own through its
      // registry (`disable`/`enable` above). Posted as a call, a re-enable's
      // late reset landed in the worker AFTER its `onInit` and wiped it.
      if (!owner || lifecycleTypes.has(action.type)) return dispatchFn(action);
      const cell = action.type.slice(0, action.type.indexOf(":"));
      // Disabled (the circuit breaker, `app.cells.disable`) is decided HERE,
      // in the composition that owns it. The worker hears of it only after a
      // round trip, so the door refuses a disabled cell's action at once,
      // exactly as it does a local one's, instead of letting it run there.
      if (opts.breaker?.isEnabled(cell) === false) return dispatchFn(action);
      // The reduce that runs it is the worker's, so the owner's health row
      // (`lastAction`) learns of it here, once the worker answered — for a
      // method the cell has, and not for a sync throw (REDUCE_ERROR), exactly
      // what the local reduce records.
      const note = () => {
        if (methodTypes.has(action.type)) {
          opts.breaker?.note?.(cell, action.type);
        }
      };
      const settle = async (): Promise<void> => {
        const why = (await Promise.all([...(patching.get(cell) ?? [])]))
          .filter((v) => v !== undefined);
        if (why.length > 0) {
          _noteUnsaved(
            action as object,
            undefined,
            [...new Set(why)].join("; "),
          );
        }
      };
      return counted(
        action.type,
        (onAdopted) =>
          owner.call(action, onAdopted).then(
            async (v) => {
              note();
              await settle();
              return v;
            },
            async (e) => {
              if ((e as { code?: unknown })?.code !== "REDUCE_ERROR") note();
              await settle();
              throw e;
            },
          ),
      );
    },
    ready: async () => {
      await Promise.all([...byCell.values()].map((w) => w.ready()));
    },
    start: () => {
      for (const w of byCell.values()) w.start();
    },
    reseed: () => {
      for (const [name, w] of byCell) w.reseed(getSlice(name));
    },
    close: async () => {
      // NOT cleared: a closed worker answers every later call by name ("cell
      // worker … is closed — not applied"). Clearing the map made `ownerOf`
      // forget the cell, and `route` then handed its calls to the MAIN loop,
      // whose composed reduce runs the cell's methods ON THE MAIN ISOLATE —
      // away from the resources its worker owned, and admitted whenever
      // dispatch was still open.
      await Promise.all([...byCell.values()].map((w) => w.close()));
    },
    closedBy: () => {
      const out: Record<string, string | null> = {};
      for (const [name, w] of byCell) {
        const why = w.closedBy();
        if (why !== undefined) out[name] = why;
      }
      return out;
    },
  };
}
