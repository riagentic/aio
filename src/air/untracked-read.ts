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

/** @internal Name a hook-created signal after its component and slot. */
export function _nameHookSignal(
  sig: object,
  hook: string,
  component: string | undefined,
  slot: number,
): void {
  if (!isDevMode() || _hookSignalNames.has(sig)) return;
  _hookSignalNames.set(sig, `<${component ?? "?"}> ${hook} #${slot + 1}`);
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
        const name = (sig as { _name?: string })._name ??
          cellSignalName(sig) ?? _hookSignalNames.get(sig as object);
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
