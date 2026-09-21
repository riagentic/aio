// The ONE rule for "this prop becomes this DOM mutation".
//
// Deciding whether a prop is a class, a style, a DOM property or an attribute —
// and under which NAME and namespace it lands — used to be written twice: once
// in `applyProps` (vdom-props.ts, the diff/mount path) and once in `_applyProp`
// (signal-binding.ts, the path a Signal-valued prop takes). The copies drifted,
// so the SAME prop rendered differently depending on whether its value happened
// to be a signal:
//
//   strokeWidth={2}        → stroke-width="2"   (the attribute SVG reads)
//   strokeWidth={sig}      → strokeWidth="2"    (an attribute nothing reads)
//   disabled={true} on div → disabled="true"
//   disabled={sig}  on div → nothing at all — a JS expando on the element
//
// All silent, and invisible to any test that only exercises one of the two. The
// rule lives here now; both callers apply it and neither owns a variant.
//
// Leaf module by design: vdom-types.ts + ssr-utils.ts only, so both the prop
// patcher and the signal binder can reach it without a cycle.

import {
  attrNameOf as _attrName,
  camelToKebab as _camelToKebab,
  resolveClassName as _resolveClassName,
  styleValue as _styleValue,
} from "./ssr-utils.ts";
import { _devWarn, _DOM_PROPS } from "./vdom-types.ts";

// SVG namespaced attribute prefixes — require setAttributeNS/removeAttributeNS
// so the attr lands in the correct namespace. Plain setAttribute puts it in the
// null namespace, which xlink: consumers (e.g. <use xlink:href>) won't resolve.
const _XLINK_NS = "http://www.w3.org/1999/xlink";
const _XML_NS = "http://www.w3.org/XML/1998/namespace";

/** Props that are NEVER an attribute or a DOM property: framework metadata and
 *  escape hatches whose effect is applied somewhere else. `t` in particular is
 *  the SEMANTIC marker that `testUI` and `am surface` read off the component
 *  tree — it must not reach the DOM at all.
 *
 *  This list was written out three times (the diff patcher, the signal binder,
 *  the SSR writer) and they disagreed: the signal binder had no `t`, so
 *  `t={someSignal}` leaked the marker into the markup that plain `t="…"` and
 *  SSR both keep out. */
export const _RESERVED_PROPS: ReadonlySet<string> = new Set([
  "key",
  "children",
  "ref",
  "use",
  "t",
]);

/** Which of `class` / `className` owns the element's class, or `null` when the
 *  props have neither.
 *
 *  They are ONE DOM fact spelled two ways, and the two render paths disagreed
 *  about it: `_writeProp` is last-write-wins (the later key in insertion order
 *  wins), while the SSR writer emitted BOTH — invalid HTML, where the parser
 *  keeps the FIRST. So `<div {...rest} className={cx}>` with a `class` in
 *  `rest` shipped one class from SSR and the opposite one from mount, for the
 *  same vnode, with nothing said about it. Two props owning one fact is
 *  exactly what rule #1 (fail loud) exists for: dev now names it. */
export function _classProp(
  props: Record<string, unknown>,
): "class" | "className" | null {
  let winner: "class" | "className" | null = null;
  let both = 0;
  for (const k of Object.keys(props)) {
    if (k === "class" || k === "className") {
      winner = k;
      both++;
    }
  }
  if (both > 1) {
    _devWarn(
      "dual-class-prop",
      `A component passes BOTH \`class\` and \`className\` — they are the same ` +
        `DOM attribute, so \`${winner}\` (the later one) wins and the other is ` +
        `dropped. Pass one.`,
    );
  }
  return winner;
}

/** The CONTENT ATTRIBUTE that expresses a `_DOM_PROPS` prop on a given tag:
 *  the attribute's name, `null` when markup has no way to express it, or
 *  `undefined` when the prop is not a DOM property at all.
 *
 *  A DOM property and its attribute are two different things and the mapping is
 *  neither identity nor mechanical — `readOnly` is spelled `readonly`,
 *  `defaultValue`/`defaultChecked` ARE the `value`/`checked` attributes,
 *  `indeterminate` has no attribute, and a `<textarea>`/`<select>` has no
 *  `value` attribute (their value is child text / a selected `<option>`).
 *
 *  Two callers need that answer and used to guess it separately: the SSR writer
 *  emitted the JSX name verbatim (shipping `defaultValue="…"`, attributes no
 *  browser reads) and `applyProps` cleared a removed prop by resetting the
 *  PROPERTY only — which is not the same as removing it whenever the property
 *  reads through its attribute. `<input type="checkbox" value="a">` losing its
 *  `value` prop kept `value=""` and reported `""`, where a fresh render of the
 *  same model reports the checkbox default `"on"`: the form submitted a value
 *  the component no longer describes. One question, one answer. */
const _DOM_PROP_ATTR: Readonly<Record<string, string | null>> = {
  value: "value",
  checked: "checked",
  selected: "selected",
  disabled: "disabled",
  readOnly: "readonly",
  multiple: "multiple",
  indeterminate: null, // property-only — no content attribute exists
  defaultValue: "value",
  defaultChecked: "checked",
};

/** Tags on which the prop has no content attribute at all, whatever its name. */
const _NO_ATTR_ON: Readonly<Record<string, ReadonlySet<string>>> = {
  value: new Set(["textarea", "select"]),
  defaultValue: new Set(["textarea", "select"]),
};

export function _propAttr(
  tag: string,
  k: string,
): string | null | undefined {
  if (!_DOM_PROPS.has(k)) return undefined;
  if (_NO_ATTR_ON[k]?.has(tag)) return null;
  return _DOM_PROP_ATTR[k] ?? null;
}

// ── The attribute NAME rule — one decider for every render path ───────
//
// `setAttribute` refuses a name that is not an XML `Name`: the client path
// throws `InvalidCharacterError` on `<div {...{"x onload=alert(1)": 1}}>` and
// nothing reaches the document. The SSR writers asked nothing and pasted the
// key straight into the tag, so the SAME vnode that throws in the browser
// shipped `<div x onload=alert(1)="1">` from the server — markup an HTML
// parser reads as an `onload` handler. A prop name built from untrusted data
// (a spread of a parsed query string, a CMS field, a user's own object) was
// therefore script injection on the server and a hard error on the client.
//
// So the rule is written ONCE, here in the module that already owns "this prop
// becomes this DOM mutation", and both sides call it — the SSR writer before
// it emits, `_writeProp` before it calls `setAttribute`. A second copy of the
// predicate beside the DOM's own is how the two paths drift apart again; this
// regex IS the production `setAttribute` enforces, so they cannot.

/** The XML `Name` production (XML 1.0 5th ed.) — the rule the DOM spec points
 *  `setAttribute` at, so this predicate and the browser cannot disagree.
 *  Colons are legal: `xlink:href` and `xml:lang` are namespaced attributes aio
 *  writes on purpose. Built from the two character sets rather than one long
 *  literal so the START set is stated once. */
const _NAME_START = "A-Z_a-z:" +
  "\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF" +
  "\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF" +
  "\\uF900-\\uFDCF\\uFDF0-\\uFFFD";
/** What a name may CONTINUE with, on top of {@linkcode _NAME_START}. */
const _NAME_CHAR = ".0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040\\-";
const _VALID_ATTR_NAME = new RegExp(
  `^[${_NAME_START}][${_NAME_START}${_NAME_CHAR}]*$`,
);

/** Whether `name` can be an attribute name at all. */
export function _isAttrName(name: string): boolean {
  return _VALID_ATTR_NAME.test(name);
}

/** Refuse an attribute name no document can hold, naming it and the element
 *  that carried it. Throws on BOTH sides — the server must not be the
 *  permissive one, because the server is the one that writes raw markup. */
export function _assertAttrName(name: string, where: string): void {
  if (_isAttrName(name)) return;
  throw new Error(
    `[aio] <${where || "?"}> was given the prop ${JSON.stringify(name)}, ` +
      `which is not a legal attribute name. An attribute name may not ` +
      `contain spaces, quotes, "=", "<" or "/", and may not start with a ` +
      `digit or "-". Emitting it would write raw HTML into the page, so it ` +
      `is refused on the server exactly as setAttribute refuses it in the ` +
      `browser. Check the object being spread into this element's props.`,
  );
}

/** The namespace an attribute name belongs to, or null for the default one. */
export function _attrNS(k: string): string | null {
  if (k.startsWith("xlink:")) return _XLINK_NS;
  if (k.startsWith("xml:")) return _XML_NS;
  return null;
}

/**
 * Write one already-resolved prop value onto an element.
 *
 * `prev` is the value this prop last held (undefined when unknown) and is used
 * only to retire stale style declarations — every other branch is a full write.
 * Event props are NOT handled here: listener bookkeeping belongs to whoever
 * owns the element's lifecycle.
 */
export function _writeProp(
  el: HTMLElement,
  k: string,
  v: unknown,
  prev?: unknown,
): void {
  if (k === "className") {
    const cls = _resolveClassName(v);
    if (cls) el.setAttribute("class", cls);
    else el.removeAttribute("class");
    return;
  }
  if (k === "style") {
    if (typeof v === "string") {
      el.style.cssText = v;
      return;
    }
    if (typeof v === "object" && v !== null) {
      const style = el.style;
      const newStyle = v as Record<string, unknown>;
      const prevIsString = typeof prev === "string";
      const oldStyle: Record<string, unknown> = prevIsString
        ? {}
        : ((prev as Record<string, unknown>) ?? {});
      // AIO-163: if old style was a string, clear all before applying object
      if (prevIsString) {
        style.cssText = "";
      } else {
        for (const sk of Object.keys(oldStyle)) {
          if (!(sk in newStyle)) style.removeProperty(_camelToKebab(sk));
        }
      }
      for (const [sk, sv] of Object.entries(newStyle)) {
        if (oldStyle[sk] !== sv) {
          style.setProperty(_camelToKebab(sk), _styleValue(sk, sv));
        }
      }
      return;
    }
    // AIO-170: a null/false style clears everything.
    //
    // Removing the ATTRIBUTE, not blanking `cssText`: both clear every inline
    // declaration, but `cssText = ""` MATERIALIZES an empty `style=""` on an
    // element that never had one — so `style={active ? styles : null}` built a
    // `<div style="">` on the client where SSR (which emits nothing for a null
    // style) built a bare `<div>`. Same vnode, two documents, and hydration
    // reported it as a server/client divergence.
    el.removeAttribute("style");
    return;
  }
  if (k === "dangerouslySetInnerHTML") {
    // AIO-200: handle both truthy object and null/false transition
    el.innerHTML = (v && typeof v === "object")
      ? ((v as { __html: string }).__html ?? "")
      : "";
    return;
  }
  if (k in el && _DOM_PROPS.has(k)) {
    // DOM properties (form elements): assign directly instead of setAttribute.
    // The `k in el` guard is load-bearing — `disabled`/`value` on a <div> are
    // NOT properties there, and assigning them creates an invisible expando
    // instead of the attribute the server rendered.
    if (v == null) {
      // null/undefined is the prop being ABSENT, on every path. Assigning `""`
      // is not that: `option.value = ""` reflects into `value=""`, and an
      // <option> with a value attribute no longer takes its value from its
      // TEXT — so `<option value={maybe}>English</option>` submitted `""` after
      // hydrate or an incremental render, while a fresh mount (which skips an
      // undefined prop) submitted "English". Same removal as a prop that left.
      _clearDomProp(el, k);
      return;
    }
    if (k === "value" && el.tagName === "SELECT" && Array.isArray(v)) {
      _selectValues(el as unknown as HTMLSelectElement, v);
      return;
    }
    if (_isEchoable(el, k) && _staleEcho(el as EchoEl, k, v)) return;
    // deno-lint-ignore no-explicit-any
    (el as any)[k] = v;
    return;
  }
  const ns = _attrNS(k);
  // The name the DOM is about to be asked for — refused here, with the
  // element and the prop in the message, instead of as a bare
  // `InvalidCharacterError` from deep inside the patcher. Same rule, same
  // answer, as the SSR writers: see `_assertAttrName`.
  _assertAttrName(ns ? k : _attrName(k), el.tagName?.toLowerCase() ?? "");
  if (v === false && _STRING_FALSE_ATTRS(k)) {
    // …but not for the attributes where "false" is a VALUE.
    //
    // `false` means "this attribute is absent" for a real boolean attribute
    // (`disabled`, `checked`), and those are handled by name elsewhere. For
    // `aria-*` and the enumerated attributes it means the opposite of what the
    // author wrote: `aria-pressed` ABSENT says "not a toggle button at all",
    // and `aria-expanded` absent says "not expandable" — so an
    // `aria-expanded={open}` toggle announced itself correctly when open and
    // became a plain button when closed. Measured across both renderers:
    // aria-expanded/hidden/checked/selected/pressed/invalid/disabled,
    // draggable, spellCheck and contentEditable were all dropped, and
    // `<img draggable={false}>` could not turn dragging off at all.
    //
    // aio's own kit works around it by hand (`? "true" : "false"` strings in
    // `src/ui/controls.ts`), and aio's own app manager did not:
    // `aria-checked={showAll.value === v}` rendered nothing whenever it was
    // false.
    if (ns) el.setAttributeNS(ns, k, "false");
    else el.setAttribute(_attrName(k), "false");
    return;
  }
  if (v === false || v == null) {
    if (ns) el.removeAttributeNS(ns, k.slice(k.indexOf(":") + 1));
    else el.removeAttribute(_attrName(k));
    return;
  }
  if (ns) el.setAttributeNS(ns, k, String(v));
  else el.setAttribute(_attrName(k), String(v));
}

/** Put a `_DOM_PROPS` prop back to the element's DEFAULT — the ONE removal,
 *  shared by a prop that left the props object and a prop set to null.
 *
 *  Clearing the property is not enough whenever the property reads through
 *  its content attribute: a checkbox's `.value` answers `"on"` only while it
 *  has no `value` attribute, and an <option>'s answers its text. So the
 *  attribute the prop wrote is dropped too. The property is reset FIRST and
 *  the attribute dropped after: on a checkbox (and an option) the property
 *  write itself REFLECTS back into the attribute, so the other order just
 *  puts it back. */
export function _clearDomProp(el: HTMLElement, k: string): void {
  // deno-lint-ignore no-explicit-any
  const e = el as any;
  e[k] = typeof e[k] === "boolean" ? false : "";
  const attr = _propAttr(el.tagName.toLowerCase(), k);
  if (attr) el.removeAttribute(attr);
}

/** `<select multiple value={["en", "de"]}>` — select exactly the options whose
 *  value is in the array.
 *
 *  `select.value = array` stringifies to `"en,de"`, matches no option and
 *  DESELECTS every one: a mounted multi-select showed nothing chosen, and
 *  hydration wiped the `selected` options SSR had correctly emitted for the
 *  same array. Compared as strings, as the SSR writer and the DOM compare
 *  option values. Only options whose state differs are written. */
export function _selectValues(
  el: HTMLSelectElement,
  values: readonly unknown[],
): void {
  const want = new Set(values.map(String));
  const opts = el.options;
  for (let i = 0; i < opts.length; i++) {
    const o = opts[i]!;
    const on = want.has(o.value);
    if (o.selected !== on) o.selected = on;
  }
}

/** Attributes whose `false` is a STRING VALUE, not an absence.
 *
 *  Every `aria-*` attribute is a string attribute in ARIA (the states take
 *  "true"/"false"/"mixed"/"undefined"), and these four HTML attributes are
 *  ENUMERATED — `draggable="false"` really does turn dragging off, while
 *  removing the attribute leaves the element at its default. Shared by the
 *  client patcher and the SSR emitter so both renderers answer the same. */
export function _STRING_FALSE_ATTRS(k: string): boolean {
  return k.startsWith("aria-") || k === "draggable" || k === "spellCheck" ||
    k === "spellcheck" || k === "contentEditable" || k === "contenteditable" ||
    k === "translate";
}

// ── Controlled props ──────────────────────────────────────────────────

/** Props the USER can change behind the reconciler's back.
 *
 *  Everything else in the DOM only changes because a render wrote it, so
 *  "the last vnode said the same value" is a sound reason to skip the write.
 *  For these it is not: the browser mutates `value`/`checked` on every
 *  keystroke and click, BEFORE the handler runs. When the handler then refuses
 *  the input — a length cap, a validator, an unchanged cell — the next render
 *  sees `prev.value === next.value` and writes nothing, so the screen keeps
 *  what state REJECTED. Measured: an input capped at 3 chars ended with state
 *  `"ab"` and DOM `"abcdef"`, permanently; `am surface` and `ui.X.value` then
 *  report a value the cell never accepted.
 *
 *  The fix is to compare against the LIVE element, not against the last vnode.
 *  It is still a skip — an input already showing the state's value is not
 *  rewritten, so a caret never moves for an accepted keystroke.
 *
 *  It lives HERE, beside `_writeProp`, because both prop paths need it and the
 *  bug is identical on each: `applyProps` skips a prop whose vnode value did
 *  not change, and the signal binder's effect does not even RUN when the signal
 *  did not change. A copy in one of them would leave `value={sig}` drifting
 *  while `value={s.x}` self-corrects — the same divergence-by-signal this
 *  module was created to end. */
export function _isControlled(el: HTMLElement, k: string): boolean {
  const tag = el.tagName;
  if (k === "value") {
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }
  if (k === "checked") return tag === "INPUT";
  return false;
}

/** True when `k` is controlled AND the element no longer shows `rv`. */
export function _controlDrifted(
  el: HTMLElement,
  k: string,
  rv: unknown,
): boolean {
  if (!_isControlled(el, k)) return false;
  if (k === "value" && el.tagName === "SELECT" && Array.isArray(rv)) {
    // A multi-select shows a SET, which `.value` (the first selected option)
    // cannot describe — compare the set itself.
    const want = new Set(rv.map(String));
    const opts = (el as unknown as HTMLSelectElement).options;
    for (let i = 0; i < opts.length; i++) {
      if (opts[i]!.selected !== want.has(opts[i]!.value)) return true;
    }
    return false;
  }
  const cur = (el as unknown as Record<string, unknown>)[k];
  // `_writeProp` assigns `v ?? ""`, so that is the value the DOM would hold.
  if (k === "checked") return Boolean(cur) !== Boolean(rv ?? "");
  const have = String(cur ?? "");
  const want = String(rv ?? "");
  if (have === want) {
    _echoArrived(el as EchoEl, want);
    return false;
  }
  // A NUMERIC input is compared as a number, not as a string.
  //
  // The element holds what the user TYPED and the state holds what the
  // handler PARSED, and for a number those are legitimately different
  // strings on the way to the same value: typing "1.5" passes through "1."
  // — `.value` is "1.", the handler stores `parseFloat("1.") === 1`, the
  // re-render compares "1." to "1", calls it drift and writes "1" back. The
  // decimal point vanished under the user's finger, on every controlled
  // number field there is; "1.05" could not be typed at all ("1.0" → 1 →
  // "1"). Before the drift check the vnode comparison (`1 === 1`) skipped
  // the write, so this is the regression the check introduced. Same rule
  // React uses (`node.value != value`) for the same reason. An unparsable
  // string ("abc", "1e") is still drift — the state has a value and the
  // element does not show it.
  const type = (el as { type?: string }).type;
  if (
    el.tagName === "INPUT" && (type === "number" || type === "range") &&
    have !== "" && want !== ""
  ) {
    const a = Number(have);
    return !(Number.isFinite(a) && a === Number(want));
  }
  return true;
}

// ── Keystroke echoes ──────────────────────────────────────────────────

/** A controlled input bound to state that lives across a round trip (a server
 *  cell) is re-rendered once per keystroke — AFTER the round trip. Type faster
 *  than that and a render carrying an OLDER keystroke lands mid-word: writing
 *  it regressed the field, the next keystroke appended to the regressed value,
 *  and the loss was permanent on screen and on the server. Measured in
 *  Chromium: 40 keys at 30 ms against a 40 ms reducer kept 21.
 *
 *  So each element remembers what it EMITTED (its last 256 `input` values —
 *  a slow server trails fast typing by dozens of keys, measured).
 *  While it is focused, a write of a value it emitted that is not its newest
 *  one is an echo of a keystroke the user has already typed past — skipped.
 *  The newest echo still lands (DOM and state converge), a value it never
 *  emitted still wins (a server-side transform, a reset), and a write in the
 *  SAME task as the keystroke is the handler's own synchronous answer (a local
 *  signal that refused the input) — also written. One path, dev and prod. */
const _ECHO = Symbol.for("aio.air.inputEcho");
const _ECHO_RING = 256;
type Echo = { vals: string[]; live: boolean };
type EchoEl = HTMLElement & { [_ECHO]?: Echo };

function _isEchoable(el: HTMLElement, k: string): boolean {
  return (k === "value" || k === "checked") &&
    (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
}

/** A short fingerprint of a value (length + FNV-1a), so the ring stays a
 *  few KB even for a long textarea. A collision can only skip a write while
 *  the field is focused, and the newest echo still lands. */
function _echoKey(k: string, v: unknown): string {
  const s = k === "checked" ? String(Boolean(v)) : String(v ?? "");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  }
  return `${s.length}:${h >>> 0}`;
}

function _echoRing(el: EchoEl, k: string): Echo {
  const had = el[_ECHO];
  if (had) return had;
  const r: Echo = { vals: [], live: false };
  el[_ECHO] = r;
  el.addEventListener("input", () => {
    r.vals.push(_echoKey(k, (el as unknown as Record<string, unknown>)[k]));
    if (r.vals.length > _ECHO_RING) r.vals.shift();
    r.live = true;
    // Past the render flush this keystroke's handler queued (a microtask),
    // the task is over: whatever renders next came from somewhere else.
    queueMicrotask(() =>
      queueMicrotask(() =>
        queueMicrotask(() => {
          r.live = false;
        })
      )
    );
  }, true);
  return r;
}

/** True when writing `v` would replay a keystroke the user typed past. */
function _staleEcho(el: EchoEl, k: string, v: unknown): boolean {
  const r = _echoRing(el, k);
  const i = r.vals.indexOf(_echoKey(k, v));
  const root = el.getRootNode?.() as { activeElement?: unknown } | undefined;
  const focused = (root?.activeElement ?? el.ownerDocument?.activeElement) ===
    el;
  if (r.live || !focused || i < 0 || i === r.vals.length - 1) {
    r.vals.length = 0;
    return false;
  }
  r.vals.splice(0, i + 1); // acknowledged up to i; newer keys still in flight
  return true;
}

/** The element already shows `want`: every keystroke up to it is answered. */
function _echoArrived(el: EchoEl, want: string): void {
  const r = el[_ECHO];
  if (!r) return;
  const i = r.vals.indexOf(_echoKey("value", want));
  if (i >= 0) r.vals.splice(0, i + 1);
}
