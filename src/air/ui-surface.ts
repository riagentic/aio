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
 *  Named by priority: `t` prop > aria-label > placeholder > static text > tag#n. */
export type UIElementInfo = {
  /** Semantic name used to address the element, e.g. "add" or "Add" */
  name: string;
  /** Lowercase tag, e.g. "button" */
  tag: string;
  /** Event kinds the element handles, e.g. ["click"] */
  events: string[];
  /** Visible text content (live at walk time, capped) */
  text?: string;
  /** Current input value (live at walk time) */
  value?: string;
  /** Current checked state (checkbox/radio, live at walk time) */
  checked?: boolean;
  /** Present and true when the element is disabled */
  disabled?: boolean;
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
   *  triggerable elements. */
  text?: string;
  /** The component's rendered DOM node — local use only; stripped on serialize */
  // deno-lint-ignore no-explicit-any
  _dom?: any;
};

/** Collect every interactive element named `name` anywhere in the subtree —
 *  lets a `t`/data-testid handle be addressed from the top level regardless of
 *  how deeply it's nested (risoto #2), instead of a positional component index. */
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

/** Infer the element's ROLE — what kind of thing it is. Tag first, then
 *  semantics: a clickable div/span with a button-ish class is a Button. */
function elementRole(v: VNode, events: string[]): string {
  const p = v.props;
  switch (v.tag) {
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
function elementName(v: VNode, events: string[], taken: Set<string>): string {
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
    const label = (typeof p["aria-label"] === "string"
      ? p["aria-label"] as string
      : undefined) ??
      staticText(v) ??
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
  taken.add(name);
  return name;
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
): void {
  if (out == null || typeof out !== "object") return;
  const v = out;
  if (typeof v.tag === "function") {
    owner.children.push(walkComponent(v, owner.path, owner.children));
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
    // resolve it and assert `disabled: true`. (inews R4 P1)
    const intrinsic = v.tag === "button" || v.tag === "input" ||
      v.tag === "select" || v.tag === "textarea";
    if (
      events.length > 0 || intrinsic || typeof v.props.t === "string" ||
      typeof v.props["data-testid"] === "string"
    ) {
      const name = elementName(v, events, taken);
      const el = v._dom && (v._dom as Node).nodeType === 1
        ? v._dom as Element & {
          value?: string;
          checked?: boolean;
          disabled?: boolean;
        }
        : undefined;
      const liveText = el?.textContent?.trim();
      owner.elements.push({
        name,
        tag: v.tag,
        events,
        ...(liveText
          ? { text: capText(liveText) }
          : staticText(v)
          ? { text: staticText(v) }
          : {}),
        ...(el && typeof el.value === "string" ? { value: el.value } : {}),
        ...(el && typeof el.checked === "boolean" &&
            (v.props.type === "checkbox" || v.props.type === "radio")
          ? { checked: el.checked }
          : {}),
        ...(el && el.disabled === true ? { disabled: true } : {}),
        path: `${owner.path}:${name}`,
        _vnode: v,
        _el: el,
      });
    }
  }
  for (const c of v.children) {
    if (isVNode(c)) walkOutput(c, owner, taken);
  }
}

function walkComponent(
  v: VNode,
  parentPath: string,
  siblings: UISurfaceNode[] = [],
): UISurfaceNode {
  const fn = v.tag as { name?: string; _lazyName?: string };
  // A resolved lazy() wrapper reports the loaded component's name.
  const name = fn._lazyName ??
    (fn.name && fn.name.length > 0 ? fn.name : "Anonymous");
  // An ADDITIONAL stable handle when the component was given `t`. Addressing a
  // component by its identifier couples a test to a rename — one report broke a
  // test by renaming `CtxPresets` → `CtxControls`, a refactor rather than a
  // behaviour change (llama.md, second update #4).
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
  // (risoto 2026-07-21). Deterministic dedupe: 2nd+ instances get #2, #3 …
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
  };
  if (v._dom) {
    node._dom = v._dom;
    const t = (v._dom as { textContent?: string }).textContent?.trim();
    if (t) node.text = capText(t);
  }
  walkOutput(v._rendered ?? null, node, new Set());
  return node;
}

/** Build the semantic UI surface from a mounted root vnode (on demand). */
// How much of an element's / component's text the surface carries.
//
// A surface is meant to be scannable, so it caps text — but it used to cut
// element text at 80 characters with NO marker, so a generated command line read
// as a complete (wrong) string and there was no way to tell (llama.md #10). Two
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
    ...(node.text !== undefined ? { text: node.text } : {}),
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
      (key === undefined || n.key === key)
    ) hits.push(n);
    n.children.forEach(visit);
  };
  visit(node);
  return hits;
}
