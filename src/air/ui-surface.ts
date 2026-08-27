/**
 * @module
 * Semantic UI surface — walks a live AIR vdom tree and exposes every component
 * and interactive element as a structured, addressable API. This is the
 * foundation of first-class UI testing (`testUI` in `aio/testing`) and of
 * `am ui` live-client inspection: tests and tools drive the UI through the
 * surface the framework already owns — no DOM/selector lookup.
 *
 * Dev/test only by design: the walk runs on demand (no render-time
 * bookkeeping, zero production overhead).
 */
import type { VNode } from "./vdom-types.ts";

/** An interactive element (has `on*` handlers) owned by a component.
 *  Named LABEL + ROLE, label by priority: `t` prop > `data-testid` >
 *  `aria-label` > own static text > wrapping `<label>` > placeholder > `name`
 *  attr; same-named siblings get a 2-based ordinal suffix. */
export type UIElementInfo = {
  /** Semantic name used to address the element, e.g. "add" or "Add" */
  name: string;
  /** Lowercase tag, e.g. "button" */
  tag: string;
  /** Event kinds the element handles, e.g. ["click"] */
  events: string[];
  /** Visible text content (live at walk time, capped). Always a string: an
   *  element with nothing in it has EMPTY text, not unknown text — so an
   *  assertion reads `el.text === ""`, never `el.text ?? ""`. */
  text: string;
  /** Current input value (live at walk time) */
  value?: string;
  /** Current checked state of a checkbox/radio (live at walk time). ALWAYS
   *  present for one — `false` included — because "this box starts unchecked"
   *  is the most common assertion there is, and an omitted `false` made it
   *  unwritable (a field report: the natural assertion read back a lazy
   *  callable). Absent only for elements that have no checked state at all. */
  checked?: boolean;
  /** Whether the element is disabled. Always present for a control that HAS a
   *  disabled state (button/input/select/textarea/…), `false` included. */
  disabled?: boolean;
  /** Whether the element is read-only. Always present for a control that HAS a
   *  readonly state (input/textarea), `false` included. */
  readonly?: boolean;
  /** Whether the element is required. Always present for a control that HAS a
   *  required state (input/select/textarea), `false` included. */
  required?: boolean;
  /** Address: `<componentPath>:<name>` */
  path: string;
  /** Live references — local use only; stripped by {@linkcode serializeSurface} */
  _vnode?: VNode;
  _el?: Element;
};

/** A component instance in the semantic UI tree. */
export type UISurfaceNode = {
  /** Component function name (or "Anonymous") */
  component: string;
  /** Stable alias from a `t` prop on the component — address it by this and a
   *  later rename of the function is a refactor, not a broken test. Additive:
   *  `component` stays authoritative, because `t` is also a legitimate data prop
   *  that components forward to inner elements. */
  handle?: string;
  /** AIR list key, when the instance was rendered with one */
  key?: string | number;
  /** Path from the root, e.g. "App/TodoList/TodoRow[42]" */
  path: string;
  /** Interactive elements rendered directly by this component */
  elements: UIElementInfo[];
  /** Child component instances */
  children: UISurfaceNode[];
  /** Visible text of the component's subtree (live at walk time, capped) —
   *  lets a surface reader (human or AI) SEE the screen, not just its
   *  triggerable elements. Always a string, empty when the subtree renders
   *  no text. */
  text: string;
  /** The component's rendered DOM node — local use only; stripped on serialize */
  // deno-lint-ignore no-explicit-any
  _dom?: any;
};

// FORWARDED handles — a `t` the author gave to an ELEMENT, through a component.
//
// `t` on an element names that element; `t` on a component is an additional,
// rename-proof handle for the component. Those two meanings collide whenever a
// component takes `t` as a data prop and passes it down — and that is not an
// exotic app mistake, it is what aio's OWN component kit does: `<Button
// t="Home">`, `<Input t="who">`, `<Select t="sel">` all forward `t` to the
// element they render. Every app built on `aio/ui` therefore has names that
// address a component AND an element at once.
//
// So this is not something to scold an author about — it is a fact of the
// model, and the harness has to answer well in spite of it. Presence resolves
// the ELEMENT first (deterministic, frame-local), and a handle recorded here as
// forwarded lets the harness explain the one frame where the two answers
// genuinely differ: the element is gone while the component still renders
// something else. Recording is observation only — it never changes an answer,
// because a behaviour that depended on what a previous render happened to show
// would make tests order-dependent.
const _forwardedHandles = new Set<string>();

/** @internal Has this name ever been a `t` that a component forwarded to an
 *  element it renders? Advisory only — used to EXPLAIN an ambiguous answer,
 *  never to decide one. */
export function _isForwardedHandle(name: string): boolean {
  return _forwardedHandles.has(name);
}

/** @internal test isolation — clear the forwarded-handle observations. */
export function _resetForwardedHandles(): void {
  _forwardedHandles.clear();
}

/** Collect every interactive element named `name` anywhere in the subtree —
 *  lets a `t`/data-testid handle be addressed from the top level regardless of
 *  how deeply it's nested, instead of a positional component index. */
export function findElementsDeep(
  node: UISurfaceNode,
  name: string,
): UIElementInfo[] {
  const out: UIElementInfo[] = [];
  const walk = (n: UISurfaceNode): void => {
    for (const el of n.elements) if (el.name === name) out.push(el);
    for (const c of n.children) walk(c);
  };
  walk(node);
  return out;
}

const isVNode = (c: unknown): c is VNode =>
  !!c && typeof c === "object" && "tag" in (c as Record<string, unknown>);

function staticText(v: VNode): string | undefined {
  const parts: string[] = [];
  for (const c of v.children) {
    if (typeof c === "string" || typeof c === "number") parts.push(String(c));
  }
  const s = parts.join("").trim();
  return s.length > 0 && s.length <= 60 ? s : undefined;
}

/** An enclosing `<label>` and whether its text has already been claimed.
 *
 *  HTML associates a wrapping label with its FIRST labelable descendant, and
 *  only that one — so the context is consumed, not broadcast. */
type LabelCtx = { text: string; used: boolean };

/** HTML's labelable elements — the ones a wrapping `<label>` can name. */
const LABELABLE = new Set([
  "button",
  "input",
  "meter",
  "output",
  "progress",
  "select",
  "textarea",
]);

/** Text of a `<label>` subtree, ignoring the control it wraps.
 *
 *  `staticText` only reads DIRECT string children, which is exactly what a
 *  wrapping label never has: `<label><input/><span>Enable LAN</span></label>`
 *  (the shape aio's own `Checkbox` renders) put its words one level down, so
 *  every labelled checkbox on a page came out as the bare role — `Checkbox`,
 *  `Checkbox2`, … — and could only be addressed positionally. */
function labelSubtreeText(v: VNode, depth = 0): string {
  if (depth > 4) return "";
  const parts: string[] = [];
  for (const c of v.children) {
    if (typeof c === "string" || typeof c === "number") {
      parts.push(String(c));
    } else if (
      isVNode(c) && typeof c.tag === "string" && !LABELABLE.has(c.tag)
    ) {
      parts.push(labelSubtreeText(c, depth + 1));
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** PascalCase a label into a valid identifier fragment: "buy milk!" → "BuyMilk". */
function pascal(s: string): string {
  return s
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("")
    .slice(0, 32);
}

/** Infer the element's ROLE — what kind of thing it is. Explicit `role` first,
 *  then the tag, then semantics: a clickable div/span with a button-ish class
 *  is a Button. */
function elementRole(v: VNode, events: string[]): string {
  const p = v.props;
  // An explicit ARIA role is the author SAYING what the thing is — the most
  // authoritative answer there is, and the one a screen reader uses. Without
  // it, `<div role="dialog" onClick=…>` (a modal backdrop) came out as
  // "Button", which is neither what it is nor what a11y tooling reports.
  if (typeof p.role === "string" && p.role.trim()) {
    const r = pascal(p.role.trim().split(/\s+/)[0]!);
    if (r) return r;
  }
  switch (v.tag) {
    // A clickable row/list-item is not a Button: the generic click→Button
    // fallback below erased the one word that says what was clicked.
    case "tr":
      return "Row";
    case "li":
      return "Item";
    case "button":
      return "Button";
    case "a":
      return "Link";
    case "form":
      return "Form";
    case "select":
      return "Select";
    case "textarea":
      return "Input";
    case "input": {
      const t = String(p.type ?? "text");
      if (t === "checkbox") return "Checkbox";
      if (t === "radio") return "Radio";
      if (t === "submit" || t === "button") return "Button";
      return "Input";
    }
  }
  const cls = typeof p.className === "string"
    ? p.className
    : typeof p.class === "string"
    ? p.class as string
    : "";
  if (/(^|[\s-_])(btn|button)([\s-_]|$)/i.test(cls)) return "Button";
  if (events.includes("click")) return "Button"; // clickable div/span acts as one
  return pascal(String(v.tag)) || "Element";
}

/** Infer the intuitive semantic name: `t` prop verbatim (then `data-testid`,
 *  the industry-standard test handle), else LABEL + ROLE —
 *  e.g. <button>Submit</button> → "SubmitButton",
 *  <div class="button">Submit</div> → "SubmitButton",
 *  <input placeholder="Title"> → "TitleInput". */
function elementName(
  v: VNode,
  events: string[],
  taken: Set<string>,
  labelCtx?: LabelCtx,
): string {
  const p = v.props;
  const explicit = typeof p.t === "string"
    ? p.t
    : typeof p["data-testid"] === "string"
    ? p["data-testid"] as string
    : undefined;
  let base: string;
  if (explicit) {
    base = explicit;
  } else {
    const role = elementRole(v, events);
    const own = (typeof p["aria-label"] === "string"
      ? p["aria-label"] as string
      : undefined) ?? staticText(v);
    // A wrapping `<label>` names the first labelable thing inside it — the
    // implicit association HTML has always had, applied here so the surface
    // agrees with the accessible name a user actually hears.
    let implicit: string | undefined;
    if (
      own === undefined && labelCtx && !labelCtx.used &&
      typeof v.tag === "string" && LABELABLE.has(v.tag) &&
      labelCtx.text.length > 0 && labelCtx.text.length <= 60
    ) {
      implicit = labelCtx.text;
      labelCtx.used = true;
    }
    const label = own ?? implicit ??
      (typeof p.placeholder === "string"
        ? p.placeholder as string
        : undefined) ??
      (typeof p.name === "string" ? p.name as string : undefined) ?? "";
    const lp = pascal(label);
    base = lp.endsWith(role) ? lp : lp + role; // "Submit Button" → SubmitButton
    if (base === role && !lp) {
      base = role; // unlabeled: bare role, de-duped below
    }
  }
  let name = base;
  let i = 2;
  while (taken.has(name)) name = `${base}${i++}`;
  if (explicit && name !== base) warnDuplicateHandle(base, name);
  taken.add(name);
  return name;
}

/** Names already reported as duplicated — the surface is rebuilt on every
 *  observation (each `testUI` assertion, each `am surface` poll), so the report
 *  has to be once per name, not once per walk. */
const _warnedDuplicateT = new Set<string>();

/** An EXPLICIT `t="save"` is a promise: that element is addressable by that
 *  name. Two of them silently became `save` and `save2`, so `ui.save` drove
 *  whichever came first in tree order and the other was reachable only by a
 *  name nobody wrote. The de-dupe still happens (an unaddressable element would
 *  be worse) — it just stops being silent. */
function warnDuplicateHandle(base: string, assigned: string): void {
  if (_warnedDuplicateT.has(base)) return;
  _warnedDuplicateT.add(base);
  console.warn(
    `[aio:ui] duplicate t="${base}" on the surface — this element is ` +
      `addressable as "${assigned}", not "${base}". A \`t\` handle is meant ` +
      `to be unique within its component; rename one of them (or drop \`t\` ` +
      `and let the label name it).`,
  );
}

/** Test isolation — forget which duplicate handles have been reported. */
export function _resetSurfaceWarnings(): void {
  _warnedDuplicateT.clear();
}

function eventKinds(v: VNode): string[] {
  return Object.keys(v.props)
    .filter((k) => k.startsWith("on") && typeof v.props[k] === "function")
    .map((k) => k.slice(2).toLowerCase());
}

/** Walk a component's rendered output, collecting its own interactive elements
 *  and descending into child components. */
function walkOutput(
  out: VNode | string | number | null | undefined,
  owner: UISurfaceNode,
  taken: Set<string>,
  labelCtx?: LabelCtx,
): void {
  if (out == null || typeof out !== "object") return;
  const v = out;
  if (typeof v.tag === "function") {
    owner.children.push(
      walkComponent(v, owner.path, owner.children, labelCtx),
    );
    return;
  }
  // Host element / fragment-like: collect interactivity, then descend
  if (typeof v.tag === "string") {
    const events = eventKinds(v);
    // Interactive elements are always on the surface; a `t` prop or a
    // `data-testid` puts ANY element on it (assertion targets — read
    // text/value without handlers). Intrinsic form controls are on it even
    // with zero handlers: a DISABLED button often has its onClick
    // conditionally absent, but a user still sees it — tests must be able to
    // resolve it and assert `disabled: true`.
    const intrinsic = v.tag === "button" || v.tag === "input" ||
      v.tag === "select" || v.tag === "textarea";
    if (
      events.length > 0 || intrinsic || typeof v.props.t === "string" ||
      typeof v.props["data-testid"] === "string"
    ) {
      const name = elementName(v, events, taken, labelCtx);
      const el = v._dom && (v._dom as Node).nodeType === 1
        ? v._dom as Element & {
          value?: string;
          checked?: boolean;
          disabled?: boolean;
          readOnly?: boolean;
          required?: boolean;
        }
        : undefined;
      const liveText = el?.textContent?.trim();
      owner.elements.push({
        name,
        tag: v.tag,
        events,
        text: liveText ? capText(liveText) : staticText(v) ?? "",
        ...(el && typeof el.value === "string" ? { value: el.value } : {}),
        // The four state booleans a test asserts on, serialised WHENEVER the
        // element has that state — `false` included.
        //
        // `checked` used to appear only when true, so `assertEquals(box.checked,
        // false)` read back the handle proxy's lazy callable instead: the
        // natural assertion for "off" was unwritable, and the failure message
        // pointed at neither cause (a field report). Presence is decided by the
        // DOM element's own property, so a plain <div> on the surface stays
        // clean while every real control answers honestly — and `am surface`
        // (same walk) shows a live app exactly what a test sees.
        ...(el && typeof el.checked === "boolean" &&
            (v.props.type === "checkbox" || v.props.type === "radio")
          ? { checked: el.checked }
          : {}),
        ...(el && typeof el.disabled === "boolean"
          ? { disabled: el.disabled }
          : {}),
        ...(el && typeof el.readOnly === "boolean"
          ? { readonly: el.readOnly }
          : {}),
        ...(el && typeof el.required === "boolean"
          ? { required: el.required }
          : {}),
        path: `${owner.path}:${name}`,
        _vnode: v,
        _el: el,
      });
    }
  }
  // Descending INTO a <label> makes its text the implicit name for the first
  // labelable element below it (HTML's own rule) — including across a component
  // boundary, since what associates them is DOM nesting, not authorship.
  const inner = v.tag === "label"
    ? { text: labelSubtreeText(v), used: false }
    : labelCtx;
  for (const c of v.children) {
    if (isVNode(c)) walkOutput(c, owner, taken, inner);
  }
}

function walkComponent(
  v: VNode,
  parentPath: string,
  siblings: UISurfaceNode[] = [],
  labelCtx?: LabelCtx,
): UISurfaceNode {
  const fn = v.tag as { name?: string; _lazyName?: string };
  // A resolved lazy() wrapper reports the loaded component's name.
  const name = fn._lazyName ??
    (fn.name && fn.name.length > 0 ? fn.name : "Anonymous");
  // An ADDITIONAL stable handle when the component was given `t`. Addressing a
  // component by its identifier couples a test to a rename — one report broke a
  // test by renaming `CtxPresets` → `CtxControls`, a refactor rather than a
  // behaviour change.
  //
  // Additive, never a replacement: `t` on a component is ambiguous — it is also
  // a perfectly good DATA prop that a component forwards to an inner element
  // (this repo's own toolbar fixture does exactly that). Overriding the name
  // broke sibling de-duplication and ordinal access, so the function name stays
  // authoritative and the handle is an alias you can also address.
  const handle = typeof v.props?.t === "string" && v.props.t
    ? v.props.t
    : undefined;
  const keyPart = v.key !== undefined ? `[${v.key}]` : "";
  let path = parentPath
    ? `${parentPath}/${name}${keyPart}`
    : `${name}${keyPart}`;
  // Same-type siblings without keys would otherwise share ONE address — every
  // path-based lookup (resolveElement, runUITrigger) could only ever reach the
  // FIRST instance, so per component type only one `t` handle survived
  //. Deterministic dedupe: 2nd+ instances get #2, #3 …
  // in tree order, keeping every instance's elements addressable.
  if (siblings.some((s) => s.path === path)) {
    let i = 2;
    while (siblings.some((s) => s.path === `${path}#${i}`)) i++;
    path = `${path}#${i}`;
  }
  const node: UISurfaceNode = {
    component: name,
    ...(handle ? { handle } : {}),
    ...(v.key !== undefined ? { key: v.key } : {}),
    path,
    elements: [],
    children: [],
    text: "",
  };
  if (v._dom) {
    node._dom = v._dom;
    const t = (v._dom as { textContent?: string }).textContent?.trim();
    if (t) node.text = capText(t);
  }
  walkOutput(v._rendered ?? null, node, new Set(), labelCtx);
  // The subtree is built: if this component's `t` handle is ALSO the name of
  // something it rendered, the author gave that name to the element and the
  // component merely carried it. Remember it (see _forwardedHandles).
  if (node.handle && findElementsDeep(node, node.handle).length > 0) {
    _forwardedHandles.add(node.handle);
  }
  return node;
}

/** Build the semantic UI surface from a mounted root vnode (on demand). */
// How much of an element's / component's text the surface carries.
//
// A surface is meant to be scannable, so it caps text — but it used to cut
// element text at 80 characters with NO marker, so a generated command line read
// as a complete (wrong) string and there was no way to tell. Two
// changes: truncation is always marked with "…", and the cap is liftable
// (`am surface --full`, `buildUISurface(root, { maxText: Infinity })`).
//
// Module-scoped because the walk is a synchronous, single-threaded recursion —
// threading a parameter through every internal node function buys nothing.
const TEXT_CAP = 80;
let _maxText = TEXT_CAP;

/** Cap `s`, marking the cut so a truncated value can never read as complete. */
function capText(s: string): string {
  return s.length > _maxText ? s.slice(0, _maxText) + "…" : s;
}

export function buildUISurface(
  root: VNode | string | number | null,
  opts?: { maxText?: number },
): UISurfaceNode | null {
  _maxText = opts?.maxText ?? TEXT_CAP;
  if (!isVNode(root)) return null;
  if (typeof root.tag === "function") return walkComponent(root, "");
  // Root that isn't a component (rare): wrap in a synthetic node
  const node: UISurfaceNode = {
    component: "(root)",
    path: "(root)",
    elements: [],
    children: [],
    text: "",
  };
  walkOutput(root, node, new Set());
  return node;
}

/** Wire-safe copy of a surface node — live vnode/element refs stripped.
 *  This is what a "ui-surface" request returns and what AI/`am` consumers read. */
export function serializeSurface(node: UISurfaceNode): UISurfaceNode {
  return {
    component: node.component,
    // The handle must survive the wire: `am surface --component=<handle>` and a
    // remote testUI address it exactly as an in-process test does.
    ...(node.handle !== undefined ? { handle: node.handle } : {}),
    ...(node.key !== undefined ? { key: node.key } : {}),
    path: node.path,
    text: node.text,
    // _dom intentionally dropped (wire-safety)
    elements: node.elements.map((
      { _vnode: _v, _el: _e, ...rest },
    ) => rest),
    children: node.children.map(serializeSurface),
  };
}

/** Find component instances by name (and optionally key) anywhere in a surface. */
export function findComponents(
  node: UISurfaceNode,
  component: string,
  key?: string | number,
): UISurfaceNode[] {
  const hits: UISurfaceNode[] = [];
  const visit = (n: UISurfaceNode) => {
    if (
      (n.component === component || n.handle === component) &&
      // `String()` on both sides: a component keyed `key={5}` renders exactly
      // like `key="5"`, and a finder that compared strictly missed the numeric
      // one SILENTLY — `find(C, 5)` returned nothing, and so did `find(C, "5")`
      // for the other spelling (field report §4.5).
      (key === undefined || String(n.key) === String(key))
    ) hits.push(n);
    n.children.forEach(visit);
  };
  visit(node);
  return hits;
}
