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
import {
  _cancelTargetPrefixes,
  notifyMethodCancel,
} from "../state/method-cancel.ts";
import { type CellWorker, createCellWorker } from "./cell-worker.ts";
import { log } from "../diagnostics/logger-api.ts";
import { bumpPending } from "../protocol/pending-calls.ts";

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
  /** Re-seed every worker from the current authoritative state — call after a
   *  wholesale replacement (time travel, snapshot load). */
  reseed(): void;
  /** Stop every worker. Safe to call twice. */
  close(): Promise<void>;
};

const EMPTY_POOL: CellWorkerPool = {
  size: 0,
  owns: () => false,
  route: (d) => d,
  ready: () => Promise.resolve(),
  reseed: () => {},
  close: () => Promise.resolve(),
};

export function createCellWorkerPool(opts: {
  cells: CellDef[];
  entry: string;
  prod: boolean;
  /** The owner's resolved `freezeState`, forwarded to every worker. */
  freezeState: boolean;
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
    getSlice,
    dispatch,
    runEffect,
  } = opts;
  const appId = opts.appId ?? "";
  validateWorkerCells(cells);
  if (cells.length === 0 || opts.host === false) return EMPTY_POOL;

  if (!entry || !entry.startsWith("file:")) {
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
  for (const f of cells) {
    const name = f.__aio.id;
    byCell.set(
      name,
      createCellWorker(f, {
        entry,
        prod,
        freezeState,
        // `""` (app unknown) is no identity to hand over — the worker then
        // resolves as it always did.
        ...(appId ? { appId } : {}),
        initialState: () => getSlice(name),
        applyPatches: (cell: string, ops: Patch[]) => {
          // In-flight (dispatch.ts INFLIGHT): these ARE a method's writes
          // arriving from the worker isolate — if they land inside the
          // shutdown drain window (dispatch draining, not yet sealed) they
          // must be let through exactly like a local method's commits, not
          // refused as new input. Server-constructed only; every network
          // entry point strips the flag.
          void dispatch(markInflight({
            type: WORKER_PATCH_ACTION,
            payload: { cell, ops },
            _source: "Effect",
          }) as unknown as Msg);
        },
        runEffect,
      }),
    );
  }

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
  const asyncTypes = new Set(
    cells.flatMap((f) =>
      [...(f.__aio.asyncMethods ?? [])].map((m) => `${f.__aio.id}:${m}`)
    ),
  );
  const counted = (type: string, p: Promise<unknown>): Promise<unknown> => {
    if (!asyncTypes.has(type)) return p;
    bumpPending(type, 1);
    const release = () => void bumpPending(type, -1);
    p.then(release, release);
    return p;
  };

  return {
    size: byCell.size,
    owns: (action) => ownerOf(action) !== undefined,
    route: (dispatchFn) => (action: Msg) => {
      const owner = ownerOf(action);
      forwardCancel(action, owner);
      return owner
        ? counted(action.type, owner.call(action))
        : dispatchFn(action);
    },
    ready: async () => {
      await Promise.all([...byCell.values()].map((w) => w.ready()));
    },
    reseed: () => {
      for (const [name, w] of byCell) w.reseed(getSlice(name));
    },
    close: async () => {
      await Promise.all([...byCell.values()].map((w) => w.close()));
      byCell.clear();
    },
  };
}
