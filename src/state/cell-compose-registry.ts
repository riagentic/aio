// cell-compose-registry.ts — cell enable/disable registry, circuit breaker, lifecycle, health

import { log } from "../diagnostics/logger-api.ts";
import type { AioError } from "../diagnostics/error.ts";
import { createAioError } from "../diagnostics/error.ts";
import type { CellDef, Msg, ScopedApp } from "./cell-types.ts";
import { tagSource } from "./cell-types.ts";
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
      !disabledCells.has(name) && cbApp
    ) {
      registry.disable(name, cbApp);
      if (circuitBreaker?.onTrip) circuitBreaker.onTrip(name, count);
      if (reportError) {
        reportError(
          createAioError(
            "EFFECT_ERROR",
            `circuit breaker tripped: cell "${name}" auto-disabled after ${count} errors${
              cbWindow ? ` in ${cbWindow}ms` : ""
            }`,
            { cellName: name },
          ),
        );
      }
    }
  }

  function clearCell(id: string): void {
    cellErrors.delete(id);
    cellLastAction.delete(id);
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
        if (f.__aio.onInit) {
          const scopedApp = makeScopedApp(f, app, reportError);
          try {
            f.__aio.onInit(scopedApp, f.__aio.state);
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

    disable: (
      name: string,
      app: { dispatch: (a: Msg) => void; getState: () => unknown },
    ) => {
      const f = cells.find((f) => f.__aio.id === name);
      disabledCells.add(name);
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
        return;
      }
      if (f) {
        clearCell(f.__aio.id);
        if (onCellDisable) onCellDisable(f.__aio.id);
      }
    },

    isEnabled: (name: string) => !disabledCells.has(name),

    status: (
      name: string,
      state: Record<string, unknown>,
    ): string | undefined => {
      const fs = state[name] as Record<string, unknown> | undefined;
      return fs?.__aio_status as string | undefined;
    },

    health: (state: Record<string, unknown>): CellStatus[] => {
      return cells.map((f) => {
        const fs = state[f.__aio.id] as Record<string, unknown> | undefined;
        const last = cellLastAction.get(f.__aio.id);
        return {
          name: f.__aio.id,
          status: fs?.__aio_status as string | undefined,
          enabled: !disabledCells.has(f.__aio.id),
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
  };
}

/** Init all cells in dependency order */
export function initAll(
  cells: CellDef[],
  app: { dispatch: (a: Msg) => void; getState: () => unknown },
  reportError: ((err: AioError) => void) | undefined,
  countCellError: (name: string) => void,
): void {
  for (const f of cells) {
    app.dispatch(tagSource({ type: f.__aio.initType, payload: {} }, "System"));
    if (f.__aio.onInit) {
      const scopedApp: ScopedApp & { _onError?: (err: AioError) => void } = {
        _onError: reportError,
        dispatch: (a: Msg) => app.dispatch(tagSource(a, "System")),
        getState: () =>
          (app.getState() as Record<string, unknown>)[f.__aio.id] as unknown,
        getFullState: () => app.getState() as Record<string, unknown>,
      };
      try {
        f.__aio.onInit(scopedApp, f.__aio.state);
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
}

/** Destroy all cells in reverse dependency order */
export function destroyAll(
  cells: CellDef[],
  app: { dispatch: (a: Msg) => void; getState: () => unknown },
  reportError: ((err: AioError) => void) | undefined,
  countCellError: (name: string) => void,
  clearCell: (id: string) => void,
): void {
  for (let i = cells.length - 1; i >= 0; i--) {
    const f = cells[i]!;
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
