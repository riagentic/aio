/**
 * @module
 * aio/extras — the periphery (perfect-aio D5/B4c).
 *
 * Everything here is fully supported, just not core: escape hatches, niche
 * runtime helpers, and deep diagnostic detail types that no small app needs
 * on day one. The main `aio` entry stays the ~measured-core surface people
 * actually reach for; this entry keeps the rest one import away.
 *
 * ```ts
 * import { deepFreeze, instances, parseCli } from "aio/extras";
 * ```
 */
import { type Draft, produce } from "immer";

/** Validate cell defs without booting — `lint(cells)` returns findings. */
export { lint, parseCli } from "../server/aio.ts";
export type { CliFlags, Lint } from "../server/aio.ts";

/** Unix-domain-socket variant of connectCli — same-box CLI without TCP. */
export { connectCliUDS } from "../server/cli-client.ts";

/** Single-instance lock introspection — list running apps, normalize IDs. */
export { instances, resolveAppId } from "../server/single-instance-lock.ts";
export type {
  InstanceInfo,
  LockData,
  SingletonMode,
} from "../server/single-instance-lock.ts";

/** Mark a method as async when minification strips constructor names. */
export { markAsync } from "../state/cell-impl.ts";

/** Deep freeze — dev-mode immutability checking on arbitrary objects. */
export { deepFreeze } from "../state/dispatch.ts";

/** Memoized selector scoped to one cell slice. */
export { createSliceSelector } from "../selector.ts";

/** The PRAGMA set createDB applies by default — for tuning custom DBs. */
export { DEFAULT_PRAGMAS } from "../db/mod.ts";

/** Deep diagnostic detail types — the shapes vitals/diagnostics emit.
 *  (The CONFIG types stay on the main entry with `aio.run()`.) */
export type {
  AioErrorContext,
  AioErrorSource,
  FlowStepRecord,
} from "../diagnostics/error.ts";
export type {
  CellStateSize,
  MemoryReport,
} from "../diagnostics/memory-monitor.ts";
export type { ReduceBreakdown } from "../diagnostics/time-travel.ts";
export type { CheckpointData } from "../diagnostics/types.ts";
export type {
  DiagEvent,
  DiagEventDetail,
  LayerThreshold,
  RenderBudget,
  VitalAlert,
  VitalHint,
  VitalLayer,
  VitalStatus,
  VitalThresholds,
} from "../vitals/types.ts";
export type { PerfCheck } from "../server/aio.ts";

/** Low-level action/reduce plumbing types — what composeCells speaks
 *  internally. App code uses methods; these exist for advanced tooling. */
export type {
  ActionSource,
  ActionUnion,
  CellExecuteFn,
  CellReduceFn,
  Creators,
} from "../state/cell.ts";

/**
 * Immer-powered immutable update returning `{ state, effects }` — the
 * explicit-reduce helper from the pre-methods era, kept for tooling that
 * still shapes reducers by hand.
 */
export function draft<S, E>(
  state: S,
  fn: (d: Draft<S>) => E[],
): { state: S; effects: E[] } {
  let effects: E[] = [];
  const next = produce(state, (d) => {
    effects = fn(d);
  });
  // Clone effects to detach from revoked Immer draft references.
  if (!effects) {
    if (
      typeof globalThis !== "undefined" &&
      (globalThis as Record<string, unknown>).__aioDev
    ) {
      console.warn(
        'draft(): reducer callback did not return an effects array — defaulting to []. Add "return []" to your reducer.',
      );
    }
    effects = [];
  }
  if (effects.length) effects = structuredClone(effects);
  return { state: next, effects };
}

/**
 * Typed effect handler dispatch — alternative to switch/case for handling
 * effect objects by `type`.
 */
// deno-lint-ignore no-explicit-any
export function matchEffect<E extends { type: string; payload?: any }>(
  effect: E,
  handlers: Partial<
    {
      [K in E["type"]]: (
        payload: Extract<E, { type: K }> extends { payload: infer P } ? P
          : undefined,
      ) => void;
    }
  >,
  fallback?: (effect: E) => void,
): void {
  const handler = handlers[effect.type as E["type"]];
  if (handler) handler((effect as { payload?: unknown }).payload as never);
  else if (fallback) fallback(effect);
}

/** Union of all payload types from an actions/effects catalog. */
export type UnionOf<T> = {
  // deno-lint-ignore no-explicit-any
  [K in keyof T]: T[K] extends (...args: any[]) => infer R ? R : never;
}[keyof T];
