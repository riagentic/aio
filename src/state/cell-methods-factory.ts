// cell-methods-factory.ts — createCellFromMethods: reactive/methods-based cell factory

import type { CellMethods, Method, Mutation } from "./cell-impl.ts";
import { classifyMethods, setKey } from "./cell-impl.ts";
import type {
  CellAio,
  CellDef,
  CellExecuteFn,
  CellReduceFn,
  Creators,
  DirectCalling,
  ScopedApp,
} from "./cell-types.ts";
import { checkReservedKeys, RESERVED_KEYS } from "./cell-types.ts";
import { normalizeSyncConfig } from "../sync/types.ts";
import {
  buildCatalog,
  installDefaultStateGetters,
  makeUnboundGuard,
} from "./cell-catalog.ts";
import { validateMachine } from "./cell-machine.ts";
import type { GeneratorEntry, MethodsCellConfig } from "./cell-config-types.ts";
import {
  buildFlows,
  detectForeignActions,
  extractForUser,
  normalizePersistFilter,
  normalizeUiFilter,
  scopeSelectors,
} from "./cell-helpers.ts";
import {
  buildMethodsExecutor,
  buildMethodsMachine,
  buildMethodsReducer,
} from "./cell-methods-internals.ts";

export function createCellFromMethods<
  N extends string,
  S extends Record<string, unknown>,
  M extends Record<string, Method<S>> = Record<string, Method<S>>,
>(
  name: N,
  config: MethodsCellConfig<N, S, M>,
):
  & CellDef<N, Record<string, never>, Record<string, never>, S>
  & DirectCalling<N, M> {
  const prefix = name;
  const methods = (config.methods ?? {}) as Record<string, Method<S>>;
  const methodNames = Object.keys(methods);
  const rawGenerators = (config.generators ?? {}) as Record<
    string,
    GeneratorEntry
  >;
  const generatorNames = Object.keys(rawGenerators);
  const selectorNames = Object.keys(config.selectors ?? {});
  const explicitActions: Creators | undefined = config.actions;
  const explicitActionNames = Object.keys(explicitActions ?? {});
  const explicitEffects: Creators | undefined = config.effects;
  const explicitEffectNames = Object.keys(explicitEffects ?? {});
  const explicitReduce = config.reduce as
    | Record<string, (state: unknown, payload: unknown) => void>
    | undefined;
  const explicitExecute = config.execute as
    | Record<string, (app: ScopedApp, payload: unknown) => void | Promise<void>>
    | undefined;

  // Validate names against reserved keys — fail fast with clear message
  checkReservedKeys(name, methodNames, "method");
  checkReservedKeys(name, generatorNames, "generator");
  checkReservedKeys(name, explicitActionNames, "action");
  checkReservedKeys(name, explicitEffectNames, "effect");
  checkReservedKeys(name, selectorNames, "selector");

  // Validate no name collisions across methods, generators, actions, effects
  const allNames = new Map<string, string>();
  for (const n of methodNames) allNames.set(n, "method");
  for (const n of generatorNames) {
    if (allNames.has(n)) {
      throw new Error(
        `[cell:${name}] generator "${n}" collides with ${
          allNames.get(n)
        } of same name. Rename one (e.g. generator "${n}Flow").`,
      );
    }
    allNames.set(n, "generator");
  }
  for (const n of explicitActionNames) {
    if (allNames.has(n)) {
      throw new Error(
        `[cell:${name}] action "${n}" collides with ${
          allNames.get(n)
        } of same name. Rename one (e.g. action "${n}Action").`,
      );
    }
    allNames.set(n, "action");
  }
  for (const n of explicitEffectNames) {
    if (allNames.has(n)) {
      throw new Error(
        `[cell:${name}] effect "${n}" collides with ${
          allNames.get(n)
        } of same name. Rename one (e.g. effect "on${
          n.charAt(0).toUpperCase()
        }${n.slice(1)}").`,
      );
    }
    allNames.set(n, "effect");
  }

  // AIO-6.1: a state key colliding with any callable is a definition-time error —
  // the callable wins on the cell object, so `cell.key` in a component would return
  // the function and the state would be silently unreachable (violates AIO4).
  for (const stateKey of Object.keys(config.state ?? {})) {
    const kind = allNames.get(stateKey);
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

  // Classify methods as sync or async (uses isAsyncFunction — symbol-based, minification-safe)
  const { syncMethods, asyncMethods } = classifyMethods(
    methods as CellMethods<Record<string, unknown>>,
  );

  // Build action creators from methods + generators
  const actionCreators: Record<
    string,
    // deno-lint-ignore no-explicit-any
    (...args: any[]) => Record<string, unknown>
  > = {};
  for (const key of methodNames) {
    actionCreators[key] = (...args: unknown[]) => ({ args });
  }
  // Generator actions — same payload shape as methods (args array)
  for (const key of generatorNames) {
    actionCreators[key] = (...args: unknown[]) => ({ args });
  }
  // Explicit actions — custom payload shapes
  if (explicitActions) {
    for (const key of explicitActionNames) {
      actionCreators[key] = explicitActions[key]!;
    }
  }
  // Add __setMethod actions for async mutations
  for (const key of asyncMethods) {
    actionCreators[setKey(key)] = (mutations: Mutation[], _origin: string) => ({
      mutations,
      _origin,
    });
  }
  // Add __error action for async failures
  if (asyncMethods.size > 0) {
    actionCreators["__error"] = (_method: string, error: string) => ({
      _method,
      error,
    });
    // AIO-381: bridge action for schedule effects returned by async methods
    actionCreators["__effects"] = (effects: unknown[]) => ({ effects });
  }

  const { typeToKey: actionTypeToKey } = buildCatalog(prefix, actionCreators);

  // Build effect creators
  const effectCreators: Record<
    string,
    // deno-lint-ignore no-explicit-any
    (...args: any[]) => Record<string, unknown>
  > = {};
  const effectKeys = Object.keys(config.effects ?? {});
  for (const key of effectKeys) {
    effectCreators[key] = (config.effects as Record<
      string,
      (...args: unknown[]) => Record<string, unknown>
    >)[key]!;
  }
  const { catalog: eCatalog } = buildCatalog(prefix, effectCreators);

  // Build machine
  const machine = buildMethodsMachine(
    name,
    config,
    methodNames,
    asyncMethods,
    generatorNames,
    explicitActionNames,
  );

  const foreignActions = detectForeignActions(machine, prefix);

  const allActionKeys = [
    ...methodNames,
    ...generatorNames,
    ...explicitActionNames,
    ...[...asyncMethods].map((k) => setKey(k)),
  ];
  if (asyncMethods.size > 0) allActionKeys.push("__error", "__effects");

  // Validate machine if provided
  if (machine !== false) {
    validateMachine(name, machine, new Set(allActionKeys));
  }

  // Build reducer
  const reduce: CellReduceFn = buildMethodsReducer(
    actionTypeToKey,
    methods as Record<string, Method<Record<string, unknown>>>,
    syncMethods,
    asyncMethods,
    prefix,
    explicitReduce,
  );

  // Build executor for async methods
  const execute: CellExecuteFn | undefined =
    asyncMethods.size > 0 || config.effects || explicitExecute
      ? buildMethodsExecutor(
        name,
        prefix,
        methods as Record<string, Method<Record<string, unknown>>>,
        asyncMethods,
        config,
        effectKeys,
        explicitExecute,
      )
      : undefined;

  const { flows, flowTriggers } = buildFlows(
    rawGenerators,
    new Set(allActionKeys),
    name,
    config,
    "spread",
  );

  // Assemble internals — mirrored in cell-actions-factory.ts (CellAio type enforces field consistency)
  const internals: Omit<
    CellAio,
    | "actions"
    | "effects"
    | "selectors"
    | "bound"
    | "selectorDeps"
  > = {
    state: config.state as Record<string, unknown>,
    machine,
    reduce,
    execute,
    actionKeys: [...new Set(allActionKeys)],
    effectKeys,
    id: prefix,
    actionTypeToKey,
    foreignActions,
    initType: `${prefix}:__init`,
    destroyType: `${prefix}:__destroy`,
    onInit: config.onInit as ((app: ScopedApp) => void) | undefined,
    onDestroy: config.onDestroy as ((app: ScopedApp) => void) | undefined,
    scope: "server",
    asyncMethods,
    // Mirrors cell-actions-factory.ts — dropping these here silently disables
    // persist/ui filters, flows, validation and migrations for methods-style cells.
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

  const selectors = scopeSelectors(name, config.selectors);
  const selectorDeps: Record<string, readonly string[]> = {};
  if (config.selectors) {
    for (const [key, def] of Object.entries(config.selectors)) {
      if (typeof def === "function") continue;
      selectorDeps[key] = def.deps;
    }
  }

  // Build public catalog — methods + generators (args-style) + explicit actions (custom payload)
  const publicCatalog: Record<string, unknown> = {};
  for (const key of [...methodNames, ...generatorNames]) {
    const label = `${prefix}:${key}`;
    publicCatalog[key] = Object.assign(
      (...args: unknown[]) => ({ type: label, payload: { args } }),
      { type: label },
    );
  }
  // Explicit actions — custom payload shape
  if (explicitActions) {
    for (const key of explicitActionNames) {
      const label = `${prefix}:${key}`;
      publicCatalog[key] = Object.assign(
        (...args: unknown[]) => ({
          type: label,
          payload: explicitActions[key]!(...args) ?? {},
        }),
        { type: label },
      );
    }
  }

  const def: Record<string, unknown> = {
    __aio: {
      ...internals,
      selectors,
      selectorDeps,
      actions: publicCatalog,
      effects: eCatalog,
      bound: false,
    },
    fx: eCatalog,
  };

  // Flatten onto cell def
  const selectorKeys = new Set(Object.keys(config.selectors ?? {}));
  for (const key of selectorKeys) {
    if (RESERVED_KEYS.has(key)) {
      throw new Error(
        `[${name}] selector '${key}' collides with a reserved cell property. Rename it (e.g. '${key}Value'). Reserved: ${
          [...RESERVED_KEYS].join(", ")
        }.`,
      );
    }
  }
  for (const [key, value] of Object.entries(publicCatalog)) {
    if (RESERVED_KEYS.has(key)) continue;
    if (selectorKeys.has(key)) {
      throw new Error(
        `[${name}] method '${key}' collides with selector of same name. Rename one (e.g. method '${key}Now' or selector '${key}Value').`,
      );
    }
    def[key] = makeUnboundGuard(name, key, value);
  }

  // Pre-bind reads (`cell.key` before aio.run()) return the declared default.
  installDefaultStateGetters(def as unknown as CellDef);

  return def as unknown as
    & CellDef<N, Record<string, never>, Record<string, never>, S>
    & DirectCalling<N, M>;
}
