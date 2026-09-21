// renderer-context.ts — Context API: createContext, useContext, useContextSelector.

import {
  computed,
  effect,
  type Signal,
  signal,
  untrack,
} from "../state/signal.ts";
import type { ComponentFn, VNode } from "./vdom.ts";
import { Fragment, h } from "./vdom.ts";
import {
  _currentCollector,
  _insideMount,
  _instanceStack,
} from "./renderer-state.ts";
import { isSignal } from "./signal-binding.ts";
import {
  _inSsrCall,
  _SSR_NO_CONTEXT,
  _ssrContextValue,
  _ssrProvide,
} from "./vdom-ssr.ts";

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
    // A server render has no instance to hold the value; its writer scopes it
    // to this Provider's output instead (see `_ssrScoped`). Asked FIRST: a
    // server call in progress is the innermost render whatever else is open.
    if (!_ssrProvide(id, props.value) && _currentCollector) {
      if (!_currentCollector.contexts) _currentCollector.contexts = new Map();
      const existing = _currentCollector.contexts.get(id) as
        | Signal<T>
        | undefined;
      if (isSignal(existing)) {
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

/** Read the current value of a context. Must be called inside a component.
 *  @tier Advanced */
export function useContext<T>(ctx: Context<T>): T {
  // On the server the RAW provided value is the answer — the client wraps it
  // in a signal and reads `.value`, which is the same value.
  if (_inSsrCall()) {
    const v = _ssrContextValue(ctx._id);
    return v === _SSR_NO_CONTEXT ? ctx._default : v as T;
  }
  for (let i = _instanceStack.length - 1; i >= 0; i--) {
    const inst = _instanceStack[i]!;
    if (inst.contexts?.has(ctx._id)) {
      const entry = inst.contexts.get(ctx._id);
      // isSignal is THE decider — a context entry is either a signal (the
      // Provider path) or a raw value. A local `typeof === "object"` copy
      // stopped recognising signals the day they became callable, and
      // `useContext` started handing components the signal OBJECT where they
      // expected its value.
      if (isSignal(entry)) return (entry as Signal<T>).value;
      return entry as T;
    }
  }
  return ctx._default;
}

// ── useContextSelector ────────────────────────────────────────────────

/**
 * Select a slice of context. The component re-renders only when the selected
 * value changes (`Object.is`), not when an unselected field of the context does.
 * Outside a component render it reads the selection once and subscribes nothing.
 *  @tier Advanced */
export function useContextSelector<T, R>(
  ctx: Context<T>,
  selector: (value: T) => R,
): R {
  // A server render reads once — there is no re-render to subscribe for.
  if (_inSsrCall()) {
    const v = _ssrContextValue(ctx._id);
    return selector(v === _SSR_NO_CONTEXT ? ctx._default : v as T);
  }
  let contextSignal: Signal<T> | null = null;
  for (let i = _instanceStack.length - 1; i >= 0; i--) {
    const inst = _instanceStack[i]!;
    if (inst.contexts?.has(ctx._id)) {
      const entry = inst.contexts.get(ctx._id);
      if (isSignal(entry)) contextSignal = entry as Signal<T>;
      break;
    }
  }

  if (!contextSignal) {
    return selector(ctx._default);
  }

  const sig = contextSignal;

  // Outside a render there is nothing to re-render: read once, leak nothing.
  // "A render" means a component BODY: the mount flush sets the collector too
  // (so `onCleanup` inside `onMount` works), but opens no effect collector, so
  // an effect created there would have nobody to dispose it.
  if (!_currentCollector || _insideMount) {
    const selected = computed(() => selector(sig.value));
    const value = selected.value;
    (selected as unknown as { dispose(): void }).dispose();
    return value;
  }

  // Inside a render, the component must subscribe to the SELECTION, not the
  // context. A `computed` cannot give that: it invalidates its readers
  // eagerly, the moment the context moves and before anyone asks whether the
  // selected value did — so every unselected field re-rendered the reader,
  // against this function's one promise. The diff then found nothing to
  // change, which is why a DOM-only test never saw it.
  //
  // So the render subscribes to a private `changed` signal, and an effect
  // watches the context and bumps it only when `selector` returns a value that
  // is not `Object.is` the one this render used. Both are per-render: the
  // effect is created inside the render, so the renderer's effect collector
  // disposes it at the next re-render and that render builds a fresh pair —
  // no hook slot, so a `useContextSelector` behind an `if` keeps working.
  //
  // The effect's first run IS this render's selection: calling `selector` a
  // second time and comparing would treat a selector that builds a fresh
  // object (`(v) => ({ a: v.a })`) as "changed" mid-render and loop forever.
  let value!: R;
  let first = true;
  const changed = signal(0);
  effect(() => {
    const next = selector(sig.value);
    if (first) {
      first = false;
      value = next;
      return;
    }
    if (Object.is(next, value)) return;
    value = next;
    untrack(() => changed.set(changed.peek() + 1));
  });
  void changed.value;
  return value;
}
