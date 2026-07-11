// cell-types.ts — shared types for the cell system
//
// Leaf module: no internal deps (only immer, schedule, flow, cell-impl types).
// Everything else in cell-* imports from here.

import type { ScheduleEffect } from "./schedule.ts";
import type { OwnEffect } from "./own.ts";
import type { FlowDef } from "./flow.ts";
import type { CellMethods } from "./cell-impl.ts";
import type { SyncConfig } from "../sync/types.ts";

/** Map of named action/effect creator functions */
export type Creators = Record<
  string,
  // deno-lint-ignore no-explicit-any
  (...args: any[]) => Record<string, unknown>
>;

/** Typed action catalog — maps method names to prefixed type strings and creator functions */
export type Catalog<Prefix extends string, T extends Creators> =
  & {
    readonly [K in keyof T & string]: `${Prefix}:${K}`;
  }
  & {
    readonly [K in keyof T & string]: {
      (
        ...args: Parameters<T[K]>
      ): { type: `${Prefix}:${K}`; payload: ReturnType<T[K]> };
      readonly type: `${Prefix}:${K}`;
    };
  };

/** Derive a concrete action-creator catalog from a methods map M — strips the
 *  leading state param, preserving each method's arg signature. Lets the
 *  methods-style cell() overload expose typed Actions (instead of `any`) so
 *  consumers like testCell's `t.send` get refactor-safe, non-optional senders. */
export type MethodsToCreators<M> = {
  [K in keyof M]: M[K] extends (
    // deno-lint-ignore no-explicit-any
    s: any,
    ...args: infer P
  ) => unknown ? (...args: P) => Record<string, unknown>
    : never;
};

/** Discriminated union of all actions — enables auto-narrowing in reduce switch/case.
 *  Foreign/internal actions (init, destroy, cross-cell): cast to Msg for raw access. */
export type ActionUnion<Prefix extends string, A extends Creators> = {
  [K in keyof A & string]: {
    type: `${Prefix}:${K}`;
    payload: ReturnType<A[K]>;
    _source?: ActionSource;
  };
}[keyof A & string];

/** Transition target — a state name, or a function deciding the target from
 *  state + action args (AIO-380). The function runs after the reducer applied
 *  (sync methods see post-method state; async method triggers run before the
 *  method body, so branch on args there). Return null/undefined to stay in the
 *  current state. Must be pure — a throwing/invalid guard logs and stays put. */
export type TransitionTarget<States extends string = string> =
  | States
  // deno-lint-ignore no-explicit-any
  | ((state: any, ...args: any[]) => States | null | undefined);

/** State machine definition — States generic enables autocomplete + compiler checks on state names.
 *  States is inferred from the keys of `states`; `initial` and transition targets are validated against it. */
export type MachineConfig<States extends string = string> = {
  initial: NoInfer<States>;
  states: Record<States, Record<string, TransitionTarget<NoInfer<States>>>>;
};

/** Action source — auto-tagged at dispatch time for logging/debugging */
export type ActionSource = "UI" | "Effect" | "System" | "Test";

/** Minimal user shape for forUser — avoids importing from aio.ts */
export type FilterUser = { id?: string; role?: string; [k: string]: unknown };

/** Shared filter type — used by both persist and ui cell config.
 *  K generic enables autocomplete on state field names when used as keyof S.
 *  `exclude` also accepts dot-paths ("accounts.encSecKey") — deep removal,
 *  arrays traversed element-wise. */
export type CellFieldFilter<K extends string = string> =
  | "all"
  | "none"
  | { include: K[] }
  | { exclude: (K | `${K}.${string}`)[] };

/** Cell-level UI visibility — CellFieldFilter + optional per-user transform.
 *
 *  One callback-bearing shape ON PURPOSE: a union with two `forUser` members
 *  (the old Pick/Omit-precise design) breaks TypeScript's contextual typing —
 *  `forUser: (s, user) => …` degraded to implicit-any and forced a manual
 *  annotation. `exposed` is typed as the full state; at runtime it only
 *  carries the fields the include/exclude filter kept. */
export type CellVisibility<
  K extends string = string,
  S extends Record<string, unknown> = Record<string, unknown>,
> = CellFieldFilter<K> | {
  /** Top-level allowlist — only these fields are exposed. */
  include?: K[];
  /** Fields to remove; dot-paths ("accounts.encSecKey") remove deeply. */
  exclude?: (K | `${K}.${string}`)[];
  /** Per-user transform of the (already filtered) exposed state. Runs per
   *  client per broadcast on a structuredClone — mutate freely. */
  forUser?: (
    exposed: S,
    user?: FilterUser,
  ) => Record<string, unknown>;
};

/** Action message — type + payload + optional source tag */
export type Msg<P = unknown> = {
  type: string;
  payload: P;
  _source?: ActionSource;
};

/** Scoped app handle passed to execute() — dispatch actions or read state from within a cell */
export type ScopedApp<S = unknown> = {
  dispatch: (action: Msg) => void;
  /** Returns this cell's own state slice */
  getState: () => S;
  /** Returns the full app state — use when init() needs to read another cell's state.
   *  Always available when called from init/destroy/execute in a running app. */
  getFullState?: () => Record<string, unknown>;
};

/** Tag a message with a source — non-destructive, returns new object */
export function tagSource<P = unknown>(
  msg: Msg<P>,
  source: ActionSource,
): Msg<P> {
  return { ...msg, _source: source };
}

/** Internal reducer function signature.
 *  ctx is injected by cell-compose-reduce ({A, E} catalogs) — factory-built reducers ignore it. */
export type CellReduceFn = (
  state: unknown,
  action: Msg,
  ctx?: Record<string, unknown>,
) => (Msg | ScheduleEffect | OwnEffect)[] | void;
/** Internal executor function signature */
export type CellExecuteFn = (app: ScopedApp, effect: Msg) => void;

/** Framework internals — all stored under cell.__aio, not for user code */
export type CellAio<
  Actions extends Creators = Creators,
  Effects extends Creators = Creators,
  State extends Record<string, unknown> = Record<string, unknown>,
> = {
  /** Initial state for this cell */
  state: State;
  /** State machine config (false = no machine) */
  machine: MachineConfig | false;
  /** Reducer function */
  reduce: CellReduceFn;
  /** Executor function (handles effects) */
  execute?: CellExecuteFn;
  /** Selector functions — receive (ownSlice, fullState?). Deps-form selectors
   *  use fullState to read other cells' current slices. */
  selectors: Record<string, (state: unknown, fullState?: unknown) => unknown>;
  /** Per-selector dep names — used by composeCellsWiring to validate against
   *  the known cell list at composition time. Keys mirror `selectors`. */
  selectorDeps: Record<string, readonly string[]>;
  /** Action creator catalog */
  actions: Catalog<string, Actions>;
  /** Effect creator catalog */
  effects: Catalog<string, Effects>;
  /** All action keys this cell handles */
  actionKeys: string[];
  /** All effect keys */
  effectKeys: string[];
  /** Cell unique identifier — used for state key, action prefix, logging */
  id: string;
  /** Reverse map: full action type string → camelCase key */
  actionTypeToKey: Map<string, string>;
  /** Foreign action types declared in machine (keys containing ':' from other prefixes) */
  foreignActions: string[];
  /** Init type string (e.g. 'counter:__init') */
  initType: string;
  /** Destroy type string (e.g. 'counter:__destroy') */
  destroyType: string;
  /** AIO-5.1: cell scope. `"client"` cells live in the browser only; their
   *  server-side def is a no-op. Defaults to `"server"` (i.e. normal). */
  scope: "client" | "server";
  /** AIO-5.1: raw sync methods of a client-scoped cell — bindCellReactive runs
   *  these locally against the cell signal (no server dispatch). */
  clientMethods?: Record<
    string,
    (s: Record<string, unknown>, ...args: unknown[]) => unknown
  >;
  /** Custom init handler — receives the app and the cell's initial state */
  onInit?: (app: ScopedApp<unknown>, initState?: unknown) => void;
  /** Custom destroy handler */
  onDestroy?: (app: ScopedApp<unknown>) => void;
  /** Generator-based flows */
  flows?: Record<string, FlowDef>;
  /** Map: trigger action key → flow name */
  flowTriggers?: Map<string, string>;
  /** Sync/async method implementations */
  methods?: CellMethods<Record<string, unknown>>;
  syncMethods?: Set<string>;
  asyncMethods?: Set<string>;
  /** Optional state validator — called after reduce, throw or return string to reject.
   *  `any` required: user provides (state: S) => ... but CellAio stores it unparameterized (contravariance). */
  // deno-lint-ignore no-explicit-any
  validate?: (state: any) => true | string;
  /** Persistence filter — matches user-facing `persist` config key */
  persist?: CellFieldFilter;
  /** UI visibility filter — matches user-facing `ui` config key */
  ui?: CellFieldFilter;
  /** Optional per-user UI transform — receives structuredClone of filtered state */
  uiForUser?: (
    exposed: Record<string, unknown>,
    user?: FilterUser,
  ) => Record<string, unknown>;
  /** CRDT sync configuration */
  syncConfig?: SyncConfig;
  /** State version — increment when state shape changes. Default: 0. */
  version: number;
  /** Migration hook — called when persisted version < current version.
   *  Receives old state (after deepMerge with defaults) and old version number.
   *  Must return the migrated state. */
  onMigrate?: (
    state: Record<string, unknown>,
    fromVersion: number,
  ) => Record<string, unknown>;
  /** Bind guard — true after bindCell() */
  bound: boolean;
  /** Phantom — carries State type for TypeScript inference (never set at runtime) */
  stateType?: State;
};

/** Reserved property names on CellDef — user-defined names must not collide */
export const RESERVED_KEYS = new Set(["A", "E", "__aio", "fx", "state"]);

/** Validate that user-defined keys don't collide with reserved CellDef properties.
 *  Throws with a clear explanation if collision found. */
export function checkReservedKeys(
  cellName: string,
  keys: string[],
  kind: string,
): void {
  for (const key of keys) {
    if (RESERVED_KEYS.has(key)) {
      throw new Error(
        `[cell:${cellName}] ${kind} "${key}" collides with reserved property — ` +
          `"${key}" is used internally by aio. Rename it (e.g. "${key}Data", "${key}Value", "get${
            key[0]!.toUpperCase()
          }${key.slice(1)}"). ` +
          `Reserved names: ${[...RESERVED_KEYS].join(", ")}`,
      );
    }
  }
}

/** Cell definition returned by cell() — public surface is methods/generators/selectors only.
 *  Framework internals live under __aio. */
export type CellDef<
  Name extends string = string,
  Actions extends Creators = Creators,
  Effects extends Creators = Creators,
  State extends Record<string, unknown> = Record<string, unknown>,
> = {
  /** @internal — framework plumbing, not for user code */
  readonly __aio: CellAio<Actions, Effects, State>;
  /** Public effect creator catalog — use in reduce: `return [cell.fx.persist(value)]` */
  // deno-lint-ignore no-explicit-any
  readonly fx?: Catalog<string, any>;
};

/** Flattened action senders — method names callable directly on the cell.
 *  Before aio.run(): returns action object. After binding: dispatches and returns void.
 *  Each has a `.type` property for use in waitFor/cancelOn/listensTo without raw strings.
 *  N prefix enables literal `.type` (e.g. `"counter:increment"` instead of `string`). */
export type FlatActions<
  N extends string = string,
  A extends Creators = Creators,
> = {
  [K in keyof A & string]:
    & ((
      ...args: Parameters<A[K]>
    ) => { type: `${N}:${K}`; payload: ReturnType<A[K]> })
    & { readonly type: `${N}:${K}` }
    & {
      /** Build the `{ type, payload }` action descriptor — pass to `schedule.*`,
       *  generators, `waitFor`, etc. Refactor-safe; survives bind. */
      readonly action: (
        ...args: Parameters<A[K]>
      ) => { type: `${N}:${K}`; payload: ReturnType<A[K]> };
    };
};

/** Direct calling type — maps method signatures to callable functions on the cell.
 *  After aio.run() and bindCell: sync methods return Promise<void> (dispatch complete);
 *  async methods return Promise<R> (method return value). The `.type` property is preserved
 *  for use in waitFor/cancelOn/listensTo. N prefix enables literal `.type`
 *  (e.g. `"counter:increment"` instead of `string`).
 *  Before aio.run(), calling a method throws in dev / warns-and-resolves in prod (see
 *  makeUnboundGuard). Internal callers that need the raw action object use
 *  `def.__aio.actions[key]` (the unwrapped catalog). */
export type DirectCalling<N extends string = string, M = unknown> = {
  [K in keyof M & string]: // deno-lint-ignore no-explicit-any
    M[K] extends (s: any, ...args: infer P) => Promise<infer R>
      ? ((...args: P) => Promise<R>) & MethodMeta<N, K, P>
      // deno-lint-ignore no-explicit-any
      : M[K] extends (s: any, ...args: infer P) => any
        ? ((...args: P) => Promise<void>) & MethodMeta<N, K, P>
      : never;
};

/** Public accessors attached to every bound method: the refactor-safe `.type`
 *  constant and `.action(...args)` descriptor builder (`{ type, payload }`).
 *  Method payloads carry `{ args }` — the shape `schedule.*` re-dispatches. */
export type MethodMeta<
  N extends string,
  K extends string,
  P extends unknown[],
> =
  & { readonly type: `${N}:${K}` }
  & {
    readonly action: (
      ...args: P
    ) => { type: `${N}:${K}`; payload: { args: P } };
  };

/** Extract the state type from a CellDef — useful for typing selectors and external consumers. */
// deno-lint-ignore no-explicit-any
export type ExtractState<F> = F extends CellDef<any, any, any, infer S> ? S
  : Record<string, unknown>;

/** Alias for ExtractState — `StateOf<typeof counter>` reads naturally in app code. */
// deno-lint-ignore no-explicit-any
export type StateOf<F> = F extends CellDef<any, any, any, infer S> ? S
  : Record<string, unknown>;

/**
 * Build a typed send proxy from raw methods M (before DirectCalling transform).
 * Re-strips the state param and returns void (send dispatches, doesn't return).
 */
// deno-lint-ignore no-explicit-any
export type SendOf<F> = F extends DirectCalling<any, infer M> ? {
    [K in keyof M]: // deno-lint-ignore no-explicit-any
      M[K] extends (s: any, ...args: infer P) => Promise<any>
        ? (...args: P) => void
        // deno-lint-ignore no-explicit-any
        : M[K] extends (s: any, ...args: infer P) => any ? (...args: P) => void
        : never;
  }
  : Record<string, (...args: unknown[]) => void>;

/** Cell entry in aio.run() — a bare CellDef or an object with dependency declarations. */
export type CellEntry = CellDef | {
  cell: CellDef;
  dependsOn?: string[];
};
