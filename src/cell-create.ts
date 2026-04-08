// cell-create.ts — cell() dispatcher + public API re-exports
//
// Decomposed into focused modules:
//   cell-config-types.ts    — MethodsCellConfig, ActionsCellConfig, ReduceHandlers, ExecuteHandlers
//   cell-helpers.ts         — normalization, scopeSelectors, detectForeignActions, buildFlows
//   cell-methods-factory.ts — createCellFromMethods (reactive/methods style)
//   cell-actions-factory.ts — createCellFromActions (explicit actions/reduce style)

import type {
  CellDef,
  Creators,
  DirectCalling,
  FlatActions,
} from "./cell-types.ts";
import type { Method } from "./cell-impl.ts";
import { createCellFromMethods } from "./cell-methods-factory.ts";
import { createCellFromActions } from "./cell-actions-factory.ts";
import type {
  ActionsCellConfig,
  ExecuteHandlers,
  MethodsCellConfig,
  ReduceHandlers,
} from "./cell-config-types.ts";

export type {
  ActionsCellConfig,
  ExecuteHandlers,
  MethodsCellConfig,
  ReduceHandlers,
};

// ── cell() ──────────────────────────────────────────────────────

/** Define a cell — methods, actions, or mixed.
 *  Methods: reactive style with sync/async functions.
 *  Actions: explicit typed action creators + reduce handlers.
 *  Mixed: methods + actions/effects in one cell (names must not collide). */
export function cell<
  N extends string,
  S extends Record<string, unknown>,
  M extends Record<string, Method<S>>,
  States extends string = string,
>(
  name: N,
  config: MethodsCellConfig<N, S, M, States>,
  // deno-lint-ignore no-explicit-any
): CellDef<N, any, any, S> & DirectCalling<N, M>;
/** Define a cell with explicit actions/reduce style — typed action creators + reducer handlers. */
export function cell<
  N extends string,
  S extends Record<string, unknown>,
  A extends Creators,
  E extends Creators = Record<string, never>,
  States extends string = string,
>(
  name: N,
  config: ActionsCellConfig<N, S, A, E, States>,
): CellDef<N, A, E, S> & FlatActions<N, A>;
// deno-lint-ignore no-explicit-any
export function cell(name: string, config: any): any {
  const hasMethods = config.methods &&
    Object.keys(config.methods as Record<string, unknown>).length > 0;
  const hasGenerators = config.generators &&
    Object.keys(config.generators as Record<string, unknown>).length > 0;
  const hasActions = config.actions &&
    Object.keys(config.actions as Record<string, () => unknown>).length > 0;

  // Methods present (with optional generators, actions, effects) → unified builder
  if (hasMethods || (hasGenerators && !hasActions)) {
    return createCellFromMethods(
      name,
      config as MethodsCellConfig<string, Record<string, unknown>>,
    );
  }

  // Actions-only (no methods) → explicit builder
  return createCellFromActions(
    name,
    config as ActionsCellConfig<
      string,
      Record<string, unknown>,
      Creators,
      Creators
    >,
  );
}
