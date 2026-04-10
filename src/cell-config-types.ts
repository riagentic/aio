// cell-config-types.ts — exported config type definitions for cell()

import type { Draft } from "immer";
import type { Gen, GenCtx } from "./flow.ts";
import type { ScheduleEffect } from "./schedule.ts";
import type { Method } from "./cell-impl.ts";
import type {
  ActionUnion,
  CellFieldFilter,
  CellVisibility,
  Creators,
  MachineConfig,
  Msg,
  ScopedApp,
} from "./cell-types.ts";
import type { SyncConfig } from "./sync/types.ts";

/** Generator function — pass through cancel() to attach cancelOn triggers.
 *  Uses `any` for rest args so typed signatures (e.g. `{ n: number }`) are assignable. */
export type GeneratorEntry =
  // deno-lint-ignore no-explicit-any
  & ((ctx: GenCtx<any>, ...args: any[]) => Gen<unknown>)
  & {
    cancelOn?: string[];
  };

/** Methods-based config (reactive style) */
export type MethodsCellConfig<
  N extends string,
  S extends Record<string, unknown>,
  M extends Record<string, Method<S>> = Record<string, Method<S>>,
  States extends string = string,
> = {
  state: S;
  methods: M;
  /** Generator functions — sequential async workflows, auto-triggered by dispatching their action. */
  // deno-lint-ignore no-explicit-any
  generators?: Record<string, (ctx: GenCtx<S>, ...args: any[]) => Gen<unknown>>;
  /** Cancellation triggers per generator — { generatorKey: [actionsOrTypes] }.
   *  Accepts bound action creators (.type) or plain strings. */
  cancelOn?: Record<string, (string | { type: string })[]>;
  selectors?: Record<string, (s: S) => unknown>;
  machine?: MachineConfig<States> | false;
  /** Listen to foreign actions — auto-generates machine transitions.
   *  Accept strings or bound methods/actions with .type (e.g. `inventory.reserve.type`). */
  listensTo?: (string | { type: string })[];
  /** Explicit actions — typed creators with custom payloads (mixed mode). Names must not collide with methods. */
  // deno-lint-ignore no-explicit-any
  actions?: Record<string, (...args: any[]) => Record<string, unknown>>;
  // deno-lint-ignore no-explicit-any
  effects?: Record<string, (...args: any[]) => Record<string, unknown>>;
  /** Reduce handlers for explicit actions (mixed mode). Each key matches an action key. */
  // deno-lint-ignore no-explicit-any
  reduce?: Record<string, (state: Draft<S>, payload: any) => void | any[]>;
  /** Object form (default): named handlers per effect key.
   *  Function form (advanced): receives full effect + { emit } map of type strings. */
  execute?:
    | ExecuteHandlers<S, Record<string, never>>
    | ((
      app: ScopedApp<S>,
      effect: Msg,
      ctx: { emit: Record<string, unknown> },
    ) => void);
  /** Optional state validator — called after every reduce. Return true to accept, or a string error message to reject. */
  validate?: (state: S) => true | string;
  /** Persistence filter — "all" persists everything, "none" (default) persists nothing.
   *  { include: [...] } or { exclude: [...] } for field-level control. */
  persist?: CellFieldFilter<keyof S & string>;
  /** UI visibility — "all" exposes everything, "none" (default) hides cell from clients.
   *  { include: [...] } or { exclude: [...] } for field-level control.
   *  Add forUser for per-user filtering on the already-filtered state. */
  ui?: CellVisibility<keyof S & string, S>;
  /** CRDT sync — true for defaults, or partial config to override merge strategies, identity keys, retention */
  sync?: true | Partial<SyncConfig>;
  /** State version — increment when state shape changes. Default: 0. */
  version?: number;
  /** Migration hook — called when persisted version < current version.
   *  Receives old state (after deepMerge with defaults) and old version number.
   *  Must return the migrated state. */
  onMigrate?: (state: S, fromVersion: number) => S;
  onInit?: (app: ScopedApp<S>) => void;
  onDestroy?: (app: ScopedApp<S>) => void;
};

/** Object-form reduce handlers — each key matches an action key, receives typed payload.
 *  Own-cell keys infer payload from action creator; foreign/computed keys get any (no cast needed). */
export type ReduceHandlers<S, A extends Creators> =
  & Partial<
    {
      [K in keyof A]: (state: Draft<S>, payload: ReturnType<A[K]>) => void;
    }
  >
  // deno-lint-ignore no-explicit-any
  & Record<string, (state: Draft<S>, payload: any) => void>;

/** Object-form execute handlers — each key matches an effect key, receives typed payload. */
export type ExecuteHandlers<S, E extends Creators> =
  & Partial<
    {
      [K in keyof E]: (
        app: ScopedApp<S>,
        payload: ReturnType<E[K]>,
      ) => void | Promise<void>;
    }
  >
  // deno-lint-ignore no-explicit-any
  & Record<string, (app: ScopedApp<S>, payload: any) => void | Promise<void>>;

/** Actions-based config (explicit style) */
export type ActionsCellConfig<
  N extends string,
  S extends Record<string, unknown>,
  A extends Creators,
  E extends Creators,
  States extends string = string,
> = {
  state: S;
  actions: A;
  effects?: E;
  machine?: MachineConfig<States> | false;
  /** Object form (default): named handlers per action key — receives typed payload.
   *  Function form (advanced escape hatch): receives full action + { on } map of type strings. */
  reduce?:
    | ReduceHandlers<S, A>
    | ((
      state: Draft<S>,
      action: ActionUnion<N, A>,
      ctx: { on: Record<string, string> },
    ) => (Msg | ScheduleEffect)[] | void);
  /** Object form (default): named handlers per effect key — receives typed payload.
   *  Function form (advanced escape hatch): receives full effect + { emit } map of type strings. */
  execute?:
    | ExecuteHandlers<S, E>
    | ((
      app: ScopedApp<S>,
      effect: Msg,
      ctx: { emit: Record<string, string> },
    ) => void);
  selectors?: Record<string, (s: S) => unknown>;
  /** Generator functions keyed by their trigger action — action key must be in `actions`. */
  // deno-lint-ignore no-explicit-any
  generators?: Record<string, (ctx: GenCtx<S>, ...args: any[]) => Gen<unknown>>;
  /** Cancellation triggers per generator — { generatorKey: [actionsOrTypes] }.
   *  Accepts bound action creators (.type) or plain strings. */
  cancelOn?: Record<string, (string | { type: string })[]>;
  /** Optional state validator — called after every reduce. Return true to accept, or a string error message to reject. */
  validate?: (state: S) => true | string;
  /** Persistence filter — "all" persists everything, "none" (default) persists nothing.
   *  { include: [...] } or { exclude: [...] } for field-level control. */
  persist?: CellFieldFilter<keyof S & string>;
  /** UI visibility — "all" exposes everything, "none" (default) hides cell from clients.
   *  { include: [...] } or { exclude: [...] } for field-level control.
   *  Add forUser for per-user filtering on the already-filtered state. */
  ui?: CellVisibility<keyof S & string, S>;
  /** CRDT sync — true for defaults, or partial config to override merge strategies, identity keys, retention */
  sync?: true | Partial<SyncConfig>;
  /** State version — increment when state shape changes. Default: 0. */
  version?: number;
  /** Migration hook — called when persisted version < current version.
   *  Receives old state (after deepMerge with defaults) and old version number.
   *  Must return the migrated state. */
  onMigrate?: (state: S, fromVersion: number) => S;
  onInit?: (app: ScopedApp<S>) => void;
  onDestroy?: (app: ScopedApp<S>) => void;
};
