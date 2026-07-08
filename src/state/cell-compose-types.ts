// cell-compose-types.ts — shared types for the compose pipeline

import type { ScheduleEffect } from "./schedule.ts";
import type { OwnEffect } from "./own.ts";
import type { ReduceBreakdown } from "../diagnostics/time-travel.ts";
import type { CellDef, Msg } from "./cell-types.ts";

/** Cell status info for health/status reporting */
export type CellStatus = {
  name: string;
  status: string | undefined;
  enabled: boolean;
  errors: number;
  lastAction?: string;
  lastActionAt?: number;
};

/** Resolved + sorted cells with dependency info */
export type ComposedCells = {
  initialState: Record<string, unknown>;
  reduce: (
    state: Record<string, unknown>,
    action: Msg,
  ) => {
    state: Record<string, unknown>;
    effects: (Msg | ScheduleEffect | OwnEffect)[];
  };
  execute: (
    app: { dispatch: (a: Msg) => void; getState: () => unknown },
    effect: Msg,
  ) => void;
  cells: CellDef[];
  cellNames: string[];
  /** Init all cells in dependency order */
  initAll: (
    app: { dispatch: (a: Msg) => void; getState: () => unknown },
  ) => void;
  /** Destroy all cells in reverse dependency order */
  destroyAll: (
    app: { dispatch: (a: Msg) => void; getState: () => unknown },
  ) => void;
  /** Cell registry for enable/disable/status/health */
  registry: {
    enable: (
      name: string,
      app: { dispatch: (a: Msg) => void; getState: () => unknown },
    ) => void;
    disable: (
      name: string,
      app: { dispatch: (a: Msg) => void; getState: () => unknown },
    ) => void;
    isEnabled: (name: string) => boolean;
    status: (
      name: string,
      state: Record<string, unknown>,
    ) => string | undefined;
    health: (state: Record<string, unknown>) => CellStatus[];
    /** Set callback for schedule cleanup on cell disable */
    setOnDisable: (fn: (prefix: string) => void) => void;
  };
  /** Side-channel getter for last reduce breakdown (only when perfCheck is on) */
  lastBreakdown?: () => ReduceBreakdown | undefined;
};

/** Circuit breaker configuration for auto-disabling misbehaving cells */
export type CircuitBreakerConfig = {
  /** Max errors before auto-disabling a cell (default: 0 = disabled) */
  maxErrors?: number;
  /** Called when a cell is auto-disabled by circuit breaker */
  onTrip?: (cellName: string, errorCount: number) => void;
  /** Rolling window in ms — only count errors within this period. Omit for cumulative counting. */
  window?: number;
};
