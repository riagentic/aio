// flow-ctx.ts — generator helpers (ctx.call, ctx.mutate, etc.) and buildCtx

import type { Msg } from "./cell-types.ts";
import type { FlowStep, Gen, GenCtx, SingleStepGen } from "./flow-types.ts";

// ── ctx generators (yield descriptors) ───────────────────────────────

export function* callGen<T>(
  name: string,
  fn: () => T | Promise<T>,
  opts?: { timeout?: number; retries?: number },
): Gen<Awaited<T>> {
  return (yield { kind: "call", name, fn, opts } as FlowStep) as Awaited<T>;
}

export function* mutateGen(
  name: string,
  mutate: (draft: Record<string, unknown>) => void,
): Gen<void> {
  yield { kind: "step", name, mutate } as FlowStep;
}

export function* doneGen(
  mutate?: (draft: Record<string, unknown>) => void,
): Gen<void> {
  yield { kind: "done", mutate } as FlowStep;
}

export function* failGen(reason: string): Gen<never> {
  yield { kind: "fail", reason } as FlowStep;
  // unreachable — runner throws after fail
  throw new Error("flow failed: " + reason);
}

export function* dispatchGen(
  action: { type: string; payload?: unknown },
): Gen<void> {
  yield { kind: "dispatch", action } as FlowStep;
}

export function* allGen<T extends readonly SingleStepGen<unknown>[]>(
  ...gens: T
): Gen<{ [K in keyof T]: T[K] extends Gen<infer R> ? R : never }> {
  // Collect first step from each generator — only single-step generators supported (ctx.call, ctx.sleep)
  const entries: FlowStep[] = [];
  for (const g of gens) {
    const first = g.next();
    if (!first.done && first.value) {
      entries.push(first.value);
      // Guard: multi-step generators silently lose steps — reject them
      const second = g.next();
      if (!second.done) {
        throw new Error(
          "ctx.all() only supports single-step generators (ctx.call, ctx.sleep) — multi-step generators are not supported",
        );
      }
    }
  }
  return (yield { kind: "all", entries } as FlowStep) as {
    [K in keyof T]: T[K] extends Gen<infer R> ? R : never;
  };
}

export function* raceGen<T extends Record<string, SingleStepGen<unknown>>>(
  entries: T,
): Gen<{ [K in keyof T]?: T[K] extends Gen<infer R> ? R : never }> {
  // Extract first step from each generator — only single-step generators supported (ctx.call, ctx.sleep)
  const stepEntries: Record<string, FlowStep> = {};
  for (const [key, gen] of Object.entries(entries)) {
    const first = gen.next();
    if (!first.done && first.value) {
      stepEntries[key] = first.value;
      const second = gen.next();
      if (!second.done) {
        throw new Error(
          "ctx.race() only supports single-step generators (ctx.call, ctx.sleep) — multi-step generators are not supported",
        );
      }
    }
  }
  return (yield { kind: "race", entries: stepEntries } as FlowStep) as {
    [K in keyof T]?: T[K] extends Gen<infer R> ? R : never;
  };
}

export function* sleepGen(name: string, ms: number): Gen<void> {
  yield { kind: "sleep", name, ms } as FlowStep;
}

export function* sendGen(
  creatorOrType: { type: string } | string,
  payload?: unknown,
): Gen<void> {
  const type = typeof creatorOrType === "string"
    ? creatorOrType
    : creatorOrType.type;
  yield { kind: "dispatch", action: { type, payload } } as FlowStep;
}

export function* namedAllGen<T extends Record<string, SingleStepGen<unknown>>>(
  entries: T,
): Gen<{ [K in keyof T]: T[K] extends Gen<infer R> ? R : never }> {
  const keys = Object.keys(entries);
  const gens = keys.map((k) => entries[k]!);
  const results = (yield* (allGen as (...g: Gen<unknown>[]) => Gen<unknown[]>)(
    ...gens,
  )) as unknown[];
  const out: Record<string, unknown> = {};
  for (let i = 0; i < keys.length; i++) out[keys[i]!] = results[i];
  return out as { [K in keyof T]: T[K] extends Gen<infer R> ? R : never };
}

export function* waitForGen(
  creatorOrType: string | { type: string },
  timeout?: number,
): Gen<Msg> {
  const actionType = typeof creatorOrType === "string"
    ? creatorOrType
    : creatorOrType.type;
  return (yield { kind: "waitFor", actionType, timeout } as FlowStep) as Msg;
}

export function* whenGen(
  predicate: (appState: Record<string, unknown>) => boolean,
  opts?: { timeout?: number },
): Gen<void> {
  yield { kind: "when", predicate, timeout: opts?.timeout } as FlowStep;
}

/** Build a GenCtx — the context object passed to flow generators */
export function buildCtx(
  cellName: string,
  getFullState: () => Record<string, unknown>,
): GenCtx {
  // deno-lint-ignore no-explicit-any
  const allDispatch = (...args: any[]): Gen<unknown> => {
    // Named object form: ctx.all({ a: gen, b: gen })
    if (
      args.length === 1 && args[0] !== null && typeof args[0] === "object" &&
      typeof (args[0] as Record<string, unknown>).next !== "function"
    ) {
      return namedAllGen(args[0] as Record<string, SingleStepGen<unknown>>);
    }
    return allGen(...args as SingleStepGen<unknown>[]);
  };
  return {
    // callGen/sleepGen return Gen<T> at runtime — branded as SingleStepGen at type level
    call: callGen as unknown as GenCtx["call"],
    mutate: mutateGen as GenCtx["mutate"],
    done: doneGen as GenCtx["done"],
    fail: failGen,
    dispatch: dispatchGen,
    send: sendGen,
    all: allDispatch as GenCtx["all"],
    race: raceGen as unknown as GenCtx["race"],
    sleep: sleepGen as unknown as GenCtx["sleep"],
    waitFor: waitForGen as unknown as GenCtx["waitFor"],
    when: whenGen as unknown as GenCtx["when"],
    getState: () => getFullState()[cellName] as Record<string, unknown>,
    getFullState: () => getFullState(),
  };
}
