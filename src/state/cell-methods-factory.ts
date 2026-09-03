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
import { refuseRetired, removalOf } from "./removals-core.ts";

/** @internal test seam. Retained as a no-op: the alpha52 transaction-default
 *  hint it reset is gone with the flip it announced (alpha57). */
export function _resetTransactionHints(): void {}

export function createCellFromMethods<
  N extends string,
  S extends Record<string, unknown>,
  M extends Record<string, Method<S>> = Record<string, Method<S>>,
>(
  name: N,
  config: MethodsCellConfig<N, S, M>,
  /** The cell's scope, decided by the CALLER. It used to be hard-set to
   *  `"server"` here and patched back to `"client"` at one of the two call
   *  sites — so the invariant was momentarily false, and a third caller
   *  forgetting the patch would have produced a silently server-scoped client
   *  cell that the type system cannot catch (both spellings are valid). */
  scope: "server" | "client" = "server",
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

  // …and their VALUES, which nothing looked at. A typo'd or missing import
  // leaves `undefined` behind: that used to surface from cell() as "Cannot
  // read properties of undefined (reading 'Symbol(aio.async)')", naming an
  // internal symbol instead of the method. A non-function that is not
  // undefined was worse — cell() ACCEPTED it, the app booted, and the first
  // call threw "fn is not a function" under a hint that said to check the
  // action payload, which was never the problem.
  for (const key of methodNames) {
    const m = (methods as Record<string, unknown>)[key];
    if (typeof m !== "function") {
      throw new Error(
        `[cell:${name}] method '${key}' is ${
          m === undefined ? "undefined" : `${typeof m} ${JSON.stringify(m)}`
        }, not a function. The usual cause is a typo'd or missing import — ` +
          `check the name you passed for '${key}'.`,
      );
    }
  }
  // A selector is a function, or the deps form { deps: [...], fn } — both are
  // valid spellings and both are accepted here.
  const selectorDefs = (config.selectors ?? {}) as Record<string, unknown>;
  for (const key of selectorNames) {
    const sel = selectorDefs[key];
    const depsForm = sel !== null && typeof sel === "object" &&
      Array.isArray((sel as { deps?: unknown }).deps) &&
      typeof (sel as { fn?: unknown }).fn === "function";
    if (typeof sel !== "function" && !depsForm) {
      throw new Error(
        `[cell:${name}] selector '${key}' is ${
          sel === undefined ? "undefined" : typeof sel
        }, not a function or a { deps, fn } object. The usual cause is a ` +
          `typo'd or missing import — check the name you passed for '${key}'.`,
      );
    }
  }

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
  // arrays — `{ onX: [a.m, b.m] }`). The array form (route the action,
  // run no code) was removed in alpha70: it is config, so it takes the
  // registry's dev/prod split — dev throws, prod logs and still routes
  // (src/state/removals.ts).
  const foreignHandlers = new Map<string, string>();
  const listensToTriggers: (string | { type: string })[] = [];
  if (config.listensTo) {
    if (Array.isArray(config.listensTo)) {
      refuseRetired(removalOf("listensTo: [...]"), `cell:${name}`);
      listensToTriggers.push(...config.listensTo);
    } else {
      for (const [methodKey, trigger] of Object.entries(config.listensTo)) {
        const triggers = Array.isArray(trigger) ? trigger : [trigger];
        for (const tr of triggers) {
          const t = typeof tr === "string"
            ? tr
            : (tr as { type?: unknown } | null | undefined)?.type;
          if (typeof t !== "string" || !t) {
            throw new Error(
              `[cell:${name}] listensTo: { ${methodKey}: … } — the trigger is ` +
                `${
                  tr === undefined
                    ? "undefined"
                    : `${typeof tr} ${JSON.stringify(tr)}`
                }, not an action. The usual cause is a typo'd or missing ` +
                `import — pass the action itself (e.g. cart.clear) or its ` +
                `type string ("cart:clear").`,
            );
          }
          if (!methods[methodKey]) {
            throw new Error(
              `[cell:${name}] listensTo: { ${methodKey}: "${t}" } — no method ` +
                `named '${methodKey}'. The object form maps an EXISTING sync ` +
                `method to the foreign action(s) that trigger it.`,
            );
          }
          // One trigger, one handler — the reducer looks up exactly one key,
          // so a second mapping for the same foreign action silently REPLACED
          // the first and that method simply never ran. Every other mistake in
          // this block throws (unknown method, async handler, bad cancelOn);
          // this one used to be the quiet exception.
          const prior = foreignHandlers.get(t);
          if (prior !== undefined && prior !== methodKey) {
            throw new Error(
              `[cell:${name}] listensTo: '${t}' is mapped to both ` +
                `'${prior}' and '${methodKey}'. One foreign action triggers ` +
                `ONE method here — only the last would ever run. Merge them ` +
                `into a single method, or have that method call the other.`,
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
  // `long` is the same check for the same reason: the fact that a method takes
  // hours is a property OF THE METHOD, and it used to be declared in another
  // file as `perfBudget.methods["cell:method"].timeout`, keyed by a string no
  // refactor follows. A field report added six entries to that map one runtime
  // failure at a time ("nothing warned me; I would have found out from a
  // user"). Declared here, a typo throws at cell() time and a rename is a
  // rename.
  const longMethods = [...new Set(config.long ?? [])] as string[];
  for (const mk of longMethods) {
    if (asyncMethods.has(mk)) continue;
    throw new Error(
      methodNames.includes(mk)
        ? `[cell:${name}] long: '${mk}' is a SYNC method — it holds the ` +
          `reduce and cannot outlive a call ceiling that only bounds AWAITED ` +
          `work. Only async methods can be long.`
        : `[cell:${name}] long: no method '${mk}'. Known async methods: ` +
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
    scope,
    asyncMethods,
    // Cancellation triggers (perfect-aio D1) — DEF data; the runtime registry
    // is (re)built from this at compose time, so a runtime reset + fresh
    // compose (the testCell pattern) re-registers naturally. self()
    // descriptors are already resolved (above).
    cancelTriggers: cancelTriggers,
    // Async methods with no time ceiling, by name. Consumed at compose time
    // (the caller-side wait) and at boot (the effect tracker) from this ONE
    // declaration — see `longMethodKeys` / `mergeLongIntoPerfBudget`.
    longMethods: longMethods.length > 0 ? longMethods : undefined,
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
    onRestore: config.onRestore as
      | ((state: Record<string, unknown>) => Record<string, unknown> | void)
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
    __aio: guardAioInternals({
      ...internals,
      selectors,
      selectorDeps,
      actions: publicCatalog,
      effects: eCatalog,
      bound: false,
    }),
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

/** Every slot `CellAio` declares — the ONLY names a `__aio` read may resolve.
 *  Kept next to the assembly so a new slot is added in one place (a slot that
 *  is typed but not listed here throws under the harness on first read, which
 *  is the point: the list cannot drift silently). */
const CELL_AIO_KEYS: ReadonlySet<string> = new Set([
  "state",
  "machine",
  "reduce",
  "execute",
  "selectors",
  "selectorDeps",
  "actions",
  "effects",
  "actionKeys",
  "effectKeys",
  "id",
  "actionTypeToKey",
  "foreignActions",
  "initType",
  "destroyType",
  "scope",
  "clientMethods",
  "onInit",
  "onDestroy",
  "asyncMethods",
  "cancelTriggers",
  "longMethods",
  "validate",
  "persist",
  "access",
  "ui",
  "uiForUser",
  "uiPublicFields",
  "syncConfig",
  "syncOptOut",
  "enableSync",
  "worker",
  "version",
  "onMigrate",
  "onRestore",
  "bound",
  "stateType",
  "cellName",
  "keys",
  "kind",
]);

/** Names any object is asked for by the platform (await, JSON, inspect) —
 *  never a phantom API. */
const PLATFORM_PROBES: ReadonlySet<string> = new Set([
  "then",
  "toJSON",
  "constructor",
  "valueOf",
  "toString",
  "inspect",
  "$$typeof",
  "prototype",
  "__proto__",
]);

/** Framework-side reads of names `CellAio` does not declare. EMPTY on
 *  purpose: the two that existed (`sync`, `methodKeys` in src/server/aio.ts)
 *  were bugs the gate found (field report §4.2) and are fixed at the site. Add a
 *  name here only with the file:line that needs it — deleting the entry is
 *  the whole fix once that site is corrected. */
const FRAMEWORK_PHANTOM_READS: ReadonlySet<string> = new Set([]);

/** Wrap `cell.__aio` so a PHANTOM read fails loud under the harness.
 *
 *  A `methods` slot on `__aio` never existed, but it was typed, so reaching for it
 *  returned `undefined` — and the natural `if (typeof fn === "function")`
 *  guard around it made a test pass while asserting nothing (two sat green
 *  that way in one field report, field report §4.2). A read of a name `CellAio`
 *  does not declare now THROWS in dev/test, naming the supported path.
 *
 *  Prod: the same Proxy answers exactly like the plain object (unknown →
 *  `undefined`), so the only difference is that dev/test throws where prod
 *  stays quiet — category (b), dev stricter, never the reverse. Writes pass
 *  through untouched (`bound = true`, the browser stub's `enableSync`, …); the
 *  decision is made at READ time because cells are defined at module load,
 *  before any harness has armed `__aioDev`. */
function guardAioInternals<T extends object>(aio: T): T {
  return new Proxy(aio, {
    get(target, key, receiver) {
      if (
        typeof key === "symbol" || key in target || CELL_AIO_KEYS.has(key) ||
        PLATFORM_PROBES.has(key) || FRAMEWORK_PHANTOM_READS.has(key)
      ) return Reflect.get(target, key, receiver);
      if ((globalThis as Record<string, unknown>).__aioDev === true) {
        const id = String((target as { id?: unknown }).id ?? "?");
        throw new Error(
          `[cell:${id}] __aio.${key} does not exist — drive methods with ` +
            `testCell/testUI (docs/testing/ui-testing.md)`,
        );
      }
      return undefined;
    },
  });
}
