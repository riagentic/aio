/**
 * @module
 * AIR adapter — signal-based hooks for AIO native renderer.
 *
 * `useFeature`/`useAio` read from state-core signals directly.
 * Signal reads auto-track in AIR's per-component scope.
 *
 * @example
 * ```ts
 * import { useFeature } from "aio/adapters/air";
 * const { state, send } = useFeature(myFeature);
 * ```
 */

import { signal } from "../signal.ts";
import { useRef } from "../aio-renderer.ts";
import {
  createSendProxy,
  type FeatureRef,
  getConnectedSignal,
  getFeatureSignal,
  getStateSignal,
  send,
  trackPath,
} from "../state-core.ts";
import type {
  DirectCalling,
  ExtractState,
  FeatureDef,
  SendOf,
} from "../feature-types.ts";

// Typed overload — when passing a feature def with DirectCalling methods
export function useFeature<
  // deno-lint-ignore no-explicit-any
  F extends FeatureDef<any, any, any, any> & DirectCalling<any>,
>(
  ref: F,
): { state: ExtractState<F>; send: SendOf<F> };
// Untyped overload — for dynamic FeatureRef usage
export function useFeature<
  S extends Record<string, unknown> = Record<string, unknown>,
>(
  ref: FeatureRef,
): { state: S; send: Record<string, (...args: unknown[]) => void> };
// Implementation
// deno-lint-ignore no-explicit-any
export function useFeature(ref: any): any {
  const name = ref.__aio.id;
  const sig = getFeatureSignal(name, ref.__aio.state);
  trackPath(name);

  // deno-lint-ignore no-explicit-any
  const state = new Proxy({} as any, {
    get(_target, prop: string | symbol): unknown {
      if (typeof prop === "symbol") return undefined;
      const s = sig.value; // tracked read — auto-tracked by AIR renderer
      if (s == null) {
        const fallback = ref.__aio.state as Record<string, unknown> | undefined;
        return fallback ? fallback[prop] : undefined;
      }
      return (s as Record<string, unknown>)[prop];
    },
    ownKeys(): string[] {
      const s = sig.value;
      return s ? Object.keys(s as Record<string, unknown>) : [];
    },
    has(_target, prop: string | symbol): boolean {
      if (typeof prop === "symbol") return false;
      const s = sig.value;
      return s ? prop in (s as Record<string, unknown>) : false;
    },
    getOwnPropertyDescriptor(
      _target,
      prop: string | symbol,
    ): PropertyDescriptor | undefined {
      if (typeof prop === "symbol") return undefined;
      const s = sig.value;
      if (!s || !(prop in (s as Record<string, unknown>))) return undefined;
      return {
        configurable: true,
        enumerable: true,
        value: (s as Record<string, unknown>)[prop as string],
      };
    },
  });

  return { state, send: createSendProxy(name, ref) };
}

export function useAio<
  S extends Record<string, unknown> = Record<string, unknown>,
>(): {
  state: S;
  send: (action: { type: string; payload?: unknown }) => void;
} {
  trackPath("*");
  const sig = getStateSignal();

  const state = new Proxy({} as S, {
    get(_target, prop: string | symbol): unknown {
      if (typeof prop === "symbol") return undefined;
      return (sig.value as Record<string, unknown>)[prop as string];
    },
    ownKeys(): string[] {
      return Object.keys(sig.value);
    },
    has(_target, prop: string | symbol): boolean {
      if (typeof prop === "symbol") return false;
      return prop in sig.value;
    },
    getOwnPropertyDescriptor(
      _target,
      prop: string | symbol,
    ): PropertyDescriptor | undefined {
      if (typeof prop === "symbol") return undefined;
      const s = sig.value;
      if (!(prop in s)) return undefined;
      return { configurable: true, enumerable: true, value: s[prop as string] };
    },
  });

  return { state, send };
}

export function useLocal<T>(
  initial: T,
): {
  readonly local: T;
  set: (next: T | ((prev: T) => T)) => void;
  patch: T extends Record<string, unknown> ? (partial: Partial<T>) => void
    : never;
} {
  const ref = useRef<ReturnType<typeof signal<T>> | null>(null);
  if (!ref.current) ref.current = signal(initial);
  const sig = ref.current;
  return {
    get local(): T {
      return sig.value;
    },
    set: (next: T | ((prev: T) => T)) => {
      // AIO-66: Accept updater function like React's useState
      if (typeof next === "function") {
        sig.set((next as (prev: T) => T)(sig.peek()));
      } else {
        sig.set(next);
      }
    },
    // AIO-66: Partial updates for object state — merge with current
    patch: ((partial: Partial<T>) => {
      const current = sig.peek();
      if (current && typeof current === "object" && !Array.isArray(current)) {
        sig.set({ ...current, ...partial });
      }
    }) as T extends Record<string, unknown> ? (partial: Partial<T>) => void
      : never,
  };
}

export function useConnected(): boolean {
  return getConnectedSignal().value;
}
