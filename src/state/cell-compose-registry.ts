// cell-compose-registry.ts — cell enable/disable registry, circuit breaker, lifecycle, health

import { log } from "../diagnostics/logger-api.ts";
import type { AioError } from "../diagnostics/error.ts";
import { CIRCUIT_BREAKER_TRIP, createAioError } from "../diagnostics/error.ts";
import type { CellDef, Msg, ScopedApp } from "./cell-types.ts";
import { tagSource } from "./cell-types.ts";
import { inServerOrigin } from "./call-origin.ts";
import type { CellStatus, CircuitBreakerConfig } from "./cell-compose-types.ts";

export type Registry = {
  enable: (
    name: string,
    app: { dispatch: (a: Msg) => void; getState: () => unknown },
  ) => void;
  disable: (
    name: string,
    app: { dispatch: (a: Msg) => void; getState: () => unknown },
  ) => void;
  isEnabled: (name: string) => boolean;
  status: (name: string, state: Record<string, unknown>) => string | undefined;
  health: (state: Record<string, unknown>) => CellStatus[];
  setOnDisable: (fn: (prefix: string) => void) => void;
};

/** Everything buildRegistry returns (public registry + internal helpers for compose) */
export type RegistryBundle = {
  registry: Registry;
  countCellError: (name: string) => void;
  /** Wire circuit-breaker dispatch — call once on first initAll */
  setCbApp: (
    app: { dispatch: (a: Msg) => void; getState: () => unknown },
  ) => void;
  /** Clear per-cell tracking on destroy (called by destroyAll/disable) */
  clearCell: (id: string) => void;
  /** Hand the lifecycle of cells another isolate owns to that isolate — see
   *  `RemoteLifecycle`. */
  setRemote: (remote: RemoteLifecycle) => void;
};

/** The lifecycle of cells ANOTHER isolate runs (`worker: true`).
 *
 *  `disable`/`enable` ran the cell's `onDestroy`/`onInit` and its state reset
 *  HERE, on the main isolate's copy — a thread that never opened the cell's
 *  resources — while the worker's copy kept the old slice: the first call after
 *  `enable` streamed home a write on top of it (n=3, reset to 0, one increment
 *  read 4). The owning isolate runs the hooks and resets its own copy; this
 *  side keeps the decision (disabled = refused at this door) and resets ITS
 *  copy once the owner reports the destroy succeeded. */
export type RemoteLifecycle = {
  owns: (cell: string) => boolean;
  /** Run the cell's disable in its isolate; `done(false)` = its `onDestroy`
   *  threw and it rolled back (already reported and counted there). */
  disable: (cell: string, done: (ok: boolean) => void) => void;
  enable: (cell: string) => void;
};

function makeScopedApp(
  f: CellDef,
  app: { dispatch: (a: Msg) => void; getState: () => unknown },
  reportError: ((err: AioError) => void) | undefined,
): ScopedApp & { _onError?: (err: AioError) => void } {
  return {
    _onError: reportError,
    dispatch: (a: Msg) => app.dispatch(tagSource(a, "System")),
    getState: () =>
      (app.getState() as Record<string, unknown>)[f.__aio.id] as unknown,
    getFullState: () => app.getState() as Record<string, unknown>,
  };
}

/** Build a cell registry with enable/disable, circuit breaker, and health reporting */
export function buildRegistry(
  cells: CellDef[],
  disabledCells: Set<string>,
  cellLastAction: Map<string, { type: string; at: number }>,
  circuitBreaker: CircuitBreakerConfig | undefined,
  reportError: ((err: AioError) => void) | undefined,
): RegistryBundle {
  const cellErrors = new Map<string, number[]>(); // error timestamps
  const cbMaxErrors = circuitBreaker?.maxErrors ?? 0;
  const cbWindow = circuitBreaker?.window;
  let cbApp:
    | { dispatch: (a: Msg) => void; getState: () => unknown }
    | undefined;
  let onCellDisable: ((prefix: string) => void) | undefined;
  let remote: RemoteLifecycle | undefined;
  /** Cells the breaker is disabling right now. A disable whose `onDestroy`
   *  throws rolls back and COUNTS that throw — which, at or over `maxErrors`,
   *  tripped the breaker again from inside its own trip: `onDestroy` ran
   *  ~10 000 times until the stack overflowed, each run reported to `onError`,
   *  and the method that tripped it failed with "Maximum call stack size
   *  exceeded". One attempt per trip; the next error tries again. */
  const tripping = new Set<string>();

  function countCellError(name: string): void {
    const now = Date.now();
    const timestamps = cellErrors.get(name) ?? [];
    timestamps.push(now);
    if (cbWindow) {
      const cutoff = now - cbWindow;
      while (timestamps.length && timestamps[0]! < cutoff) timestamps.shift();
    }
    cellErrors.set(name, timestamps);
    const count = timestamps.length;
    if (
      cbMaxErrors > 0 && count >= cbMaxErrors &&
      !disabledCells.has(name) && cbApp && !tripping.has(name)
    ) {
      tripping.add(name);
      try {
        // Reported once the disable SETTLED: a worker cell's answers by
        // reply, and until then it looks disabled here even when its
        // `onDestroy` threw and the worker rolled it back.
        disableCell(name, cbApp, (ok) => {
          // Rolled back (its `onDestroy` threw, reported as DESTROY_ERROR):
          // the cell is still enabled, so the breaker did NOT trip — saying
          // it did would be the lie.
          if (ok) reportTrip(name, count);
        });
      } finally {
        tripping.delete(name);
      }
    }
  }

  function reportTrip(name: string, count: number): void {
    if (circuitBreaker?.onTrip) circuitBreaker.onTrip(name, count);
    if (reportError) {
      reportError(
        createAioError(
          "EFFECT_ERROR",
          // Named so the tip is the breaker's own, not the sync-effect one
          // (see CIRCUIT_BREAKER_TRIP); the message and code are unchanged.
          Object.assign(
            new Error(
              `circuit breaker tripped: cell "${name}" auto-disabled after ${count} errors${
                cbWindow ? ` in ${cbWindow}ms` : ""
              }`,
            ),
            { name: CIRCUIT_BREAKER_TRIP },
          ),
          { cellName: name },
        ),
      );
    }
  }

  function clearCell(id: string): void {
    cellErrors.delete(id);
    cellLastAction.delete(id);
  }

  /** ONE decider for `cells.status(name)` and `health()[i].status`.
   *
   *  Both read `__aio_status`, a field only the removed `machine` API ever
   *  wrote — so since its removal `status()` was `undefined` for every cell
   *  and every health row had no status, while docs/state/lifecycle.md showed
   *  `'idle' | 'saving' | 'error'`. What the type promises (`CellStatus.status`)
   *  is the cell's OWN `status` field, the guard-line state machine
   *  (`if (s.status !== "idle") return`) that replaced `machine` — so that is
   *  what is read, when it is a string. A DISABLED cell says so, from both
   *  entry points: health reported `"active"` beside `enabled: false` once,
   *  two fields of the same row disagreeing about whether the framework had
   *  just killed it, and `status()` must not disagree with `health()` either. */
  function statusOf(
    name: string,
    state: Record<string, unknown>,
  ): string | undefined {
    if (disabledCells.has(name)) return "disabled";
    const fs = state[name] as Record<string, unknown> | undefined;
    const own = fs !== null && typeof fs === "object" ? fs.status : undefined;
    return typeof own === "string" ? own : undefined;
  }

  function disableCell(
    name: string,
    app: { dispatch: (a: Msg) => void; getState: () => unknown },
    /** Called once the disable settled: `false` = rolled back. */
    settled?: (ok: boolean) => void,
  ): void {
    const f = cells.find((f) => f.__aio.id === name);
    disabledCells.add(name);
    if (f && remote?.owns(name)) {
      const destroyType = f.__aio.destroyType;
      remote.disable(name, (ok) => {
        if (!ok) {
          // Rolled back over there — roll back here, as the local path does.
          disabledCells.delete(name);
          settled?.(false);
          return;
        }
        // Unconditionally, even when an `enable` raced in behind the
        // disable: the owner reset its copy and cancels nothing it re-arms
        // until it re-inits, which it does AFTER this reply (FIFO) — so the
        // reset and the cancel both belong before that.
        app.dispatch(tagSource({ type: destroyType, payload: {} }, "System"));
        cellLastAction.delete(name);
        if (onCellDisable) onCellDisable(name);
        settled?.(true);
      });
      return;
    }
    try {
      if (f) {
        if (f.__aio.onDestroy) {
          const scopedApp = makeScopedApp(f, app, reportError);
          f.__aio.onDestroy(scopedApp);
        }
        app.dispatch(
          tagSource({ type: f.__aio.destroyType, payload: {} }, "System"),
        );
      }
    } catch (e) {
      disabledCells.delete(name);
      countCellError(f?.__aio.id ?? name);
      const msg = `disable("${name}") failed, rolled back: ${e}`;
      if (reportError) {
        reportError(
          createAioError("DESTROY_ERROR", msg, {
            cellName: f?.__aio.id ?? name,
          }),
        );
      } else {
        log.error("cell", msg);
      }
      settled?.(false);
      return;
    }
    if (f) {
      // The ERROR COUNT survives a disable. `clearCell` wipes it, and the
      // breaker disables a cell BECAUSE of those errors — so the one moment
      // an operator most needs the number was the moment it went to zero.
      // Measured after a trip: `enabled: false` beside `errors: 0`, and
      // `aio_cell_errors_total` — declared `# TYPE counter` — reset to 0,
      // which is the counter-reset defect `server-metrics.ts` documents as
      // fixed for the broadcast counters.
      cellLastAction.delete(f.__aio.id);
      if (onCellDisable) onCellDisable(f.__aio.id);
    }
    settled?.(true);
  }

  const registry: Registry = {
    enable: (
      name: string,
      app: { dispatch: (a: Msg) => void; getState: () => unknown },
    ) => {
      disabledCells.delete(name);
      cellErrors.set(name, []);
      const f = cells.find((f) => f.__aio.id === name);
      if (f) {
        app.dispatch(
          tagSource({ type: f.__aio.initType, payload: {} }, "System"),
        );
        // The owner runs `onInit` (and its own `__init`); its errors come home
        // as cell errors and are counted there.
        if (remote?.owns(name)) {
          remote.enable(name);
          return;
        }
        if (f.__aio.onInit) {
          const scopedApp = makeScopedApp(f, app, reportError);
          try {
            // `onInit` is server code (it runs at boot, before any client
            // exists) — see call-origin.ts.
            inServerOrigin(() => f.__aio.onInit!(scopedApp, f.__aio.state));
          } catch (e) {
            if (reportError) {
              reportError(
                createAioError("INIT_ERROR", e, { cellName: f.__aio.id }),
              );
            } else {
              log.error("cell", `${f.__aio.id} init: ${e}`);
            }
            countCellError(f.__aio.id);
          }
        }
      }
    },

    disable: (name, app) => disableCell(name, app),

    isEnabled: (name: string) => !disabledCells.has(name),

    status: (
      name: string,
      state: Record<string, unknown>,
    ): string | undefined => statusOf(name, state),

    health: (state: Record<string, unknown>): CellStatus[] => {
      return cells.map((f) => {
        const last = cellLastAction.get(f.__aio.id);
        const off = disabledCells.has(f.__aio.id);
        return {
          name: f.__aio.id,
          status: statusOf(f.__aio.id, state),
          enabled: !off,
          errors: (cellErrors.get(f.__aio.id) ?? []).length,
          lastAction: last?.type,
          lastActionAt: last?.at,
        };
      });
    },

    setOnDisable: (fn: (prefix: string) => void) => {
      onCellDisable = fn;
    },
  };

  return {
    registry,
    countCellError,
    clearCell,
    setCbApp: (app) => {
      cbApp = app;
    },
    setRemote: (r) => {
      remote = r;
    },
  };
}

/** Init all cells in dependency order */
export function initAll(
  cells: CellDef[],
  app: { dispatch: (a: Msg) => void; getState: () => unknown },
  reportError: ((err: AioError) => void) | undefined,
  countCellError: (name: string) => void,
  /** Cells another ISOLATE owns. A `worker: true` cell composes on both sides
   *  — main routes to it, the worker runs it — and both sides used to walk
   *  this loop, so its `onInit` ran TWICE, on two threads. Measured: an
   *  `onInit` that opens a device, seeds a table or starts a watcher did it
   *  twice, once in each isolate, and the in-isolate harness could never see
   *  it because there is no second isolate there. */
  skip?: (cellId: string) => boolean,
): void {
  for (const f of cells) {
    if (skip?.(f.__aio.id)) continue;
    app.dispatch(tagSource({ type: f.__aio.initType, payload: {} }, "System"));
    if (f.__aio.onInit) {
      const scopedApp: ScopedApp & { _onError?: (err: AioError) => void } = {
        _onError: reportError,
        dispatch: (a: Msg) => app.dispatch(tagSource(a, "System")),
        getState: () =>
          (app.getState() as Record<string, unknown>)[f.__aio.id] as unknown,
        getFullState: () => app.getState() as Record<string, unknown>,
      };
      const failed = (e: unknown) => {
        if (reportError) {
          reportError(
            createAioError("INIT_ERROR", e, { cellName: f.__aio.id }),
          );
        } else {
          log.error("cell", `${f.__aio.id} init: ${e}`);
        }
        countCellError(f.__aio.id);
      };
      try {
        // Server code, exactly as above — see call-origin.ts.
        const r: unknown = inServerOrigin(() =>
          f.__aio.onInit!(scopedApp, f.__aio.state)
        );
        // An `async onInit` that rejects is the same failure as one that
        // throws. Nothing observed the promise, so it was an UNHANDLED
        // rejection: on the main isolate a crash-handler line with no
        // INIT_ERROR, no `onError`, no fix — and inside a `worker: true`
        // cell's worker it killed the thread, leaving the cell unreachable for
        // the life of the process while every harness kept serving it.
        const then = (r as { then?: unknown } | null)?.then;
        if (typeof then === "function") {
          then.call(r, undefined, failed);
        }
      } catch (e) {
        failed(e);
      }
    }
  }
}

/** Destroy all cells in reverse dependency order */
export function destroyAll(
  cells: CellDef[],
  app: { dispatch: (a: Msg) => void; getState: () => unknown },
  reportError: ((err: AioError) => void) | undefined,
  countCellError: (name: string) => void,
  clearCell: (id: string) => void,
  /** Cells another isolate owns — see the note on `initAll`'s `skip`. */
  skip?: (cellId: string) => boolean,
): void {
  for (let i = cells.length - 1; i >= 0; i--) {
    const f = cells[i]!;
    if (skip?.(f.__aio.id)) continue;
    if (f.__aio.onDestroy) {
      const scopedApp: ScopedApp & { _onError?: (err: AioError) => void } = {
        _onError: reportError,
        dispatch: (a: Msg) => app.dispatch(tagSource(a, "System")),
        getState: () =>
          (app.getState() as Record<string, unknown>)[f.__aio.id] as unknown,
        getFullState: () => app.getState() as Record<string, unknown>,
      };
      try {
        f.__aio.onDestroy(scopedApp);
      } catch (e) {
        if (reportError) {
          reportError(
            createAioError("DESTROY_ERROR", e, { cellName: f.__aio.id }),
          );
        } else {
          log.error("cell", `${f.__aio.id} destroy: ${e}`);
        }
        countCellError(f.__aio.id);
      }
    }
    app.dispatch(
      tagSource({ type: f.__aio.destroyType, payload: {} }, "System"),
    );
    clearCell(f.__aio.id);
  }
}
