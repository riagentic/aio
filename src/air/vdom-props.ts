// VDOM prop application — event wiring, prop diffing and the deferred
// child-dependent props. The prop→DOM write itself lives in prop-write.ts, which
// the signal binder shares: one rule, two callers.

import {
  isSignal,
  reassertControlledSignalProps,
  resolveSignalProp,
} from "./signal-binding.ts";
import {
  _attrNS,
  _classProp,
  _controlDrifted,
  _propAttr,
  _RESERVED_PROPS,
  _writeProp,
} from "./prop-write.ts";
import { attrNameOf as _attrName } from "./ssr-utils.ts";
import { _DOM_PROPS } from "./vdom-types.ts";
import { isDevMode } from "../state/dev-flag.ts";
import {
  _CHANGE_TARGETS,
  _DELEGATED_EVENTS,
  _deleteWrapped,
  _ensureDelegation,
  _getActiveDelegationRoot,
  _getWrapped,
  _mapEventName,
  _setWrapped,
  _wrapHandler,
} from "./vdom-events.ts";

// ── Child-dependent props ─────────────────────────────────────────────

/** True for props whose write only LANDS once the element's children exist.
 *
 *  `<select>.value` picks the matching `<option>`. Assigned while the select is
 *  still empty the assignment is discarded outright, and the control keeps
 *  showing its first entry. Both commit paths apply props BEFORE the children
 *  are there — `createDom` builds children after `applyProps`, `_diffElement`
 *  diffs them after it — so a controlled `<select value={s.picked}>` rendered
 *  the WRONG option on its first paint and after any render that created its
 *  options in the same pass. That is every controlled select there is: the
 *  options and the value always arrive together on mount. Silent, too — the DOM
 *  is well-formed, it just shows a different choice than the state holds.
 *
 *  `applyProps` skips exactly these keys and every commit path calls
 *  {@link applyChildDependentProps} once its children are in place, so the rule
 *  "when does this prop get written" has ONE decider. */
function _isChildDependent(el: HTMLElement, k: string): boolean {
  return k === "value" && el.tagName === "SELECT";
}

/** Apply the props {@link _isChildDependent} deferred — call AFTER children are
 *  built/diffed/hydrated. Skips only when the LIVE element already shows the
 *  value (see {@link _controlDrifted}), never on "the vnode said the same thing
 *  last time" — a `<select>` the user changed and the cell REFUSED kept the
 *  user's choice on screen forever. */
export function applyChildDependentProps(
  el: HTMLElement,
  next: Record<string, unknown>,
  prev: Record<string, unknown>,
): void {
  if (el.tagName !== "SELECT") return;
  if (!("value" in next)) {
    // deno-lint-ignore no-explicit-any
    if ("value" in prev) (el as any).value = "";
    return;
  }
  // A SIGNAL value is read here too, untracked. It used to return early
  // ("the signal binding owns it") — but that binding's effect only runs when
  // the SIGNAL changes, and a user picking a different <option> changes the
  // DOM, not the signal. `<select value={sig}>` whose handler refused the
  // choice therefore kept showing the refused option forever, while the exact
  // same select bound to plain state corrected itself on the next render.
  const raw = next.value;
  const rv = resolveSignalProp(raw);
  if (!_controlDrifted(el, "value", rv)) return;
  // deno-lint-ignore no-explicit-any
  (el as any).value = rv ?? "";
}

// `_isControlled`/`_controlDrifted` live in prop-write.ts — the leaf both prop
// paths share. The signal binder needs the SAME decider (see
// `reassertControlledSignalProps`), and a second copy here is how `value={sig}`
// and `value={s.x}` would start behaving differently again.

// ── applyProps ────────────────────────────────────────────────────────

export function applyProps(
  el: HTMLElement,
  next: Record<string, unknown>,
  prev: Record<string, unknown>,
): void {
  // AIO-166: detect onChange+onInput collision on form elements. A FUNCTION,
  // not a key: `onInput={cond ? f : undefined}` is the ordinary way to attach
  // a handler conditionally, and `"onInput" in next` counted the undefined as
  // present — flipping `onChange` to native `change` (fires on blur) for a
  // component that has no onInput at all.
  const _hasOnInput = typeof next.onInput === "function" &&
    _CHANGE_TARGETS.has(el.tagName);
  const _hadOnInput = typeof prev.onInput === "function" &&
    _CHANGE_TARGETS.has(el.tagName);
  // The event `onChange` was REGISTERED under last time — read now, before the
  // `type` write below can change the answer (`el.type` is an input to it).
  const prevChangeEvt = typeof prev.onChange === "function"
    ? _mapEventName("change", el, _hadOnInput)
    : null;
  // Two props, one attribute — the write below is last-wins; dev says so.
  if (isDevMode()) _classProp(next);

  // Remove old props not in next
  for (const k of Object.keys(prev)) {
    if (_RESERVED_PROPS.has(k)) continue;
    if (!(k in next)) {
      if (k.startsWith("on")) {
        // The name it was registered UNDER (prev's context) — not the name
        // next's props would give it.
        const evt = k === "onChange" && prevChangeEvt
          ? prevChangeEvt
          : _mapEventName(k.slice(2).toLowerCase(), el);
        _dropListener(el, evt, prev[k] as EventListener);
      } else if (k === "className") {
        el.removeAttribute("class");
      } else if (k === "style") {
        el.removeAttribute("style");
      } else if (k === "dangerouslySetInnerHTML") {
        el.innerHTML = ""; // AIO-80: clear stale innerHTML
      } else if (k in el && _DOM_PROPS.has(k)) {
        if (_isChildDependent(el, k)) continue; // applyChildDependentProps
        // Removing the prop must leave the element at its DEFAULT, and for a
        // property that reads through its content attribute, clearing the
        // property is not that. A checkbox's `.value` answers `"on"` only while
        // it has no `value` attribute — so `<input type="checkbox" value="a">`
        // losing its `value` prop reported `""` (and, on a hydrated page, the
        // stale server value), while a fresh render of the same model reported
        // `"on"`. The form then submitted a value the component no longer
        // describes, with nothing in the DOM to show it. Drop the attribute the
        // prop wrote. The property is reset FIRST and the attribute dropped
        // after: on a checkbox the property write itself REFLECTS back into the
        // attribute, so clearing them the other way round just puts it back.
        // deno-lint-ignore no-explicit-any
        (el as any)[k] = typeof (el as any)[k] === "boolean" ? false : "";
        const attr = _propAttr(el.tagName.toLowerCase(), k);
        if (attr) el.removeAttribute(attr);
      } else {
        const ns = _attrNS(k);
        if (ns) el.removeAttributeNS(ns, k.slice(k.indexOf(":") + 1));
        // The SAME name mapping the write used. `_writeProp` sets
        // `strokeWidth` as `stroke-width`, so removing the raw JSX key took
        // an attribute that was never there and left the real one on the
        // element forever — an incremental diff that does not converge on
        // what a fresh render produces, silently, for all 41 mapped SVG
        // names. (The `v == null` path already went through the mapper;
        // only key-absent-from-next was wrong.)
        else el.removeAttribute(_attrName(k));
      }
    }
  }

  // `type` FIRST, whatever order the JSX wrote it in. Every other prop on an
  // <input> is interpreted through its type: `onChange` is remapped to
  // `input` unless the type says `change` is the real event (a file picker),
  // and the browser sanitizes `value` against the type it has at assignment.
  // Props are applied in source order, so `<input onChange={f} type="file">`
  // wired `f` to `input` — the element still said `type="text"` when the
  // handler was mapped — while `<input type="file" onChange={f}>` wired it to
  // `change`. Two orderings of the same props, two different elements, and
  // the first one's handler "simply never fired" under `testUI`. One rule:
  // the type is set before anything that depends on it.
  const nextType = next.type;
  if (
    typeof nextType === "string" && el.tagName === "INPUT" &&
    prev.type !== nextType
  ) {
    _writeProp(el, "type", nextType, prev.type);
  }

  // Set new/changed props. `onChange` goes LAST: its event name depends on
  // whether `onInput` is present, and the two share the `input` slot in the
  // per-element listener map, so whichever is written second wins the slot.
  // With `onChange` last it can see the slot `onInput` just took and not
  // delete it while moving itself out of the way.
  const entries = Object.entries(next);
  const ci = entries.findIndex(([k]) => k === "onChange");
  if (ci >= 0 && ci < entries.length - 1) {
    entries.push(entries.splice(ci, 1)[0]!);
  }
  for (const [k, v] of entries) {
    if (_RESERVED_PROPS.has(k)) continue;
    if (k === "type" && nextType === v && el.tagName === "INPUT") continue;
    const rv = resolveSignalProp(v);
    if (isSignal(v)) continue; // Signal binding handles ongoing updates via effect
    // An `onChange` whose EVENT NAME moved — `onInput` arrived or left beside
    // it, or the input's `type` changed — is a different registration even
    // when the handler is the same function. The identity skip used to keep
    // it under the old name: with `onInput` added next to a stable `onChange`
    // the new `input` entry overwrote it and the change handler never fired
    // again; with `onInput` removed the handler stayed on native `change` and
    // fired on blur instead of per keystroke. Silent both ways.
    const changeMoved = k === "onChange" && prevChangeEvt !== null &&
      typeof rv === "function" &&
      prevChangeEvt !== _mapEventName("change", el, _hasOnInput);
    // The last vnode is not evidence about a CONTROLLED prop — the user may
    // have moved it since. See _controlDrifted.
    if (!changeMoved && prev[k] === rv && !_controlDrifted(el, k, rv)) {
      continue;
    }

    if (k.startsWith("on")) {
      const evt = _mapEventName(
        k.slice(2).toLowerCase(),
        el,
        k === "onChange" ? _hasOnInput : undefined,
      );
      // Retire the registration under the OLD name — unless that slot is
      // `input` and `onInput` now owns it (it was written before this, see
      // the ordering above); then there is nothing of ours left there.
      if (changeMoved && !(prevChangeEvt === "input" && _hasOnInput)) {
        _dropListener(el, prevChangeEvt!, prev[k] as EventListener);
      }
      // AIO-106: null/false handler = removal only, don't wrap non-function
      if (rv == null || rv === false) {
        if (!_DELEGATED_EVENTS.has(evt)) {
          const oldWrapped = _getWrapped(el, evt);
          if (oldWrapped) el.removeEventListener(evt, oldWrapped);
          else if (prev[k]) {
            el.removeEventListener(evt, prev[k] as EventListener);
          }
        }
        _deleteWrapped(el, evt);
        continue;
      }
      // One wrapper for both paths (vdom-events.ts): signal writes batched
      // into a single render, and a throwing handler contained + reported.
      const wrapped = _wrapHandler(rv as EventListener, evt);
      const delegationRoot = _getActiveDelegationRoot();
      if (_DELEGATED_EVENTS.has(evt) && delegationRoot) {
        // Delegated: store in lookup map — root listener dispatches via composedPath
        _ensureDelegation(delegationRoot, evt);
        _setWrapped(el, evt, wrapped, delegationRoot);
      } else {
        // Non-delegated (focus, blur, scroll, etc.): per-element listener
        const oldWrapped = _getWrapped(el, evt);
        if (oldWrapped) el.removeEventListener(evt, oldWrapped);
        else if (prev[k]) el.removeEventListener(evt, prev[k] as EventListener);
        el.addEventListener(evt, wrapped);
        _setWrapped(el, evt, wrapped);
      }
    } else if (!_isChildDependent(el, k)) {
      // A style OBJECT may itself hold per-property signals; those are driven
      // by their own effects (bindSignalProps) and must not be written here.
      const value = (k === "style" && rv && typeof rv === "object")
        ? _withoutSignals(rv as Record<string, unknown>)
        : rv;
      const before = (k === "style" && prev[k] && typeof prev[k] === "object")
        ? _withoutSignals(prev[k] as Record<string, unknown>)
        : prev[k];
      _writeProp(el, k, value, before);
    }
  }

  // Signal-valued props were skipped above ("the binding owns them"), but that
  // binding is an EFFECT: it fires when the signal changes and never otherwise,
  // so a controlled input the user moved and the handler refused has no path
  // back to the state's value at all. This is the diff's per-render hook, so
  // the re-assert happens here — the decider is shared, not copied.
  reassertControlledSignalProps(el, next);
}

/** Retire the listener registered under `evt` — delegated (map entry, plus
 *  the per-element fallback AIO-154 may have added) or per-element. */
function _dropListener(
  el: HTMLElement,
  evt: string,
  prevHandler: EventListener | undefined,
): void {
  const wrapped = _getWrapped(el, evt);
  if (_DELEGATED_EVENTS.has(evt)) {
    if (wrapped) el.removeEventListener(evt, wrapped);
  } else {
    const fallback = wrapped ?? prevHandler;
    if (fallback) el.removeEventListener(evt, fallback);
  }
  _deleteWrapped(el, evt);
}

/** A style object with its signal-valued declarations dropped — those have
 *  their own effects and writing their peeked value here would fight them. */
function _withoutSignals(o: Record<string, unknown>): Record<string, unknown> {
  let has = false;
  for (const v of Object.values(o)) {
    if (isSignal(v)) {
      has = true;
      break;
    }
  }
  if (!has) return o;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!isSignal(v)) out[k] = v;
  return out;
}

// ── Signal prop change detection ──────────────────────────────────────

/** Check if any signal prop identity changed between old and new props. */
export function _hasSignalPropChange(
  next: Record<string, unknown>,
  prev: Record<string, unknown>,
): boolean {
  for (const [k, v] of Object.entries(next)) {
    if (isSignal(v) && v !== prev[k]) return true;
  }
  for (const [k, v] of Object.entries(prev)) {
    if (isSignal(v) && !isSignal(next[k])) return true;
  }
  return false;
}
