// renderer-lifecycle.ts — component lifecycle hooks and persistent state hooks.
// Provides: onMount, onCleanup, useRef, useSignal, useId, _resetSsrIdCounter, useOptimistic.

import { type Signal, signal } from "../state/signal.ts";
import { isDevMode } from "../state/dev-flag.ts";
import type { ComponentInstance } from "./renderer-types.ts";
import { _nameHookSignal } from "./untracked-read.ts";
import {
  _activeRoot,
  _currentCollector,
  _insideMount,
  _setCurrentCollector,
} from "./renderer-state.ts";
import { _inSsrCall } from "./vdom-ssr.ts";
import { _ssrRenderCurrent } from "./ssr-render.ts";

/** Is the hook that is running part of a SERVER render of a component?
 *
 *  A server render calls component functions directly, so there is no
 *  instance and `_currentCollector` is null — by design, not by mistake. Every
 *  hook below then told the author they had called it "outside a component
 *  render", in a component body, for code written exactly as the docs show:
 *  measured, ONE ordinary component printed SEVEN of those per
 *  `renderToString`, and the dev server sets `__aioDev` too, so an app that
 *  server-renders in `deno task dev` buried its log under one wall of false
 *  accusations per request. `useId` is the hook that already knew — it takes
 *  an SSR branch and says nothing.
 *
 *  `_inSsrCall()` and not `_isSsrRendering()`: the latter stays true for the
 *  whole span of a `renderToStream`, including the async gaps between chunks,
 *  where a hook called from a timer IS the mistake the warning is for. This
 *  is true only for the synchronous span of one server component call. */
function _inServerRender(): boolean {
  return _inSsrCall();
}

/** `onMount`/`onCleanup` outside a render were dropped in SILENCE, while
 *  `afterRender`, `useRef` and `useSignal` all say so for the identical
 *  mistake. The symptom was "my subscription never runs" with nothing to
 *  search for. Observe-only, so dev and prod behave identically — prod drops
 *  it exactly as before, dev additionally names it. */
/** @internal Is a component body running right now? Hooks that would
 *  otherwise warn "outside a component render" ask this first. */
export function _inRender(): boolean {
  return _currentCollector !== null;
}

function _warnOutsideRender(hook: string): void {
  if (!isDevMode() || _inServerRender()) return;
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
 *
 * A returned function is the callback's CLEANUP and runs on unmount — the same
 * contract React, Solid, Svelte and Vue all use, so the shape every developer
 * arrives with is the shape that works. It used to be dropped: TypeScript lets
 * a `() => void` callback return anything, so
 *
 *     onMount(() => { const t = setInterval(poll, 400); return () => clearInterval(t); });
 *
 * type-checked, looked right, and leaked the timer for the life of the process.
 * A wallet shipped that three times in three components over months — every
 * send dialog ever opened left another interval waking the loop 2.5×/second,
 * each holding its component's whole closure alive — and there was no gate that
 * could have caught it, because nothing was wrong with the code as written.
 * `onCleanup` still works exactly as before; this is the second door, and the
 * one people knock on first.
 */
//
// The SIGNATURE is unchanged, deliberately. TypeScript gives a callback declared
// `() => void` a special rule — any return value is accepted — which is both why
// the leak compiled and why nothing here needs to move: `return () => clear()`
// already type-checks against this exact signature, so honouring it at runtime
// is the whole fix. Widening the type to `() => void | (() => void)` would LOSE
// that rule and stop `onMount(() => count++)` compiling in every app that has
// one; an overload pair keeps it but reshapes the public signature, and the
// surface is frozen. Runtime-only is the shape that costs nobody anything.
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

/**
 * Register a cleanup that runs ONCE, when this component goes away for good.
 *
 * The counterpart to `onCleanup`, and the reason it exists: `onCleanup` in a
 * component BODY runs on unmount **and before every re-render**, which is
 * right for a cleanup the body re-creates each render and wrong for anything
 * that should outlive one. A field report lost an afternoon to the difference,
 * four times in four components — a gallery released its place in a download
 * queue from the body, so 85 of 89 cards were cancelled on the next repaint
 * and never asked again; a send button's three-second auto-disarm was cleared
 * on every balance patch, so a safety control quietly stopped being one. Every
 * other framework ties a cleanup to an effect rather than to a repaint, so the
 * body is where people reach for it.
 *
 *     onMount(() => { const t = setInterval(poll, 400); onCleanup(() => clearInterval(t)); });
 *     onUnmount(() => queue.release(slot));   // …the same thing, said once
 *
 * NOT a wrapper for `onMount(() => onCleanup(fn))`, which is the spelling
 * people write and is subtly wrong: a render that never commits never runs its
 * `onMount`, so a hold released only from there is leaked for good. This runs
 * at the unmount, at once if the body threw, and at once if a boundary above
 * caught before the instance mounted.
 *
 * `aiol` flags a body-level `onCleanup` that tears down something the body did
 * not create, and names this.
 *
 * @example
 * ```tsx
 * function NftThumb({ id }: { id: string }) {
 *   const slot = useRef(queue.take(id));
 *   onUnmount(() => slot.current.release());
 *   return <img src={id} />;
 * }
 * ```
 *
 *  @tier Core
 */
export function onUnmount(fn: () => void): void {
  if (!_currentCollector) {
    _warnOutsideRender("onUnmount");
    return;
  }
  // Registered inside an `onMount` callback, which runs once — there is no
  // re-registration to guard against, and taking a ref slot there would move
  // the hook cursor at a moment no other render reaches.
  if (_insideMount) {
    _onUnmount(fn);
    return;
  }
  // ONE hold per call site, not one per render.
  //
  // `_onUnmount` appends, and a component body runs again on every render, so
  // a bare `onUnmount(() => queue.release(slot))` in a body that rendered
  // three times released the slot THREE times at unmount — a double-free
  // dressed up as the fix for a leak. `useResource` never hit it because its
  // own `_onUnmount` sits behind a ref that is filled once; nobody should
  // have to know that to use this.
  //
  // The box is re-pointed at the newest closure each render, so the callback
  // that eventually runs reads the LAST render's values, not the first's —
  // pinning the first would be the same staleness bug from the other side.
  //
  // THE SLOT IS CHECKED, not assumed to be ours. A slot is matched by CALL
  // ORDER, so a conditional `onUnmount` — the natural thing to write, since
  // `onMount`/`onCleanup` beside it may be called conditionally and the docs
  // say so — lands on a NEIGHBOUR's `useRef`/`useSignal` slot. Reading it as a
  // box made that fail three different ways, none of them naming the cause:
  //
  //   slot holds `{n: 7}`  → truthy, so `fn` was written onto the app's own
  //                          object and `_onUnmount` was NEVER CALLED: the
  //                          hold was leaked, in silence, in production —
  //                          the exact bug onUnmount exists to prevent;
  //   slot holds `"B"`     → `TypeError: Cannot create property 'fn' on
  //                          string 'B'`, from inside the renderer;
  //   slot holds a signal  → it happened to work.
  //
  // The dev hook-order tripwire does not save this: it runs AFTER the body, so
  // the TypeError beats it, and it is observe-only, so production never hears
  // it at all. A fresh slot is recognised by a sentinel only this function
  // can produce, a returning one by the box's own brand, and anything else is
  // named here, at the call that did it.
  const slot = useRef<unknown>(_EMPTY_SLOT);
  const held = slot.current;
  if (held !== _EMPTY_SLOT) {
    if (_isUnmountBox(held)) {
      held.fn = fn;
      return;
    }
    throw new Error(
      `[aio] onUnmount() landed on another hook's state slot (which holds ` +
        `${
          held === null
            ? "null"
            : typeof held === "object"
            ? "an object"
            : JSON.stringify(held)
        }). ` +
        `It takes a state slot so it can register once rather than once per ` +
        `render, and state slots are matched by CALL ` +
        `ORDER — so an onUnmount() behind an \`if\` (or in a loop whose ` +
        `length changes) lands on the useRef/useSignal next to it, and the ` +
        `hold is never released. Call onUnmount() unconditionally at the top ` +
        `of the body and put the condition inside the callback.`,
    );
  }
  const box: _UnmountBox = { [_UNMOUNT_BOX]: true, fn };
  slot.current = box;
  _onUnmount(() => box.fn());
}

/** The value a slot this function has never used holds — module-private, so
 *  nothing an app can put in a `useRef` is mistaken for it. */
const _EMPTY_SLOT: unique symbol = Symbol("aio.onUnmountEmpty");
/** The brand on {@linkcode onUnmount}'s box: a slot holding one is a slot this
 *  call site already owns, and any other value is somebody else's. */
const _UNMOUNT_BOX: unique symbol = Symbol("aio.onUnmountBox");
type _UnmountBox = { [_UNMOUNT_BOX]: true; fn: () => void };

function _isUnmountBox(v: unknown): v is _UnmountBox {
  return typeof v === "object" && v !== null &&
    (v as Record<symbol, unknown>)[_UNMOUNT_BOX] === true;
}

/** @internal Run `fn` when the component rendering right now goes away for
 *  good: at its unmount, or at once if this render is THROWN AWAY before an
 *  instance exists (its body threw) or the instance is discarded unmounted (a
 *  boundary above it caught). Returns false outside a render.
 *
 *  Not `onMount(() => onCleanup(fn))`: a render that never commits never runs
 *  its `onMount`, so a hold released only from there leaked for good. */
export function _onUnmount(fn: () => void): boolean {
  const collector = _currentCollector;
  if (!collector) return false;
  (collector.mountCleanupCallbacks ??= []).push(fn);
  return true;
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

/** @internal Two monotonic counters, bumped by every `onGlobalKey` listener:
 *  how many bindings a keydown actually RAN, and how many matched the chord
 *  but were skipped because the key landed in a field (`ignoreInInput`).
 *
 *  The trigger tier (`triggerPress`) reads the delta across one press to tell
 *  the two silent outcomes apart: "nothing was listening for that chord"
 *  (not its business) from "a binding WAS listening and the input swallowed
 *  it" — a press that dispatches, asserts green, and ran the handler zero
 *  times. Counting here rather than re-deriving the predicate at the trigger
 *  keeps ONE decider: whatever this listener skips is exactly what is warned
 *  about, forever. Not dev-gated — two integer bumps, identical in dev and
 *  prod, so the harness cannot observe a path prod does not take. */
export const _globalKeyProbe = { ran: 0, swallowed: 0 };

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
        ) {
          _globalKeyProbe.swallowed++;
          return;
        }
      }
      _globalKeyProbe.ran++;
      fnRef.current(e);
    };
    doc.addEventListener("keydown", handler);
    onCleanup(() => doc.removeEventListener("keydown", handler));
  });
}

/**
 * Listen for an event on the window this component is actually mounted in,
 * for as long as it is mounted.
 *
 * The obvious spelling — `globalThis.addEventListener("mousemove", fn)` —
 * looks right because in a single browser page `globalThis` IS the window. In
 * aio it frequently is not: a component can be mounted in an Electron child
 * window or a `<webview>`, where the bare global belongs to a DIFFERENT window
 * and the handler never hears the event; and under `testUI` the mount lives in
 * a happy-dom window while `globalThis` is Deno's, which is why registering
 * there fails the test rather than quietly doing nothing.
 *
 * The correct-everywhere form is `el.ownerDocument.defaultView.addEventListener`
 * — which is why a field report found every component in its repo carrying a
 * `document.defaultView ?? globalThis` incantation, with the one place someone
 * forgot it invisible. This resolves the same window for you, and removes the
 * listener on unmount.
 *
 * ```tsx
 * onWindowEvent("mousemove", (e) => setPos(e.clientX, e.clientY));
 * onWindowEvent("resize", () => remeasure());
 * ```
 *
 * The handler is read at event time, so it always sees the latest render's
 * closure — the same ref discipline as `onGlobalKey`, `useRaf` and
 * `useInterval`, and for the same reason: a listener registered once inside
 * `onMount` would otherwise fire forever with render 1's variables.
 *
 * Call it during render, like every other hook.
 */
export function onWindowEvent<K extends keyof WindowEventMap>(
  type: K,
  fn: (e: WindowEventMap[K]) => void,
  options?: AddEventListenerOptions,
): void;
export function onWindowEvent(
  type: string,
  fn: (e: Event) => void,
  options?: AddEventListenerOptions,
): void;
export function onWindowEvent(
  type: string,
  fn: (e: Event) => void,
  options?: AddEventListenerOptions,
): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  onMount(() => {
    // The component's OWN window — the same resolution `onGlobalKey` uses for
    // its document. Falls back to the ambient one only when there is no
    // mounted root to ask (SSR, a detached render).
    const doc = _activeRoot?.root?.ownerDocument ??
      (globalThis as { document?: Document }).document;
    const win = (doc as { defaultView?: EventTarget } | undefined)
      ?.defaultView ?? (globalThis as unknown as EventTarget);
    const handler = (e: Event) => fnRef.current(e);
    win.addEventListener(type, handler, options);
    onCleanup(() => win.removeEventListener(type, handler, options));
  });
}

// ── useRef ────────────────────────────────────────────────────────────

/**
 * Persist a mutable ref across renders. Does not trigger re-render on mutation.
 * Must be called inside a component function body during render.
 *  @tier Core */
export function useRef<T>(initial: T): { current: T } {
  if (!_currentCollector) {
    if (isDevMode() && !_inServerRender()) {
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
 *  @tier Core */
export function useSignal<T>(initial: T): Signal<T> {
  if (!_currentCollector) {
    if (isDevMode() && !_inServerRender()) {
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
    _nameHookSignal(
      sig,
      "useSignal",
      collector._component,
      idx,
      collector.refs,
    );
    collector.refs.push(sig as unknown as { current: unknown });
    return sig;
  }
  return collector.refs[idx] as unknown as Signal<T>;
}

// ── useId — SSR-safe unique ID ────────────────────────────────────────

let _ssrIdCounter = 0;

/** The id sequence for everything that is NOT continuing server markup: every
 *  `mount()` root, and a hydrated root once its hydration pass is over. One per
 *  document, not one per root — a per-root counter restarted at 0 for each
 *  root, so two `mount()`s on one page both handed out `:r0:` and a
 *  `<label for>` in the second root pointed at the first root's input.
 *
 *  Its ids are spelled `:rc{N}:`, apart from the server's `:r{N}:`. One shared
 *  spelling cannot be made unique: a hydration pass MUST reproduce the server's
 *  numbers, and it can run after a `mount()` has already handed those numbers
 *  out — `mount()` then `hydrate()` on one page gave both roots `:r0:`. No
 *  client counter can skip numbers a later hydration will need, so the two
 *  sequences are kept from ever meeting instead. */
let _clientIdCounter = 0;

/** The id sequence of the server render executing right now, or the module
 *  fallback for a `useId()` that is not inside any server component call.
 *
 *  A top-level `renderToString`/`renderToStream` carries its own counter (see
 *  ssr-render.ts): one module counter, reset per render, meant that two
 *  streams pulled in turn handed each other's fields the numbers — measured
 *  `:r0: :r2:` for one page and `:r1: :r3:` for the other, where hydration
 *  (whose per-root counter restarts at 0) reproduces `:r0: :r1:`. Every id
 *  after the first was a hydration mismatch, so every `<label for>` /
 *  `aria-controls` pair the server wrote pointed at the wrong element. */
function _nextSsrId(): number {
  const render = _ssrRenderCurrent();
  return render ? render.ids++ : _ssrIdCounter++;
}

/** Reset the FALLBACK SSR ID counter — the one a `useId()` outside any server
 *  component call draws from. Called at the start of each renderToString. */
export function _resetSsrIdCounter(): void {
  _ssrIdCounter = 0;
}

/**
 * Generate a unique, SSR-stable ID. Persists across re-renders.
 * Format: `:r{N}:` on the server and while hydrating its markup (deterministic
 * per render tree traversal order); `:rc{N}:` for ids a client root generates
 * itself, one sequence per document, so the two can never collide.
 * Must be called inside a component function body during render.
 *  @tier Advanced */
export function useId(): string {
  if (!_currentCollector) {
    return `:r${_nextSsrId()}:`;
  }
  const collector = _currentCollector;
  if (!collector.refs) collector.refs = [];
  if (collector.refIndex === undefined) collector.refIndex = 0;
  const idx = collector.refIndex++;
  if (idx >= collector.refs.length) {
    const root = _activeRoot;
    // Hydrating: continue the per-root sequence renderToString used (it
    // restarts at 0 too), so the id matches the server's markup.
    const id = !root
      ? `:r${_nextSsrId()}:`
      : root._ssrIds
      ? `:r${root._idCounter++}:`
      : `:rc${_clientIdCounter++}:`;
    const ref = { current: id };
    collector.refs.push(ref);
    return ref.current;
  }
  return (collector.refs[idx] as { current: string }).current;
}

// ── useOptimistic — optimistic UI during async operations ─────────────

/**
 * Optimistic UI hook. Shows an immediate update while an async action runs,
 * then reverts to the real state when it completes (success or failure).
 *  @tier Advanced */
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
