// Dev only, observe-only: a controlled control left showing input its handler
// never stored.
//
// `_controlDrifted` (prop-write.ts) re-asserts a controlled `value`/`checked`
// on the next RENDER. A handler that stores nothing — a refusal
// (`if (ok(v)) sig.set(v)`), or a store the renderer cannot see — queues no
// render, so the screen keeps text the state does not hold, and `am surface` /
// `ui.X.value` report it as real. The DOM is never touched here: a debounced
// store (`setTimeout(() => c.setQ(v), 300)`) and a plain-variable draft
// (`value="" onInput={e => draft = …}`) are legitimate apps that a restore
// would eat keystrokes from. Instead, after a handler that
//
//   • started no cell call (`pendingStarted()` — the ack registry and the
//     server executor count every call they start),
//   • returned no promise (it decides later),
//   • is not mid-IME-composition (the text is not final yet),
//
// left the control drifted from the props it last rendered with, it is
// checked again a second later; still drifted and not typed into since, dev
// warns once per element.

import { pendingStarted } from "../protocol/pending-calls.ts";
import { isDevMode } from "../state/dev-flag.ts";
import { _controlDrifted } from "./prop-write.ts";
import { resolveSignalProp } from "./signal-binding.ts";

const _CTRL = Symbol.for("aio.air.controlProps");
type CtrlEl = HTMLElement & { [_CTRL]?: Record<string, unknown> };

/** How long a drifted control may stay drifted before dev says so. */
const DRIFT_WARN_MS = 1000;

/** Remember the props a form control last rendered with (mount, diff, hydrate). */
export function _recordControlled(
  el: HTMLElement,
  props: Record<string, unknown>,
): void {
  const tag = el.tagName;
  if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") return;
  if ("value" in props || "checked" in props) (el as CtrlEl)[_CTRL] = props;
  else delete (el as CtrlEl)[_CTRL];
}

const _EVENTS = new Set(["input", "change", "click"]);
/** Elements with a pending re-check → its timer. A Map, not a WeakMap: an
 *  unmount must find and cancel them (at most one per element, ~1 s). */
const _timers = new Map<CtrlEl, ReturnType<typeof setTimeout>>();
/** Elements mid-composition → "a call started for it" so far. */
const _composing = new WeakMap<CtrlEl, boolean>();
const _warned = new WeakSet<CtrlEl>();

/** Called by the handler wrapper once a handler returned; `started` is
 *  `pendingStarted()` from just before it ran. */
export function _afterHandler(
  e: Event,
  evt: string,
  started: number,
  returned: unknown,
): void {
  if (!_EVENTS.has(evt) || !isDevMode()) return;
  const el = (e.composedPath?.()[0] ?? e.target) as CtrlEl | null;
  if (!el?.[_CTRL] || _warned.has(el)) return;
  // Further input: the clock restarts from this one.
  clearTimeout(_timers.get(el));
  _timers.delete(el);
  const decidedLater = started !== pendingStarted() ||
    typeof (returned as { then?: unknown } | null)?.then === "function";
  if ((e as { isComposing?: boolean }).isComposing) {
    // Chromium fires the COMMITTING input still marked composing, so the
    // check waits for `compositionend`, carrying what this composition's
    // handlers did.
    const had = _composing.get(el);
    _composing.set(el, (had ?? false) || decidedLater);
    if (had === undefined) {
      el.addEventListener("compositionend", () => {
        const later = _composing.get(el) ?? false;
        _composing.delete(el);
        if (!later) queueMicrotask(() => _arm(el));
      }, { once: true });
    }
    return;
  }
  // After the render the handler's own writes queued (a microtask behind it).
  if (!decidedLater) queueMicrotask(() => _arm(el));
}

function _drifted(el: CtrlEl): boolean {
  const props = el[_CTRL];
  if (!props || !el.isConnected) return false;
  return ["value", "checked"].some((k) => {
    if (!Object.hasOwn(props, k)) return false;
    const rv = resolveSignalProp(props[k]);
    // null/undefined is an UNCONTROLLED prop — nothing to drift from.
    return rv != null && _controlDrifted(el, k, rv);
  });
}

function _arm(el: CtrlEl): void {
  if (_timers.has(el) || !_drifted(el)) return;
  _timers.set(
    el,
    setTimeout(() => {
      _timers.delete(el);
      if (_warned.has(el) || !_drifted(el)) return;
      _warned.add(el);
      console.warn(
        `[aio:air] ${_describe(el)}: the handler did not store the typed ` +
          `value, so the screen differs from state. Store it, or drop ` +
          `\`value\` to make the input uncontrolled.`,
      );
    }, DRIFT_WARN_MS),
  );
}

/** Cancel the pending re-checks of the elements under an unmounted root — a
 *  torn-down app has nothing left to warn about, and a live timer outlived it.
 *  Also every DETACHED element's: a portal's content lives outside the root,
 *  and a control an earlier render removed is gone too — neither can warn
 *  (`_drifted` needs `isConnected`), so their timers only outlive the app. */
export function _cancelDriftChecks(root: Node): void {
  for (const [el, t] of _timers) {
    if (!el.isConnected || root.contains?.(el)) {
      clearTimeout(t);
      _timers.delete(el);
    }
  }
}

function _describe(el: CtrlEl): string {
  const tag = el.tagName.toLowerCase();
  for (const a of ["id", "name", "aria-label", "placeholder"]) {
    const v = el.getAttribute(a);
    if (v) return `<${tag} ${a}="${v}">`;
  }
  return `<${tag}>`;
}
