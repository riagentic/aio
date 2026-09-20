// The trap that shipped three times in one codebase, by an author who knew it.
//
// THE RULE, which is correct and load-bearing: a component subscribes only to
// what its RENDER BODY touches (docs/ui/reactivity-tracking.md).
//
// THE FAILURE MODE, which is what makes it expensive: reading a cell inside
// `afterRender` or `onMount` subscribes to NOTHING. The effect runs once and
// never again. Types pass. `aiol` passes. The code looks right. The feature
// works exactly once, and then reports itself as "it works sometimes".
//
// The evidence that this is a design issue and not a discipline one: one
// codebase shipped it three times, in three features, by an author who had
// written the comment explaining it into two of the earlier ones and read both
// while writing the third. Their words: "Understanding the rule is not enough,
// because nothing on the failing path mentions it." And: "That single line
// would have prevented two user-visible bugs this week. It is the one change I
// would make to aio before any other."
//
// It is decidable at runtime, which is why it can be a warning rather than a
// doc: the runtime already knows the render-time read set, and already knows
// when it is running an effect callback. Comparing the two is the whole thing.
//
// Dev only, once per (component, signal) pair, and it changes no behaviour —
// the read still subscribes to nothing, exactly as before. It just says so.
import { _trackEnd, _trackStart, untrack } from "../state/signal.ts";
import { isDevMode } from "../state/dev-flag.ts";
import { cellSignalName } from "../state/state-signals.ts";

const _said = new Set<string>();

/** Dev-only names for the signals a hook created, so an unnamed `useLocal`
 *  is reported as `<Row> useLocal #2` rather than "a cell/signal value" —
 *  which left a field report bisecting to find which one (wallet report §8). */
const _hookSignalNames = new WeakMap<object, string>();

/** Per instance (keyed by its ref-slot array, which lives as long as the
 *  instance does), how many signals each hook kind has named so far. */
const _hookOrdinals = new WeakMap<object, Map<string, number>>();

/** @internal Name a hook-created signal after its component and its ORDINAL
 *  among that component's hooks of the same kind — the 2nd `useLocal` is
 *  `useLocal #2` whatever `useRef`/`useSignal` calls sit between. The shared
 *  ref slot (`slot`) numbered it `#4`, which is no count a reader can make.
 *  `owner` is the instance's ref array; without one the slot is used. A
 *  signal is named once, on the render that creates it, so the count only
 *  ever grows in call order. */
export function _nameHookSignal(
  sig: object,
  hook: string,
  component: string | undefined,
  slot: number,
  owner?: object,
): void {
  if (!isDevMode() || _hookSignalNames.has(sig)) return;
  let n = slot + 1;
  if (owner) {
    let counts = _hookOrdinals.get(owner);
    if (!counts) _hookOrdinals.set(owner, counts = new Map());
    n = (counts.get(hook) ?? 0) + 1;
    counts.set(hook, n);
  }
  _hookSignalNames.set(sig, `<${component ?? "?"}> ${hook} #${n}`);
}

/** A signal's name for a DEV MESSAGE — one decider, so every diagnostic calls
 *  the same signal the same thing: its explicit `signal(value, "name")`, else
 *  the cell it belongs to, else the hook and ordinal that created it
 *  (`<Row> useLocal #2`). Null when it has no name to give, which is the one
 *  case a message must handle by asking for one. @internal */
export function _signalLabel(sig: unknown): string | undefined {
  return (sig as { _name?: string })?._name ??
    cellSignalName(sig) ?? _hookSignalNames.get(sig as object);
}

/** While `fn` runs, give every NESTED `dispatchEvent` its own untracked frame.
 *
 *  `dispatchEvent` runs listeners synchronously, so a `resize` fired from one
 *  component's `afterRender` ran every OTHER component's listener inside this
 *  hook's frame — and their reads were reported as this hook's, with advice
 *  ("read it in the render body") that cannot be followed for a signal
 *  another instance owns (wallet report §8). A listener is not the callback: what
 *  it reads is its own component's business.
 *
 *  Patched where `dispatchEvent` is owned — the window of the realm the
 *  component renders into, its `EventTarget.prototype`, and the global one
 *  (the realms differ under happy-dom) — and restored in `finally` — so it exists only for the duration of a dev
 *  lifecycle callback. The frame is a throwaway, exactly as outside dev a
 *  lifecycle callback has none, so no subscription changes. */
function isolateNestedDispatch(el: unknown): () => void {
  const view = (el as { ownerDocument?: { defaultView?: unknown } } | null)
    ?.ownerDocument?.defaultView as { EventTarget?: unknown } | undefined;
  const restores: (() => void)[] = [];
  const seen = new Set<object>();
  // The window object too: happy-dom binds `dispatchEvent` as an OWN property
  // of each window, so patching the prototype alone missed `window.dispatchEvent`.
  const starts = [
    view,
    (view?.EventTarget as { prototype?: object } | undefined)?.prototype,
    globalThis.EventTarget?.prototype,
  ];
  for (const start of starts) {
    let proto = start as object | null | undefined;
    while (proto && !Object.hasOwn(proto, "dispatchEvent")) {
      proto = Object.getPrototypeOf(proto);
    }
    if (!proto || seen.has(proto)) continue;
    seen.add(proto);
    const owner = proto as { dispatchEvent: (ev: unknown) => boolean };
    const orig = owner.dispatchEvent;
    if (typeof orig !== "function") continue;
    owner.dispatchEvent = function (this: unknown, ev: unknown): boolean {
      return untrack(() => orig.call(this, ev));
    };
    restores.push(() => owner.dispatchEvent = orig);
  }
  return () => {
    for (let i = restores.length - 1; i >= 0; i--) restores[i]!();
  };
}

/**
 * Run `fn` as a lifecycle callback, and warn about any reactive read it makes
 * that the component's render body did not.
 *
 * `renderDeps` is the instance's render-time dependency set. A read INSIDE it
 * is fine — the component re-renders when that changes, and the callback runs
 * again with it. A read outside it is the trap.
 *
 * Outside dev this is `fn()` and nothing else.
 */
export function runTrackedLifecycle(
  hook: "afterRender" | "onMount",
  component: string | undefined,
  renderDeps: Set<unknown> | null | undefined,
  fn: () => unknown,
  /** An element of the tree being rendered — names the DOM realm whose
   *  `dispatchEvent` a nested listener arrives through. */
  el?: unknown,
): unknown {
  _lifecycleDepth++;
  _hookStack.push(hook);
  try {
    return runTracked(hook, component, renderDeps, fn, el);
  } finally {
    _hookStack.pop();
    _lifecycleDepth--;
  }
}

/** The lifecycle callbacks currently on the stack, innermost last.
 *
 *  SEPARATE from `_lifecycleDepth` on purpose. That depth decides the burst
 *  tripwire's CANDIDACY (an event handler fired from inside a lifecycle
 *  callback is not input), and `onCleanup` must not change that. This stack
 *  only NAMES the writer for the message, and there `onCleanup` matters: a
 *  cleanup that writes state — clearing a selection as its row unmounts — runs
 *  with a render on the stack and no render body executing, so the tripwire
 *  called it "a render WRITING state that the same render READS" and sent the
 *  author looking for a write that was not there (a field report). */
const _hookStack: string[] = [];

/** Run `fn` marked as `hook`, for the message only — no read tracking, no
 *  effect on `_inLifecycleCallback`. @internal */
export function _withLifecycleHook<T>(hook: string, fn: () => T): T {
  _hookStack.push(hook);
  try {
    return fn();
  } finally {
    _hookStack.pop();
  }
}

/** @internal The innermost lifecycle callback running, or null. */
export function _currentLifecycleHook(): string | null {
  return _hookStack.length > 0 ? _hookStack[_hookStack.length - 1]! : null;
}

/** How many lifecycle callbacks (`onMount`/`afterRender`) are on the stack.
 *  Read by the dev render-burst tripwire: a write made by an event handler is
 *  INPUT and exempt — unless the handler was fired from INSIDE one of these,
 *  where `afterRender(() => btn.click())` is the render writing what it read,
 *  one step removed. The exemption belongs to a handler that is the
 *  OUTERMOST frame, never to one a render started. */
let _lifecycleDepth = 0;

/** @internal Is an `onMount`/`afterRender` callback on the stack? */
export function _inLifecycleCallback(): boolean {
  return _lifecycleDepth > 0;
}

function runTracked(
  hook: "afterRender" | "onMount",
  component: string | undefined,
  renderDeps: Set<unknown> | null | undefined,
  fn: () => unknown,
  el?: unknown,
): unknown {
  if (!isDevMode()) return fn();
  // A throwaway frame: pushing it does not create subscriptions (nothing
  // consumes the set), so behaviour is identical — it only makes the reads
  // observable. Popping in `finally` keeps the stack balanced even if the
  // callback throws, which `_trackEnd` treats as an internal invariant.
  const seen = _trackStart();
  const restoreDispatch = isolateNestedDispatch(el);
  try {
    return fn();
  } finally {
    restoreDispatch();
    _trackEnd(seen);
    if (renderDeps) {
      for (const sig of seen) {
        if (renderDeps.has(sig)) continue;
        const name = _signalLabel(sig);
        const where = component ? `<${component}>` : "a component";
        const key = `${hook}|${where}|${name ?? "?"}`;
        if (_said.has(key)) continue;
        _said.add(key);
        console.warn(
          `[aio-dev] ${
            name ? `\`${name}\`` : "a cell/signal value"
          } was read inside ${hook} in ${where}, but NOT during its render. ` +
            `A component subscribes only to what its render body touches, so ` +
            `${where} will not re-render when this changes and ${hook} will ` +
            `run once and never again — the feature works exactly once and ` +
            `then reports itself as "it works sometimes". Read it in the ` +
            `render body and close over the value. ` +
            `(docs/ui/reactivity-tracking.md)`,
        );
      }
    }
  }
}

/** @internal Test seam. */
export function _resetUntrackedReadWarnings(): void {
  _said.clear();
}
