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
  resolveVisibility,
  scopeSelectors,
  validateFieldFilters,
} from "./cell-helpers.ts";
import {
  buildMethodsExecutor,
  buildMethodsMachine,
  buildMethodsReducer,
} from "./cell-methods-internals.ts";
import { resolveSelfAction } from "./self.ts";
import { log } from "../diagnostics/logger.ts";

/** One-time-per-cell hint for the deprecated listensTo ARRAY form. */
const _listensToHinted = new Set<string>();
/** @internal test seam. */
export function _resetListensToHints(): void {
  _listensToHinted.clear();
}

/** @internal test seam. Retained as a no-op: the alpha52 transaction-default
 *  hint it reset is gone with the flip it announced (alpha57). */
export function _resetTransactionHints(): void {}
function hintListensToArray(name: string): void {
  if (_listensToHinted.has(name)) return;
  _listensToHinted.add(name);
  log.warn(
    "cell",
    `[cell:${name}] listensTo array form is deprecated — it routes the ` +
      `action without running any code. Use the object form, which names the ` +
      `sync method that reacts: listensTo: { onThing: other.method } (values ` +
      `may be arrays for multiple sources). (hinted once per cell)`,
  );
}

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

  // alpha52: state keys are validated too. The `$` prefix is the method draft
  // meta-namespace ($signal/$commit/$live/$do) — a state key there would be
  // shadowed by the interception on every read inside a method, silently.
  const stateKeyList = Object.keys(config.state ?? {});
  for (const key of stateKeyList) {
    if (key.startsWith("$")) {
      throw new Error(
        `[cell:${name}] state key '${key}' starts with '$' — the $-prefix is ` +
          `reserved for method draft meta ($signal, $commit, $live, $do), so ` +
          `this field would be shadowed inside methods. Rename it (e.g. ` +
          `'${key.slice(1) || "value"}').`,
      );
    }
  }
  checkReservedKeys(name, stateKeyList, "state key");

  // AUTH-1 footgun guard: `access` is boolean | role-string | predicate, so a
  // string is read as a ROLE NAME. `access: "none"` would silently grant only
  // the (nonexistent) role "none" — the opposite of the intended "deny". The
  // words that look like sentinels are almost always a mistake; fail loud with
  // the fix. (Unlike ui/persist, access has no "all"/"none" filter vocabulary.)
  if (typeof config.access === "string") {
    const reserved = new Set([
      "none",
      "all",
      "true",
      "false",
      "public",
      "private",
      "any",
    ]);
    if (reserved.has(config.access.toLowerCase())) {
      throw new Error(
        `cell("${name}"): access: "${config.access}" is read as a ROLE name, ` +
          `not a sentinel. Use access: true (any authenticated user), ` +
          `access: false (no client may CALL its methods), or a real role ` +
          `like access: "admin". Note access gates method calls only — to ` +
          `hide the cell's STATE from clients use visible ` +
          `("none"/exclude/forUser).`,
      );
    }
  }

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

  // `visible:` is the key; `ui:` the deprecated alias (alpha52 — one decider,
  // both-set throws, one-time hint). Resolve ONCE, up front.
  const visibility = resolveVisibility(name, config);

  // Field-filter keys must resolve to real state — a non-matching filter
  // silently leaks. Fail loud at creation.
  validateFieldFilters(
    name,
    config.state as Record<string, unknown>,
    visibility,
    config.persist,
  );

  // listensTo (D1): normalize both forms. Object form maps ONE OR MORE foreign
  // action types → a SYNC method that handles them (alpha52: values may be
  // arrays — `{ onX: [a.m, b.m] }`). The array form is deprecated (it only
  // routes, running no code — the thing people always expected it to do): it
  // keeps working through beta with a one-time hint.
  const foreignHandlers = new Map<string, string>();
  const listensToTriggers: (string | { type: string })[] = [];
  if (config.listensTo) {
    if (Array.isArray(config.listensTo)) {
      hintListensToArray(name);
      listensToTriggers.push(...config.listensTo);
    } else {
      for (const [methodKey, trigger] of Object.entries(config.listensTo)) {
        const triggers = Array.isArray(trigger) ? trigger : [trigger];
        for (const tr of triggers) {
          const t = typeof tr === "string" ? tr : tr.type;
          if (!methods[methodKey]) {
            throw new Error(
              `[cell:${name}] listensTo: { ${methodKey}: "${t}" } — no method ` +
                `named '${methodKey}'. The object form maps an EXISTING sync ` +
                `method to the foreign action(s) that trigger it.`,
            );
          }
          foreignHandlers.set(t, methodKey);
          listensToTriggers.push(t);
        }
      }
    }
  }

  // Classify methods as sync or async (uses isAsyncFunction — symbol-based, minification-safe)
  const { syncMethods, asyncMethods } = classifyMethods(
    methods as CellMethods<Record<string, unknown>>,
  );

  // (alpha57 removed the transaction-default hint that used to live here: with
  // `transaction` opt-in again, a cell that never declared it gets exactly the
  // behavior it was written against, so there is nothing to warn about.)
  for (const [t, mk] of foreignHandlers) {
    if (asyncMethods.has(mk)) {
      throw new Error(
        `[cell:${name}] listensTo handler '${mk}' (for "${t}") must be a ` +
          `SYNC method — reactions run inside the reduce; do async work by ` +
          `having '${mk}' set state that an async method awaits on.`,
      );
    }
  }

  // cancelOn names a method that must exist and must be async — a typo, or a
  // sync method, silently bought you a cell that could never be cancelled
  // (the registry just held a key nothing ever tracked). Fail at cell() time,
  // where the fix is one line away.
  for (const mk of Object.keys(config.cancelOn ?? {})) {
    if (asyncMethods.has(mk)) continue;
    throw new Error(
      methodNames.includes(mk)
        ? `[cell:${name}] cancelOn: '${mk}' is a SYNC method — there is ` +
          `nothing in flight to cancel. Only async methods take a cancelOn.`
        : `[cell:${name}] cancelOn: no method '${mk}'. Known async methods: ` +
          `${[...asyncMethods].join(", ") || "(none)"}.`,
    );
  }
  // alpha52: cancelOn triggers may be self("method") descriptors — the one
  // place a self-reference is STATICALLY present, so an unknown method throws
  // right here, at cell() definition.
  let cancelTriggers = config.cancelOn as
    | Record<string, "self" | (string | { type: string })[]>
    | undefined;
  if (cancelTriggers) {
    const resolved: typeof cancelTriggers = {};
    for (const [mk, trig] of Object.entries(cancelTriggers)) {
      resolved[mk] = trig === "self"
        ? trig
        : trig.map((t) =>
          typeof t === "string" ? t : resolveSelfAction(
            t as { type: string },
            name,
            (m) => typeof methods[m] === "function",
            () => methodNames,
          )
        );
    }
    cancelTriggers = resolved;
  }

  // `onMigrate` with no `version >= 1` is a DEAD hook: boot skips migration
  // entirely at version 0 (the default), so the migration the developer wrote
  // would silently never run — against every persisted profile. Fail at
  // cell() time, where the fix is one line away.
  if (
    config.onMigrate !== undefined &&
    (config.version === undefined || config.version < 1)
  ) {
    throw new Error(
      `[cell:${name}] onMigrate is declared but version is ${
        config.version === undefined ? "unset" : String(config.version)
      } — migrations only run when version >= 1 (persisted vN < version), ` +
        `so this hook would never fire. Add \`version: 1\` (and bump it on ` +
        `every state-shape change).`,
    );
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
    // compose (the testCell pattern) re-registers naturally. self()
    // descriptors are already resolved (above).
    cancelTriggers: cancelTriggers,
    // Dropping these silently disables persist/ui filters, validation and
    // migrations for methods-style cells.
    validate: config.validate,
    access: config.access,
    persist: normalizePersistFilter(config.persist),
    ui: normalizeUiFilter(visibility),
    uiForUser: extractForUser(visibility),
    uiPublicFields: extractPublicFields(visibility),
    syncConfig: config.sync ? normalizeSyncConfig(config.sync) : undefined,
    // `sync: false` is a DECISION, not the absence of one — under localFirst it
    // is the only thing standing between a cell and optimistic local execution,
    // so it has to survive as more than a falsy value.
    syncOptOut: config.sync === false,
    worker: config.worker === true,
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
