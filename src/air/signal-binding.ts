// Signal-bound attributes: direct Signal→DOM bindings bypassing VDOM diff.
// Used by vdom.ts to create per-prop effects when Signal values are passed as props.

import { effect } from "../state/signal.ts";
import type { Computed, Signal } from "../state/signal.ts";
import { camelToKebab, styleValue } from "./ssr-utils.ts";
// The prop→DOM rule is shared with `applyProps`. It used to be copied here, and
// the copy had no `attrNameOf` mapping and no `k in el` guard: `strokeWidth`
// landed as a literal attribute SVG ignores, and `disabled` on a non-form
// element became an invisible JS expando. Same prop, different DOM, purely
// because the value was a signal.
import {
  _controlDrifted,
  _isControlled,
  _RESERVED_PROPS,
  _setStyleProp,
  _writeProp,
} from "./prop-write.ts";

/** Check if a value is a reactive READ — a Signal or a Computed (duck-typing:
 *  `_subscribers` + `peek`).
 *
 *  `"function"` is accepted alongside `"object"` because a signal IS callable
 *  (`count()` is the same tracked read as `count.value`) — and `typeof` says
 *  "function" for a callable object. This is THE decider for "is this a
 *  signal": every prop binding, child binding and hydration check routes
 *  through it, so an `"object"`-only test would silently reclassify every
 *  signal in the renderer at once.
 *
 *  No `set` requirement. Every consumer here only READS (`.value` in a binding
 *  effect, `.peek()` for SSR and the first paint), and a `computed` answers
 *  both — but it has no `set`, so requiring one sent a computed down the
 *  plain-value path: as a child it died with "A component returned a
 *  function… did you return the component itself", naming the wrong mistake,
 *  and as a prop it was written as the literal text `[object Function]`, on
 *  the client and in SSR alike, with nothing said. The one writer
 *  (`createContext`'s Provider) only ever holds signals it created itself. */
export function isSignal(
  v: unknown,
): v is Signal<unknown> | Computed<unknown> {
  return (
    v !== null &&
    (typeof v === "object" || typeof v === "function") &&
    "_subscribers" in (v as Record<string, unknown>) &&
    "peek" in (v as Record<string, unknown>)
  );
}

const _signalBindingCleanups = new WeakMap<Element, (() => void)[]>();

/** For each Signal prop, create an effect that updates the DOM attribute directly. */
export function bindSignalProps(
  el: HTMLElement,
  props: Record<string, unknown>,
): void {
  const cleanups: (() => void)[] = [];

  const entries = Object.entries(props);
  // A bound `value` binds LAST on an <input>, as applyProps writes it last:
  // the browser clamps a range value against the min/max/step it has at
  // assignment, so `value={v} max={m}` bound in source order mounted at 100.
  // Effects run on creation, so binding order is write order.
  if (el.tagName === "INPUT") {
    const vi = entries.findIndex(([k]) => k === "value");
    if (vi >= 0) entries.push(entries.splice(vi, 1)[0]!);
  }
  for (const [k, v] of entries) {
    if (_RESERVED_PROPS.has(k)) continue;

    if (isSignal(v)) {
      const sig = v as Signal<unknown>;
      // `prev` lets a style OBJECT retire the declarations it dropped, exactly
      // as the diff path does — the old copy cleared `cssText` wholesale.
      let prev: unknown;
      const dispose = effect(() => {
        const val = sig.value;
        // A controlled prop already showing `val` is not rewritten: assigning
        // an <input>'s `value` its own string still moves the caret to the end
        // in every browser, and the effect re-runs for reasons the user did not
        // cause. Same rule as the diff path, same decider.
        if (_isControlled(el, k) && !_controlDrifted(el, k, val)) {
          prev = val;
          return;
        }
        _writeProp(el, k, val, prev);
        prev = val;
      });
      cleanups.push(dispose);
    } else if (k === "style" && typeof v === "object" && v !== null) {
      // Style object may contain signal values per-property
      for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
        if (isSignal(sv)) {
          const sig = sv as Signal<unknown>;
          // The SAME name rule as the static path (`camelToKebab`): an inline
          // camel→kebab here lowercased a `--rowGap` custom property (they are
          // case-sensitive, so the declaration named a different variable)
          // and turned `msTransform` into `ms-transform`, which no engine reads.
          const styleProp = camelToKebab(sk);
          const dispose = effect(() => {
            const val = sig.value;
            _setStyleProp(
              el.style,
              styleProp,
              val == null ? "" : styleValue(sk, val),
            );
          });
          cleanups.push(dispose);
        }
      }
    }
  }

  // Always dispose old bindings first (AIO-88: even when no new signal props,
  // old effects must be stopped to prevent stale DOM updates)
  cleanupSignalBindings(el);
  if (cleanups.length > 0) {
    _signalBindingCleanups.set(el, cleanups);
  }
}

/** Re-assert the CONTROLLED props (`value`, `checked`) whose value is a Signal.
 *
 *  `applyProps` skips every signal-valued prop because this module owns it —
 *  but what this module owns it through is an EFFECT, and an effect runs when
 *  the SIGNAL changes. The user typing into `<input value={sig}>` changes the
 *  DOM, not the signal; when the handler then refuses the input (a cap, a
 *  validator, a cell that declined the write) nothing in the system has a
 *  reason to run, and the element keeps showing a value the state rejected —
 *  permanently, and reported as real by `am surface` and `ui.X.value`.
 *
 *  The diff calls this once per render, which is the same moment the plain-value
 *  path re-asserts in `applyProps`. Drifted-only, so an accepted keystroke never
 *  moves a caret; `peek()` so a render never subscribes to the signal.
 *
 *  `<select value={sig}>` is re-asserted here too and AGAIN by
 *  `applyChildDependentProps` after the children are in place — the write only
 *  lands once the matching `<option>` exists. */
export function reassertControlledSignalProps(
  el: HTMLElement,
  props: Record<string, unknown>,
): void {
  for (const k of _CONTROLLED_PROPS) {
    const v = props[k];
    if (!isSignal(v)) continue;
    const rv = (v as Signal<unknown>).peek();
    if (!_controlDrifted(el, k, rv)) continue;
    _writeProp(el, k, rv);
  }
}

/** The props a user can move behind the reconciler's back — `_isControlled`
 *  answers for an element, this is the key set to LOOK for. */
const _CONTROLLED_PROPS = ["value", "checked"] as const;

/** Dispose all signal-binding effects for an element.
 *
 *  Every cleanup runs, and the registry entry goes, even when one throws. An
 *  unguarded loop left the REMAINING bindings of a removed element live — each
 *  still subscribed, each still writing to a node that is no longer in the
 *  document — and skipped the `delete`, so the element and its whole closure
 *  chain stayed reachable from the map for the life of the page. A leak and a
 *  set of writes into nowhere, from one throwing disposer. */
export function cleanupSignalBindings(el: Element): void {
  const cleanups = _signalBindingCleanups.get(el);
  if (cleanups) {
    // Deleted FIRST: whatever happens below, this element is not coming back,
    // and a re-entrant cleanup must not find the same list again.
    _signalBindingCleanups.delete(el);
    for (const fn of cleanups) {
      try {
        fn();
      } catch (e) {
        console.error(
          "[aio-renderer] a signal binding threw while being disposed (the " +
            "element's other bindings were still disposed):",
          e,
        );
      }
    }
  }
}

/** Resolve a signal to its current value without tracking (for initial render). */
export function resolveSignalProp(v: unknown): unknown {
  return isSignal(v) ? (v as Signal<unknown>).peek() : v;
}
