// cell-methods-factory.ts — createCellFromMethods: reactive/methods-based cell factory

import type { CellMethods, Method, Mutation } from "./cell-impl.ts";
import { freezeInitial } from "./immutable.ts";
import { classifyMethods, setKey } from "./cell-impl.ts";
import type {
  CellAio,
  CellDef,
  CellExecuteFn,
  CellReduceFn,
  DirectCalling,
  ScopedApp,
} from "./cell-types.ts";
import { checkReservedKeys, RESERVED_KEYS } from "./cell-types.ts";
import { normalizeSyncConfig } from "../sync/types.ts";
import {
  buildArgsCatalog,
  buildCatalog,
  installDefaultStateGetters,
  makeUnboundGuard,
} from "./cell-catalog.ts";
import { validateMachine } from "./cell-machine.ts";
import type { MethodsCellConfig } from "./cell-config-types.ts";
import {
  detectForeignActions,
  extractForUser,
  extractPublicFields,
  normalizePersistFilter,
  normalizeUiFilter,
  scopeSelectors,
  validateFieldFilters,
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
  const selectorNames = Object.keys(config.selectors ?? {});

  // Validate names against reserved keys — fail fast with clear message
  checkReservedKeys(name, methodNames, "method");
  checkReservedKeys(name, selectorNames, "selector");

  // Callable-name registry (methods only — the one style, D1); state-key
  // collision check below reads it.
  const allNames = new Map<string, string>();
  for (const n of methodNames) allNames.set(n, "method");

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

  // Field-filter keys must resolve to real state — a non-matching filter
  // silently leaks (risoto). Fail loud at creation.
  validateFieldFilters(
    name,
    config.state as Record<string, unknown>,
    config.ui,
    config.persist,
  );

  // listensTo (D1): normalize both forms. Object form maps a foreign action
  // type → a SYNC method that handles it; array form only routes (status).
  const foreignHandlers = new Map<string, string>();
  const listensToTriggers: (string | { type: string })[] = [];
  if (config.listensTo) {
    if (Array.isArray(config.listensTo)) {
      listensToTriggers.push(...config.listensTo);
    } else {
      for (const [methodKey, trigger] of Object.entries(config.listensTo)) {
        const t = typeof trigger === "string" ? trigger : trigger.type;
        if (!methods[methodKey]) {
          throw new Error(
            `[cell:${name}] listensTo: { ${methodKey}: "${t}" } — no method ` +
              `named '${methodKey}'. The object form maps an EXISTING sync ` +
              `method to the foreign action that triggers it.`,
          );
        }
        foreignHandlers.set(t, methodKey);
        listensToTriggers.push(t);
      }
    }
  }

  // Classify methods as sync or async (uses isAsyncFunction — symbol-based, minification-safe)
  const { syncMethods, asyncMethods } = classifyMethods(
    methods as CellMethods<Record<string, unknown>>,
  );
  for (const [t, mk] of foreignHandlers) {
    if (asyncMethods.has(mk)) {
      throw new Error(
        `[cell:${name}] listensTo handler '${mk}' (for "${t}") must be a ` +
          `SYNC method — reactions run inside the reduce; do async work by ` +
          `having '${mk}' set state that an async method awaits on.`,
      );
    }
  }

  // Build action creators from methods
  const actionCreators: Record<
    string,
    // deno-lint-ignore no-explicit-any
    (...args: any[]) => Record<string, unknown>
  > = {};
  for (const key of methodNames) {
    actionCreators[key] = (...args: unknown[]) => ({ args });
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

  // Effect creators died with Style B (D1) — schedule/own effects returned
  // from methods are the effect mechanism. Empty catalog keeps `.fx` shape.
  const effectKeys: string[] = [];
  const eCatalog: Record<string, unknown> = {};

  // Build the internal machine (only source now: listensTo auto-routing —
  // the public machine: config died with Style B, D1)
  const machine = buildMethodsMachine(
    name,
    { ...config, listensTo: listensToTriggers },
    methodNames,
    asyncMethods,
    [],
    [],
  );

  const foreignActions = detectForeignActions(machine, prefix);

  const allActionKeys = [
    ...methodNames,
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
    foreignHandlers,
  );

  // Build executor for async methods
  const execute: CellExecuteFn | undefined = asyncMethods.size > 0
    ? buildMethodsExecutor(
      name,
      prefix,
      methods as Record<string, Method<Record<string, unknown>>>,
      asyncMethods,
      config,
      effectKeys,
      undefined,
    )
    : undefined;

  // Assemble internals — mirrored in cell-actions-factory.ts (CellAio type enforces field consistency)
  const internals: Omit<
    CellAio,
    | "actions"
    | "effects"
    | "selectors"
    | "bound"
    | "selectorDeps"
  > = {
    // The declared initial is the pristine source of truth: a frozen (dev)
    // deep clone, so it never aliases the caller's object and in-place
    // mutation throws at the site. See immutable.ts.
    state: freezeInitial(config.state) as Record<string, unknown>,
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
    // Cancellation triggers (perfect-aio D1) — DEF data; the runtime registry
    // is (re)built from this at compose time, so a runtime reset + fresh
    // compose (the testCell pattern) re-registers naturally.
    cancelTriggers: config.cancelOn as
      | Record<string, (string | { type: string })[]>
      | undefined,
    // Dropping these silently disables persist/ui filters, validation and
    // migrations for methods-style cells.
    validate: config.validate,
    persist: normalizePersistFilter(config.persist),
    ui: normalizeUiFilter(config.ui),
    uiForUser: extractForUser(config.ui),
    uiPublicFields: extractPublicFields(config.ui),
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

  // Build public catalog — methods (args-style) via the SHARED builder in
  // cell-catalog.ts so the callable shape (`.type` + `.action` self-ref)
  // can't drift (complexity audit).
  const publicCatalog: Record<string, unknown> = buildArgsCatalog(
    prefix,
    methodNames,
  );

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
