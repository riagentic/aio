// cell-actions-factory.ts — createCellFromActions: explicit actions/reduce-based cell factory

import type { ScheduleEffect } from "./schedule.ts";
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
import { normalizeSyncConfig } from "./sync/types.ts";
import { buildCatalog, flattenOnto } from "./cell-catalog.ts";
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
    "actions" | "effects" | "selectors" | "bound"
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

  const def: Record<string, unknown> = {
    __aio: {
      ...internals,
      selectors: scopedSelectors,
      actions: aCatalog as unknown,
      effects: eCatalog as unknown,
      bound: false,
    },
  };

  // Flatten action creators + string constants directly onto the cell def
  flattenOnto(def, aCatalog, selectorKeys, name);

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
    return (state: unknown, action: Msg): (Msg | ScheduleEffect)[] | void => {
      const key = actionTypeToKey.get(action.type);
      if (!key) {
        // Foreign action key — use full type string
        const h = handlers[action.type];
        if (h) {
          return h(state, (action as { payload: unknown }).payload) as
            | (Msg | ScheduleEffect)[]
            | void;
        }
        return;
      }
      const h = handlers[key];
      if (h) {
        return h(state, (action as { payload: unknown }).payload) as
          | (Msg | ScheduleEffect)[]
          | void;
      }
    };
  }

  // Function form: wrap to inject { on } instead of { A, E }
  const userReduceFn = config.reduce as (
    state: unknown,
    action: Msg,
    ctx: { on: Record<string, string> },
  ) => (Msg | ScheduleEffect)[] | void;
  return (state: unknown, action: Msg): (Msg | ScheduleEffect)[] | void =>
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
      if (h) void h(app, (effect as { payload: unknown }).payload);
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
