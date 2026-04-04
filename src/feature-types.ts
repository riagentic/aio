// feature-types.ts — shared types for the feature system
//
// Leaf module: no internal deps (only immer, schedule, flow, feature-impl types).
// Everything else in feature-* imports from here.

import type { ScheduleEffect } from "./schedule.ts";
import type { FlowDef } from "./flow.ts";
import type { FeatureMethods } from "./feature-impl.ts";
import type { SyncConfig } from "./sync/types.ts";

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

/** Discriminated union of all actions — enables auto-narrowing in reduce switch/case.
 *  Foreign/internal actions (init, destroy, cross-feature): cast to Msg for raw access. */
export type ActionUnion<Prefix extends string, A extends Creators> = {
  [K in keyof A & string]: {
    type: `${Prefix}:${K}`;
    payload: ReturnType<A[K]>;
    _source?: ActionSource;
  };
}[keyof A & string];

/** State machine definition */
export type MachineConfig = {
  initial: string;
  states: Record<string, Record<string, string>>;
};

/** Action source — auto-tagged at dispatch time for logging/debugging */
export type ActionSource = "UI" | "Effect" | "System" | "Test";

/** Action message — type + payload + optional source tag */
export type Msg<P = unknown> = {
  type: string;
  payload: P;
  _source?: ActionSource;
};

/** Scoped app handle passed to execute() — dispatch actions or read state from within a feature */
export type ScopedApp<S = unknown> = {
  dispatch: (action: Msg) => void;
  /** Returns this feature's own state slice */
  getState: () => S;
  /** Returns the full app state — use when init() needs to read another feature's state.
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

/** Internal reducer function signature */
export type FeatureReduceFn = (
  state: unknown,
  action: Msg,
  // deno-lint-ignore no-explicit-any
  ctx?: any,
) => (Msg | ScheduleEffect)[] | void;
/** Internal executor function signature */
// deno-lint-ignore no-explicit-any
export type FeatureExecuteFn = (app: ScopedApp, effect: Msg, ctx?: any) => void;

/** Framework internals — all stored under feature.__aio, not for user code */
export type FeatureAio<
  // deno-lint-ignore no-explicit-any
  Actions extends Creators = any,
  // deno-lint-ignore no-explicit-any
  Effects extends Creators = any,
  State extends Record<string, unknown> = Record<string, unknown>,
> = {
  /** Initial state for this feature */
  state: State;
  /** State machine config (false = no machine) */
  machine: MachineConfig | false;
  /** Reducer function */
  reduce: FeatureReduceFn;
  /** Executor function (handles effects) */
  execute?: FeatureExecuteFn;
  /** Selector functions */
  selectors: Record<string, (state: unknown) => unknown>;
  /** Action creator catalog */
  actions: Catalog<string, Actions>;
  /** Effect creator catalog */
  effects: Catalog<string, Effects>;
  /** All action keys this feature handles */
  actionKeys: string[];
  /** All effect keys */
  effectKeys: string[];
  /** Feature unique identifier — used for state key, action prefix, logging */
  id: string;
  /** Reverse map: full action type string → camelCase key */
  actionTypeToKey: Map<string, string>;
  /** Foreign action types declared in machine (keys containing ':' from other prefixes) */
  foreignActions: string[];
  /** Init type string (e.g. 'counter:__init') */
  initType: string;
  /** Destroy type string (e.g. 'counter:__destroy') */
  destroyType: string;
  /** Prefixes this executor is allowed to cross-dispatch to */
  crossDispatchPrefixes: Set<string>;
  /** Custom init handler */
  onInit?: (app: ScopedApp<unknown>) => void;
  /** Custom destroy handler */
  onDestroy?: (app: ScopedApp<unknown>) => void;
  /** Generator-based flows */
  flows?: Record<string, FlowDef>;
  /** Map: trigger action key → flow name */
  flowTriggers?: Map<string, string>;
  /** Sync/async method implementations */
  methods?: FeatureMethods<Record<string, unknown>>;
  syncMethods?: Set<string>;
  asyncMethods?: Set<string>;
  /** Optional state validator — called after reduce, throw or return string to reject */
  // deno-lint-ignore no-explicit-any
  validate?: (state: any) => true | string;
  /** State keys to exclude from KV persistence */
  persistExclude?: string[];
  /** CRDT sync configuration */
  syncConfig?: SyncConfig;
  /** Bind guard — true after bindFeature() */
  bound: boolean;
  /** Phantom — carries State type for TypeScript inference (never set at runtime) */
  stateType?: State;
};

/** Reserved property names on FeatureDef — user-defined names must not collide */
export const RESERVED_KEYS = new Set(["A", "E", "__aio", "state"]);

/** Validate that user-defined keys don't collide with reserved FeatureDef properties.
 *  Throws with a clear explanation if collision found. */
export function checkReservedKeys(
  featureName: string,
  keys: string[],
  kind: string,
): void {
  for (const key of keys) {
    if (RESERVED_KEYS.has(key)) {
      throw new Error(
        `[feature:${featureName}] ${kind} "${key}" collides with reserved property — ` +
          `"${key}" is used internally by aio. Rename it (e.g. "${key}Data", "${key}Value", "get${
            key[0]!.toUpperCase()
          }${key.slice(1)}"). ` +
          `Reserved names: ${[...RESERVED_KEYS].join(", ")}`,
      );
    }
  }
}

/** Feature definition returned by feature() — public surface is methods/generators/selectors only.
 *  Framework internals live under __aio. */
export type FeatureDef<
  Name extends string = string,
  // deno-lint-ignore no-explicit-any
  Actions extends Creators = any,
  // deno-lint-ignore no-explicit-any
  Effects extends Creators = any,
  State extends Record<string, unknown> = Record<string, unknown>,
> = {
  /** @internal — framework plumbing, not for user code */
  readonly __aio: FeatureAio<Actions, Effects, State>;
};

/** Flattened action senders — method names callable directly on the feature.
 *  Before aio.run(): returns action object. After binding: dispatches and returns void.
 *  Each has a `.type` property for use in waitFor/cancelOn/listensTo without raw strings. */
export type FlatActions<A extends Creators> = {
  [K in keyof A & string]:
    & ((
      ...args: Parameters<A[K]>
    ) => { type: string; payload: ReturnType<A[K]> })
    & { readonly type: string };
};

/** Direct calling type — maps method signatures to callable functions on the feature.
 *  Before aio.run(): returns action object. After binding: dispatches (sync) or returns Promise (async).
 *  Each has a `.type` property for use in waitFor/cancelOn/listensTo. */
export type DirectCalling<M> = {
  // deno-lint-ignore no-explicit-any
  [K in keyof M]: M[K] extends (s: any, ...args: infer P) => Promise<infer R>
    ? ((...args: P) => Promise<R>) & { readonly type: string }
    // deno-lint-ignore no-explicit-any
    : M[K] extends (s: any, ...args: infer P) => any
      ? ((...args: P) => { type: string; payload: unknown }) & {
        readonly type: string;
      }
    : never;
};

/** Extract the state type from a FeatureDef — useful for typing selectors and external consumers. */
// deno-lint-ignore no-explicit-any
export type ExtractState<F> = F extends FeatureDef<any, any, any, infer S> ? S
  : Record<string, unknown>;

/**
 * Build a typed send proxy from raw methods M (before DirectCalling transform).
 * Re-strips the state param and returns void (send dispatches, doesn't return).
 */
export type SendOf<F> = F extends DirectCalling<infer M> ? {
    // deno-lint-ignore no-explicit-any
    [K in keyof M]: M[K] extends (s: any, ...args: infer P) => Promise<any>
      ? (...args: P) => void
      // deno-lint-ignore no-explicit-any
      : M[K] extends (s: any, ...args: infer P) => any ? (...args: P) => void
      : never;
  }
  : Record<string, (...args: unknown[]) => void>;

/** Feature entry in aio.run() — a bare FeatureDef or an object with dependency declarations. */
// deno-lint-ignore no-explicit-any
export type FeatureEntry = FeatureDef<any, any, any, any> | {
  // deno-lint-ignore no-explicit-any
  feature: FeatureDef<any, any, any, any>;
  dependsOn?: string[];
};
