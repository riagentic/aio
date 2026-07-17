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
  MethodsToCreators,
} from "./cell-types.ts";
import type { Method } from "./cell-impl.ts";
import { createCellFromMethods } from "./cell-methods-factory.ts";
import { createCellFromActions } from "./cell-actions-factory.ts";
import { registerCell } from "./cell-reactive.ts";
import type {
  ActionsCellConfig,
  ExecuteHandlers,
  MethodsCellConfig,
  ReduceHandlers,
  SelectorAccessors,
  SelectorDef,
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
  // Captured from config.selectors (inside MethodsCellConfig — NOT an
  // intersection, which would disrupt method `s` inference) so bound selector
  // accessors surface on the return type instead of being inert config (risoto).
  Sel extends Record<string, SelectorDef<S>> = Record<string, SelectorDef<S>>,
>(
  name: N,
  config: MethodsCellConfig<N, S, M, States, Sel>,
  // Actions carry a concrete creators map derived from the methods (not `any`)
  // so downstream tooling — notably testCell's `t.send` — recovers typed,
  // non-optional method senders instead of an index signature. (Capturing
  // generators/mixed actions here too was tried but degraded method `s`
  // inference, so the typed surface stays scoped to methods.) `Sel` is captured
  // from `config.selectors` so bound selector accessors (`cell.total()`) are
  // type-accessible instead of inert config (risoto).
): // deno-lint-ignore no-explicit-any
& CellDef<N, MethodsToCreators<M>, any, S>
& DirectCalling<N, M>
& SelectorAccessors<Sel>
& Readonly<S>;
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
): CellDef<N, A, E, S> & FlatActions<N, A> & Readonly<S>;
/** Implementation — dispatches on config shape (methods / actions / mixed). */
// deno-lint-ignore no-explicit-any
export function cell(name: string, config: any): any {
  // Validate name at definition time — it becomes the cell id, action prefix
  // (`${name}:action`), KV key prefix, and SQLite table key. An empty,
  // non-string, or identifier-unsafe name would corrupt the registry, the
  // wire protocol, and persistence with a cryptic error at first dispatch.
  // Allows word chars + hyphens (matching existing cell names like
  // "stub-empty", "flc-counter", "uitest-list") but rejects the prototype-
  // pollution trinity explicitly.
  const BANNED_NAMES = new Set(["__proto__", "constructor", "prototype"]);
  if (
    !name || typeof name !== "string" ||
    !/^[A-Za-z_][\w\-]*$/.test(name) ||
    BANNED_NAMES.has(name)
  ) {
    throw new Error(
      `cell(): invalid name '${JSON.stringify(name)}' — must be a non-empty ` +
        `string matching /^[A-Za-z_][\\w\\-]*$/ (identifier-safe, hyphens ok). ` +
        `The name becomes the cell id, action prefix, and persistence key — ` +
        `reserved words (__proto__, constructor, prototype) are rejected.`,
    );
  }
  // Validate state shape at definition time — state must be a plain object so
  // Immer can draft it and reducers can mutate fields. A primitive, null, or
  // array would crash inside produce() at first dispatch with a cryptic error.
  if (
    config.state != null &&
    (typeof config.state !== "object" || Array.isArray(config.state))
  ) {
    throw new Error(
      `[${name}] cell state must be a plain object, got ${
        Array.isArray(config.state) ? "array" : typeof config.state
      } — reducers rely on Immer drafting an object shape.`,
    );
  }

  const hasMethods = config.methods !== undefined;
  const hasGenerators = config.generators &&
    Object.keys(config.generators as Record<string, unknown>).length > 0;
  const hasActions = config.actions &&
    Object.keys(config.actions as Record<string, () => unknown>).length > 0;

  // AIO-5.1: client-scoped cells — browser-local state, sync methods only.
  // Validation happens at cell() time so misuse fails at definition, not at runtime.
  if (config.scope === "client") {
    for (
      const [key, fn] of Object.entries(
        (config.methods ?? {}) as Record<string, unknown>,
      )
    ) {
      if (
        (fn as { constructor: { name: string } }).constructor.name ===
          "AsyncFunction"
      ) {
        throw new Error(
          `[${name}] client-scoped cells support sync methods only (no server ` +
            `round-trip exists); do async work in the component and call sync ` +
            `methods with results — '${key}' is async`,
        );
      }
    }
    if (hasGenerators) {
      throw new Error(
        `[${name}] client-scoped cells do not support generators (v1 limitation). Use sync methods and drive multi-step flows from the component, or move the cell to server scope.`,
      );
    }
    if (hasActions) {
      throw new Error(
        `[${name}] client-scoped cells do not support actions (v1 limitation) — use methods`,
      );
    }
    if (config.machine) {
      throw new Error(
        `[${name}] client-scoped cells do not support machine (v1 limitation). Move the cell to server scope (remove scope: "client") to use a state machine.`,
      );
    }
    const def = createCellFromMethods(
      name,
      config as MethodsCellConfig<string, Record<string, unknown>>,
    );
    def.__aio.scope = "client";
    // Raw sync methods — bindCellReactive runs these locally against the cell signal.
    def.__aio.clientMethods = config.methods as Record<
      string,
      (s: Record<string, unknown>, ...args: unknown[]) => unknown
    >;
    registerCell(def);
    return def;
  }

  // Methods present (with optional generators, actions, effects) → unified builder.
  // An empty or omitted methods map is valid — state-only cells (thin-client stubs).
  if (hasMethods || !hasActions) {
    const def = createCellFromMethods(
      name,
      config as MethodsCellConfig<string, Record<string, unknown>>,
    );
    registerCell(def);
    return def;
  }

  // Actions-only (no methods) → explicit builder
  const def = createCellFromActions(
    name,
    config as ActionsCellConfig<
      string,
      Record<string, unknown>,
      Creators,
      Creators
    >,
  );
  registerCell(def);
  return def;
}
