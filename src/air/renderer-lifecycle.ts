// renderer-lifecycle.ts — component lifecycle hooks and persistent state hooks.
// Provides: onMount, onCleanup, useRef, useSignal, useId, _resetSsrIdCounter, useOptimistic.

import { type Signal, signal } from "../state/signal.ts";
import { isDevMode } from "../state/dev-flag.ts";
import type { ComponentInstance } from "./renderer-types.ts";
import {
  _activeRoot,
  _currentCollector,
  _insideMount,
  _setCurrentCollector,
} from "./renderer-state.ts";

/** `onMount`/`onCleanup` outside a render were dropped in SILENCE, while
 *  `afterRender`, `useRef` and `useSignal` all say so for the identical
 *  mistake. The symptom was "my subscription never runs" with nothing to
 *  search for. Observe-only, so dev and prod behave identically — prod drops
 *  it exactly as before, dev additionally names it. */
function _warnOutsideRender(hook: string): void {
  if (!isDevMode()) return;
  console.warn(
    `[aio-dev] ${hook}() called outside a component render — there is no ` +
      `component to attach it to, so the callback was DROPPED. It only works ` +
      `in a component body (or, for onCleanup, inside an onMount callback); ` +
      `from a timer, a promise continuation or an event handler there is ` +
      `nothing to bind its lifetime to.`,
  );
}

// ── onMount / onCleanup ───────────────────────────────────────────────

/**
 * Register a callback to run after the component's first render.
 * Must be called inside a component function body during render.
 */
export function onMount(fn: () => void): void {
  if (!_currentCollector) {
    _warnOutsideRender("onMount");
    return;
  }
  _currentCollector.mountCallbacks.push(fn);
}

/**
 * Register a cleanup callback.
 * - Called in component body: runs on unmount AND before each re-render.
 * - Called inside onMount(): runs ONLY on unmount (AIO-76 fix).
 */
export function onCleanup(fn: () => void): void {
  if (!_currentCollector) {
    _warnOutsideRender("onCleanup");
    return;
  }
  if (_insideMount && "mountCleanupCallbacks" in _currentCollector) {
    (_currentCollector as ComponentInstance).mountCleanupCallbacks.push(fn);
  } else {
    _currentCollector.cleanupCallbacks.push(fn);
  }
}

// ── onGlobalKey ───────────────────────────────────────────────────────

/** Modifier state a chord can require. Omitted = "don't care". */
export type KeyChord = {
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
  shift?: boolean;
  /** Match either Ctrl or Cmd — the portable "the modifier key" (Ctrl+K on
   *  Linux/Windows, ⌘K on macOS), which is what an app almost always means. */
  mod?: boolean;
  /** Ignore the chord while focus is in an input/textarea/contenteditable.
   *  Default `true`: a bare `"n"` shortcut that fires while someone is typing
   *  a note is a bug in every app that has ever shipped one. */
  ignoreInInput?: boolean;
};

/** A window/document-level key binding, scoped to this component's lifetime.
 *
 *  Every app needs one — Escape closes the lightbox, Ctrl+K opens the palette,
 *  `?` shows help — and every app hits the same wall building it, twice:
 *
 *  1. It must be registered on the DOCUMENT the component is rendered into.
 *     `globalThis.addEventListener("keydown", …)` is the natural spelling and
 *     is INERT under `testUI` (aio warns about it); `document.addEventListener`
 *     works but has to be torn down by hand.
 *  2. The chord logic gets rewritten each time — and one field report's
 *     workaround was to extract the predicate into a pure function and test
 *     THAT, leaving the listener itself permanently uncovered.
 *
 *  This is that binding, as one line that is testable by construction: it
 *  resolves the document the way the docs tell you to (`ownerDocument`, via
 *  the mounted root), removes itself on unmount, and fires under `testUI`.
 *
 *  ```tsx
 *  onGlobalKey("Escape", () => lightbox.close())
 *  onGlobalKey("k", () => palette.open(), { mod: true })
 *  ```
 *  `key` is matched case-insensitively against `KeyboardEvent.key`. */
export function onGlobalKey(
  key: string,
  fn: (e: KeyboardEvent) => void,
  chord: KeyChord = {},
): void {
  // The LATEST callback, chord and key — refreshed every render, read at event
  // time. The listener is registered inside `onMount`, which runs ONCE, so
  // closing over the arguments froze them at mount: a handler reading a value
  // that changes (`() => save(draft)`, `() => go(page + 1)`) kept firing with
  // render 1's copy forever — measured `[1, 1, 1]` where the app expected
  // `[1, 2, 3]`. `useRaf`/`useInterval` in raf.ts already solve exactly this
  // with a ref, and say so; this is the same solution, so the three agree.
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const chordRef = useRef(chord);
  chordRef.current = chord;
  const keyRef = useRef(key);
  keyRef.current = key;
  onMount(() => {
    const doc = _activeRoot?.root?.ownerDocument ??
      (globalThis as { document?: Document }).document;
    if (!doc) return;
    const handler = (ev: Event) => {
      const e = ev as KeyboardEvent;
      const chord = chordRef.current;
      if ((e.key ?? "").toLowerCase() !== keyRef.current.toLowerCase()) return;
      if (chord.ctrl !== undefined && e.ctrlKey !== chord.ctrl) return;
      if (chord.meta !== undefined && e.metaKey !== chord.meta) return;
      if (chord.alt !== undefined && e.altKey !== chord.alt) return;
      if (chord.shift !== undefined && e.shiftKey !== chord.shift) return;
      if (chord.mod !== undefined && (e.ctrlKey || e.metaKey) !== chord.mod) {
        return;
      }
      if (chord.ignoreInInput !== false) {
        const t = e.target as
          | { tagName?: string; isContentEditable?: boolean }
          | null;
        const tag = (t?.tagName ?? "").toUpperCase();
        if (
          tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
          t?.isContentEditable
        ) return;
      }
      fnRef.current(e);
    };
    doc.addEventListener("keydown", handler);
    onCleanup(() => doc.removeEventListener("keydown", handler));
  });
}

// ── useRef ────────────────────────────────────────────────────────────

/**
 * Persist a mutable ref across renders. Does not trigger re-render on mutation.
 * Must be called inside a component function body during render.
 */
export function useRef<T>(initial: T): { current: T } {
  if (!_currentCollector) {
    if (isDevMode()) {
      console.warn(
        "[aio-dev] useRef() called outside a component render. The ref will not persist across re-renders.",
      );
    }
    return { current: initial };
  }
  const collector = _currentCollector;
  if (!collector.refs) collector.refs = [];
  if (collector.refIndex === undefined) collector.refIndex = 0;
  const idx = collector.refIndex++;
  if (idx >= collector.refs.length) {
    const ref = { current: initial };
    collector.refs.push(ref);
    return ref;
  }
  return collector.refs[idx] as { current: T };
}

// ── useSignal ─────────────────────────────────────────────────────────

/**
 * Creates a component-scoped signal. Auto-GC'd on unmount.
 * For state that survives remounts, use a module-level `signal()`.
 *
 * @example
 * ```tsx
 * // Module-level UI state (survives unmount)
 * const ui = signal({ collapsed: [] as string[] }, 'sidebar')
 *
 * function Sidebar() {
 *   void ui.value // subscribe parent
 *   return <TreeRow collapsed={ui.value.collapsed} />
 * }
 * ```
 */
export function useSignal<T>(initial: T): Signal<T> {
  if (!_currentCollector) {
    if (isDevMode()) {
      console.warn(
        "[aio-dev] useSignal() called outside a component render. The signal will not persist across re-renders.",
      );
    }
    return signal(initial);
  }
  const collector = _currentCollector;
  if (!collector.refs) collector.refs = [];
  if (collector.refIndex === undefined) collector.refIndex = 0;
  const idx = collector.refIndex++;
  if (idx >= collector.refs.length) {
    const sig = signal(initial);
    collector.refs.push(sig as unknown as { current: unknown });
    return sig;
  }
  return collector.refs[idx] as unknown as Signal<T>;
}

// ── useId — SSR-safe unique ID ────────────────────────────────────────

let _ssrIdCounter = 0;

/** Reset SSR ID counter. Called at the start of each renderToString. */
export function _resetSsrIdCounter(): void {
  _ssrIdCounter = 0;
}

/**
 * Generate a unique, SSR-stable ID. Persists across re-renders.
 * Format: `:r{N}:` — deterministic per render tree traversal order.
 * Must be called inside a component function body during render.
 */
export function useId(): string {
  if (!_currentCollector) {
    return `:r${_ssrIdCounter++}:`;
  }
  const collector = _currentCollector;
  if (!collector.refs) collector.refs = [];
  if (collector.refIndex === undefined) collector.refIndex = 0;
  const idx = collector.refIndex++;
  if (idx >= collector.refs.length) {
    const root = _activeRoot;
    const n = root ? root._idCounter++ : _ssrIdCounter++;
    const ref = { current: `:r${n}:` };
    collector.refs.push(ref);
    return ref.current;
  }
  return (collector.refs[idx] as { current: string }).current;
}

// ── useOptimistic — optimistic UI during async operations ─────────────

/**
 * Optimistic UI hook. Shows an immediate update while an async action runs,
 * then reverts to the real state when it completes (success or failure).
 */
export function useOptimistic<T, A = T>(
  passthrough: T,
  updateFn: (current: T, optimistic: A) => T,
): [T, (action: A) => void] {
  const pendingRef = useRef<A[]>([]);
  const version = useSignal(0);

  const prevRef = useRef<T>(passthrough);
  if (passthrough !== prevRef.current) {
    prevRef.current = passthrough;
    pendingRef.current = [];
  }

  void version.value;

  let display = passthrough;
  for (const action of pendingRef.current) {
    display = updateFn(display, action);
  }

  function addOptimistic(action: A): void {
    pendingRef.current = [...pendingRef.current, action];
    version.set(version.peek() + 1);
  }

  return [display, addOptimistic];
}

// Re-export so aio-renderer.ts can use _setCurrentCollector via lifecycle module
export { _setCurrentCollector };
