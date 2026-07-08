// cell-actions-factory.ts — createCellFromActions: explicit actions/reduce-based cell factory

import type { ScheduleEffect } from "./schedule.ts";
import type { OwnEffect } from "./own.ts";
import type {
  CellAio,
  CellDef,
  CellExecuteFn,
  CellReduceFn,
  Creators,
  FlatActions,
  MachineConfig,
  Msg,
  ScopedApp,
} from "./cell-types.ts";
import { checkReservedKeys, RESERVED_KEYS } from "./cell-types.ts";
import { normalizeSyncConfig } from "../sync/types.ts";
import {
  buildCatalog,
  flattenOnto,
  installDefaultStateGetters,
} from "./cell-catalog.ts";
import { validateMachine } from "./cell-machine.ts";
import type { ActionsCellConfig } from "./cell-config-types.ts";
import type { GeneratorEntry } from "./cell-config-types.ts";
import {
  buildFlows,
  detectForeignActions,
  extractForUser,
  normalizePersistFilter,
  normalizeUiFilter,
  scopeSelectors,
} from "./cell-helpers.ts";
import { createAioError } from "../diagnostics/error.ts";
import { log } from "../diagnostics/logger.ts";

export function createCellFromActions<
  N extends string,
  S extends Record<string, unknown>,
  A extends Creators,
  E extends Creators,
>(
  name: N,
  config: ActionsCellConfig<N, S, A, E>,
): CellDef<N, A, E, S> & FlatActions<N, A> {
  const prefix = name;
  const actionKeySet = new Set(Object.keys(config.actions));
  const effectKeyList = Object.keys(config.effects ?? {});
  const selectorNames = Object.keys(config.selectors ?? {});

  // Validate names against reserved keys — fail fast with clear message
  checkReservedKeys(name, [...actionKeySet], "action");
  checkReservedKeys(name, effectKeyList, "effect");
  checkReservedKeys(name, selectorNames, "selector");

  // AIO-6.1: a state key colliding with any callable is a definition-time error —
  // the callable wins on the cell object, so `cell.key` in a component would return
  // the function and the state would be silently unreachable (violates AIO4).
  for (const stateKey of Object.keys(config.state ?? {})) {
    const kind = actionKeySet.has(stateKey)
      ? "action"
      : effectKeyList.includes(stateKey)
      ? "effect"
      : null;
    if (kind) {
      throw new Error(
        `[cell:${name}] state key '${stateKey}' collides with ${kind} '${stateKey}' — ` +
          `reading ${name}.${stateKey} in a component would return the function, ` +
          `not the state. Rename one (e.g. state key 'last${
            stateKey.charAt(0).toUpperCase() + stateKey.slice(1)
          }').`,
      );
    }
  }

  const machine: MachineConfig | false =
    (config.machine === false || config.machine == null)
      ? false
      : config.machine as MachineConfig<string>;

  // Build catalogs
  const { catalog: aCatalog, typeToKey: actionTypeToKey } = buildCatalog(
    prefix,
    config.actions,
  );
  const { catalog: eCatalog } = buildCatalog(prefix, config.effects ?? {});

  // Validate machine
  if (machine !== false) {
    validateMachine(name, machine, actionKeySet);
  }

  const foreignActions = detectForeignActions(machine, prefix);

  // Build flows from generators (keyed by trigger action key)
  const rawGenerators = (config.generators ?? {}) as Record<
    string,
    GeneratorEntry
  >;
  const { flows, flowTriggers } = buildFlows(
    rawGenerators,
    actionKeySet,
    name,
    config,
    "payload",
  );

  // Default noop reducer when only generators are used
  const noopReduce: CellReduceFn = () => undefined;

  // Build { on } map: camelCase key → full type string (for function-form reduce/execute)
  const onMap: Record<string, string> = {};
  for (const key of actionKeySet) onMap[key] = `${prefix}:${key}`;
  const emitMap: Record<string, string> = {};
  for (const key of effectKeyList) emitMap[key] = `${prefix}:${key}`;

  // Normalize reduce: object form → CellReduceFn, function form → wrap with { on }
  const reduceFn: CellReduceFn = buildActionsReducer(
    config,
    actionTypeToKey,
    noopReduce,
    onMap,
  );

  // Normalize execute: object form → CellExecuteFn, function form → wrap with { emit }
  const executeFn: CellExecuteFn | undefined = buildActionsExecutor(
    config,
    effectKeyList,
    prefix,
    emitMap,
  );

  const internals: Omit<
    CellAio,
    "actions" | "effects" | "selectors" | "bound" | "selectorDeps"
  > = {
    state: config.state,
    machine,
    reduce: reduceFn,
    execute: executeFn,
    actionKeys: [...actionKeySet],
    effectKeys: effectKeyList,
    id: prefix,
    actionTypeToKey,
    foreignActions,
    initType: `${prefix}:__init`,
    destroyType: `${prefix}:__destroy`,
    onInit: config.onInit as ((app: ScopedApp) => void) | undefined,
    onDestroy: config.onDestroy as ((app: ScopedApp) => void) | undefined,
    flows: Object.keys(flows).length > 0 ? flows : undefined,
    flowTriggers: flowTriggers.size > 0 ? flowTriggers : undefined,
    validate: config.validate,
    persist: normalizePersistFilter(config.persist),
    ui: normalizeUiFilter(config.ui),
    uiForUser: extractForUser(config.ui),
    syncConfig: config.sync ? normalizeSyncConfig(config.sync) : undefined,
    scope: "server",
    version: config.version ?? 0,
    onMigrate: config.onMigrate as
      | ((
        state: Record<string, unknown>,
        fromVersion: number,
      ) => Record<string, unknown>)
      | undefined,
  };

  // Validate selector names don't collide with reserved keys
  const selectorKeys = new Set(Object.keys(config.selectors ?? {}));
  for (const key of selectorKeys) {
    if (RESERVED_KEYS.has(key)) {
      throw new Error(
        `[${name}] selector '${key}' collides with reserved property`,
      );
    }
  }

  const scopedSelectors = scopeSelectors(name, config.selectors);
  const selectorDeps: Record<string, readonly string[]> = {};
  if (config.selectors) {
    for (const [key, def] of Object.entries(config.selectors)) {
      if (typeof def === "function") continue;
      selectorDeps[key] = def.deps;
    }
  }

  const def: Record<string, unknown> = {
    __aio: {
      ...internals,
      selectors: scopedSelectors,
      selectorDeps,
      actions: aCatalog as unknown,
      effects: eCatalog as unknown,
      bound: false,
    },
    fx: eCatalog,
  };

  // Flatten action creators + string constants directly onto the cell def
  flattenOnto(def, aCatalog, selectorKeys, name);

  // Pre-bind reads (`cell.key` before aio.run()) return the declared default.
  installDefaultStateGetters(def as unknown as CellDef);

  return def as unknown as CellDef<N, A, E, S> & FlatActions<N, A>;
}

// ── Internal builders ──────────────────────────────────────────────────

function buildActionsReducer(
  // deno-lint-ignore no-explicit-any
  config: ActionsCellConfig<any, any, any, any, any>,
  actionTypeToKey: Map<string, string>,
  noopReduce: CellReduceFn,
  onMap: Record<string, string>,
): CellReduceFn {
  if (!config.reduce) return noopReduce;

  if (typeof config.reduce === "object") {
    const handlers = config.reduce as Record<
      string,
      (state: unknown, payload: unknown) => void
    >;
    return (
      state: unknown,
      action: Msg,
    ): (Msg | ScheduleEffect | OwnEffect)[] | void => {
      const key = actionTypeToKey.get(action.type);
      if (!key) {
        // Foreign action key — use full type string
        const h = handlers[action.type];
        if (h) {
          return h(state, (action as { payload: unknown }).payload) as
            | (Msg | ScheduleEffect | OwnEffect)[]
            | void;
        }
        return;
      }
      const h = handlers[key];
      if (h) {
        return h(state, (action as { payload: unknown }).payload) as
          | (Msg | ScheduleEffect | OwnEffect)[]
          | void;
      }
    };
  }

  // Function form: wrap to inject { on } instead of { A, E }
  const userReduceFn = config.reduce as (
    state: unknown,
    action: Msg,
    ctx: { on: Record<string, string> },
  ) => (Msg | ScheduleEffect | OwnEffect)[] | void;
  return (
    state: unknown,
    action: Msg,
  ): (Msg | ScheduleEffect | OwnEffect)[] | void =>
    userReduceFn(state, action, { on: onMap });
}

function buildActionsExecutor(
  // deno-lint-ignore no-explicit-any
  config: ActionsCellConfig<any, any, any, any, any>,
  effectKeyList: string[],
  prefix: string,
  emitMap: Record<string, string>,
): CellExecuteFn | undefined {
  if (!config.execute) return undefined;

  if (typeof config.execute === "object") {
    const handlers = config.execute as Record<
      string,
      (app: ScopedApp, payload: unknown) => void | Promise<void>
    >;
    const effectTypeToKey = new Map<string, string>();
    for (const key of effectKeyList) {
      effectTypeToKey.set(`${prefix}:${key}`, key);
    }
    return (app: ScopedApp, effect: Msg): void => {
      const key = effectTypeToKey.get(effect.type) ?? effect.type;
      const h = handlers[key];
      if (h) {
        const result = h(app, (effect as { payload: unknown }).payload);
        if (result && typeof result === "object" && "catch" in result) {
          (result as Promise<void>).catch((e) => {
            const _onError = (app as Record<string, unknown>)._onError as
              | ((err: import("../diagnostics/error.ts").AioError) => void)
              | undefined;
            if (_onError) {
              _onError(createAioError("EFFECT_ASYNC_ERROR", e, {
                cellName: prefix,
                effectType: effect.type as string,
              }));
            } else {
              log.error("cell", `${prefix} ${key}() execute threw: ${e}`);
            }
          });
        }
      }
    };
  }

  // Function form: wrap to inject { emit } instead of { E, A }
  const userExecuteFn = config.execute as (
    app: ScopedApp,
    effect: Msg,
    ctx: { emit: Record<string, string> },
  ) => void;
  return (app: ScopedApp, effect: Msg): void =>
    userExecuteFn(app, effect, { emit: emitMap });
}
