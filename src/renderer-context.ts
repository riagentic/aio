// renderer-context.ts — Context API: createContext, useContext, useContextSelector.

import { computed, type Signal, signal } from "./signal.ts";
import type { ComponentFn, VNode } from "./vdom.ts";
import { Fragment, h } from "./vdom.ts";
import { _currentCollector, _instanceStack } from "./renderer-state.ts";

// ── Context interface ─────────────────────────────────────────────────

/** Context object created by createContext(). */
export interface Context<T> {
  readonly _id: symbol;
  readonly _default: T;
  readonly Provider: ComponentFn;
}

// ── createContext ─────────────────────────────────────────────────────

/** Create a context with a default value. */
export function createContext<T>(defaultValue: T): Context<T> {
  const id = Symbol();

  const Provider: ComponentFn = (
    props: { value: T; children: (VNode | string | number)[] },
  ) => {
    if (_currentCollector) {
      if (!_currentCollector.contexts) _currentCollector.contexts = new Map();
      const existing = _currentCollector.contexts.get(id) as
        | Signal<T>
        | undefined;
      if (existing && typeof existing === "object" && "set" in existing) {
        existing.set(props.value);
      } else {
        _currentCollector.contexts.set(id, signal(props.value));
      }
    }
    return h(Fragment, null, ...props.children);
  };

  return { _id: id, _default: defaultValue, Provider };
}

// ── useContext ────────────────────────────────────────────────────────

/** Read the current value of a context. Must be called inside a component. */
export function useContext<T>(ctx: Context<T>): T {
  for (let i = _instanceStack.length - 1; i >= 0; i--) {
    const inst = _instanceStack[i]!;
    if (inst.contexts?.has(ctx._id)) {
      const entry = inst.contexts.get(ctx._id);
      if (entry && typeof entry === "object" && "value" in entry) {
        return (entry as Signal<T>).value;
      }
      return entry as T;
    }
  }
  return ctx._default;
}

// ── useContextSelector ────────────────────────────────────────────────

/**
 * Select a slice of context. Component only re-renders when the selected value changes.
 * Uses a computed signal so only the selected slice is tracked as a dependency.
 */
export function useContextSelector<T, R>(
  ctx: Context<T>,
  selector: (value: T) => R,
): R {
  let contextSignal: Signal<T> | null = null;
  for (let i = _instanceStack.length - 1; i >= 0; i--) {
    const inst = _instanceStack[i]!;
    if (inst.contexts?.has(ctx._id)) {
      const entry = inst.contexts.get(ctx._id);
      if (entry && typeof entry === "object" && "value" in entry) {
        contextSignal = entry as Signal<T>;
      }
      break;
    }
  }

  if (!contextSignal) {
    return selector(ctx._default);
  }

  const sig = contextSignal;
  const selected = computed(() => selector(sig.value));
  return selected.value;
}
