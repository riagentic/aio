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
import { type CellWorker, createCellWorker } from "./cell-worker.ts";
import { log } from "../diagnostics/logger-api.ts";

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
}): CellWorkerPool {
  const { cells, entry, prod, freezeState, getSlice, dispatch, runEffect } =
    opts;
  if (cells.length === 0) return EMPTY_POOL;

  validateWorkerCells(cells);

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

  return {
    size: byCell.size,
    owns: (action) => ownerOf(action) !== undefined,
    route: (dispatchFn) => (action: Msg) => {
      const owner = ownerOf(action);
      return owner ? owner.call(action) : dispatchFn(action);
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
