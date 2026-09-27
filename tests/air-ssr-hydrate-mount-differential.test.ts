// Differential gate: the FOUR ways AIR puts a tree on screen must agree.
//
//   renderToString(tree)            ─┐ (a) byte-identical
//   renderToStream(tree)            ─┘
//   mount(tree)                     ─┐ (b) same document
//   SSR markup → hydrate(tree)      ─┘ (d) …with no dev divergence warning
//   …then the SAME random update on both roots
//   hydrated root == mounted root == fresh mount(tree')         (c)
//
// Each of these is a separate commit path in the renderer (`createDom`,
// `renderToString`, `renderToStream`, `_hydrateNode`, `_diff`), and every
// defect between them is SILENT: the page is well-formed, it is just not the
// page the other path builds. Three shipped at once and were found one at a
// time: a hydrated component that renders a bare string had no `_dom`, so its
// own re-render appended a second text; a hydrated ErrorBoundary was never on
// `_boundaryStack`, so it neither recovered from the server's fallback nor
// caught a throw that began after hydration; and `style=""` materialized an
// empty attribute on the client that SSR never writes, so hydrate cried
// "divergence" on correct code. Each got a shape test. This file makes the
// CLASS unshippable: random trees over every shape those bugs lived in, and
// the four paths must agree on every one of them, before and after an update.
//
// The update has two halves, because the bugs above hide from one or the
// other: a SELF re-render (component-local signals `tick` / `flip` change and
// only the components reading them re-run — the path a hydrated `_dom` or
// boundary stack is needed for), then a whole-tree swap to a second random
// tree that shares keys with the first (the keyed/unkeyed reconciler).
//
// Seeds: `AIO_AIR_DIFF_SEED` / `AIO_AIR_DIFF_N` (read through `fuzzEnvInt`,
// which throws on an unreadable value). A failure names the seed and round.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { repairProxiedSiblings } from "../src/testing/happy-dom-repair.ts";
import {
  type ComponentFn,
  ErrorBoundary,
  Fragment,
  h,
  renderToString,
  type VNode,
} from "../src/air/vdom.ts";
import { renderToStream } from "../src/air/ssr-stream.ts";
import {
  _setDocument,
  _unmount,
  hydrate,
  mount,
  type MountHandle,
  setDevMode,
} from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";
import { fuzzEnvInt } from "./fuzz-seed.ts";
import { type Rng, rngOf } from "./sync/properties/_prop.ts";

const SEED = fuzzEnvInt("AIO_AIR_DIFF_SEED", 0xa1d1ff) >>> 0;
const N = fuzzEnvInt("AIO_AIR_DIFF_N", 120, 1);

// ── the model ────────────────────────────────────────────────────────────

type Kids = { keyed: boolean; kids: Spec[] };
type Spec =
  | { k: "t"; id: number; v: string | number } // string / number child
  | { k: "z"; id: number; v: null | false } // null / false child
  | ({ k: "e"; id: number; tag: string; pi: number } & Kids)
  | ({ k: "f"; id: number } & Kids) // Fragment
  | ({ k: "c"; id: number; c: CompKind; v: string } & Kids)
  | { k: "svg"; id: number; vi: number }
  | { k: "ta"; id: number; v: string }
  | { k: "sel"; id: number; v: string }
  | { k: "in"; id: number; ii: number }
  | { k: "btn"; id: number; dis: boolean; v: string }
  | ({ k: "b"; id: number; fb: number } & Kids) // ErrorBoundary
  | { k: "x"; id: number; when: When }; // thrower (only under a boundary)

type CompKind = "str" | "num" | "null" | "frag" | "wrap";
/** When a thrower throws: `r` (recovers) while `flip` is 0 — the SERVER renders
 *  its fallback and the first self re-render must recover it; `s` (starts)
 *  while `flip` is 2 — it hydrates fine and begins throwing on a self
 *  re-render; `a` always. */
type When = "r" | "s" | "a";
const WHENS: readonly When[] = ["r", "s", "a"];

// Component-local state: `tick` feeds the value-returning components and
// `flip` decides which throwers throw. The App never reads either, so setting
// them re-renders ONLY the components — the hydrated `_dom` / boundary-stack
// path, which a whole-tree re-render never exercises.
const tick = signal(0);
const flip = signal(0);
const tree = signal<Spec | null>(null);

// deno-lint-ignore no-explicit-any
type P = any;
// Module-level so a component keeps its identity across renders — a fresh
// closure is a different `tag` and forces a replace, hiding the diff paths.
// The casts only satisfy ComponentFn's return type: the renderer supports a
// bare string / number / null return on every path (see
// tests/air-hydrate-text-component-position.test.ts).
const CStr = ((p: P) => `${p.v}${tick.value}`) as unknown as ComponentFn;
const CNum = ((p: P) => p.v.length * 10 + tick.value) as unknown as ComponentFn;
const CNull = (() => null) as unknown as ComponentFn;
const CFrag = (p: P) => h(Fragment, null, ...(p.children ?? []));
const CWrap = (p: P) => h("span", { class: "w" }, ...(p.children ?? []));
const COMP: Record<CompKind, ComponentFn> = {
  str: CStr,
  num: CNum,
  null: CNull,
  frag: CFrag,
  wrap: CWrap,
};
/** See {@link When}. */
const CThrow = ((p: P) => {
  const f = flip.value;
  if (
    p.when === "a" || (p.when === "r" && f === 0) || (p.when === "s" && f === 2)
  ) {
    throw new Error(`boom-${p.when}`);
  }
  return h("em", null, "ok");
}) as unknown as ComponentFn;
/** Fallback shapes: an element, a bare string, nothing, a fragment. */
const FALLBACKS = [
  (e: Error) => h("b", null, e.message),
  () => "fb",
  () => null,
  (e: Error) => h(Fragment, null, h("i", null, "f"), e.message),
];

/** Every prop shape here must mean the same thing through SSR and through
 *  `applyProps`. `style: ""` is the shape that materialized `style=""`. */
const PROPS: Record<string, unknown>[] = [
  {},
  { id: "i1" },
  { class: "a b" },
  { className: "c" },
  { style: "" },
  { style: "color:red" },
  { style: { color: "red", marginTop: 2 } },
  { hidden: true },
  { title: "t", "data-x": "1" },
  { class: "a", style: "", hidden: false },
];
const TAGS = ["div", "span", "section"];
const INPUTS: Record<string, unknown>[] = [
  { type: "text" },
  { type: "text", value: "v1" },
  { type: "checkbox", checked: true },
  { type: "checkbox", checked: false },
  { type: "text", value: "v2", disabled: true, readOnly: true },
];
/** Tiny, so sibling text COLLIDES and adjacent texts merge in the parser. */
const TEXTS: (string | number)[] = ["a", "a", "b", "", " ", 0, 1, 12];

function svg(vi: number, key?: string): VNode {
  const k = key ? { key } : {};
  switch (vi % 3) {
    case 0:
      return h(
        "svg",
        { viewBox: "0 0 8 8", ...k },
        h("circle", { cx: 4, cy: 4, r: 3, strokeWidth: 2, fillOpacity: "0.5" }),
      );
    case 1:
      // camelCase TAGS — `linearGradient` must survive both createElementNS
      // and the SSR writer with its case intact.
      return h(
        "svg",
        { viewBox: "0 0 8 8", ...k },
        h(
          "defs",
          null,
          h(
            "linearGradient",
            { id: "g" },
            h("stop", { offset: "0", stopColor: "red" }),
          ),
        ),
        h("rect", { width: 8, height: 8, fill: "url(#g)" }),
      );
    default:
      return h(
        "svg",
        { ...k },
        h("clipPath", { id: "cp" }, h("rect", { width: 4, height: 4 })),
        h("g", { clipPath: "url(#cp)" }, h("path", { d: "M0 0L8 8" })),
      );
  }
}

function build(s: Spec, key?: string): VNode | string | number | null | false {
  const kp = key ? { key } : {};
  const kids = (c: Kids) =>
    c.kids.map((x) => build(x, c.keyed ? `k${x.id}` : undefined));
  switch (s.k) {
    case "t":
      return s.v;
    case "z":
      return s.v;
    case "e":
      return h(s.tag, { ...PROPS[s.pi % PROPS.length], ...kp }, ...kids(s));
    case "f":
      return h(Fragment, { ...kp }, ...kids(s));
    case "c":
      return h(COMP[s.c], { v: s.v, ...kp }, ...kids(s));
    case "svg":
      return svg(s.vi, key);
    case "ta":
      return h("textarea", { value: s.v, ...kp });
    case "sel":
      return h(
        "select",
        { value: s.v, ...kp },
        h("option", { value: "a" }, "A"),
        h("option", { value: "b" }, "B"),
        h("option", { value: "c" }, "C"),
      );
    case "in":
      return h("input", { ...INPUTS[s.ii % INPUTS.length], ...kp });
    case "btn":
      return h("button", { type: "button", disabled: s.dis, ...kp }, s.v);
    case "b":
      return h(
        ErrorBoundary,
        { fallback: FALLBACKS[s.fb % FALLBACKS.length], ...kp },
        ...kids(s),
      );
    case "x":
      return h(CThrow, { when: s.when, ...kp });
  }
}

const App = (() => {
  const s = tree.value;
  return s ? build(s) : null;
}) as unknown as ComponentFn;

// ── generation ───────────────────────────────────────────────────────────

let nextId = 1;
function gen(r: Rng, depth: number, inB: boolean, keyable: boolean): Spec {
  const id = nextId++;
  const leafOnly = depth <= 0;
  const kinds: Spec["k"][] = keyable
    ? ["e", "f", "c", "svg", "ta", "sel", "in", "btn"]
    : ["t", "t", "t", "z", "e", "f", "c", "svg", "ta", "sel", "in", "btn"];
  if (!leafOnly) kinds.push("e", "f", "c", "b");
  if (inB) kinds.push("x", "x");
  const k = r.pick(kinds);
  const children = (): Kids => {
    if (leafOnly) return { keyed: false, kids: [] };
    const keyed = r.chance(0.4);
    const n = r.int(4);
    const kids: Spec[] = [];
    for (let i = 0; i < n; i++) kids.push(gen(r, depth - 1, inB, keyed));
    return { keyed, kids };
  };
  switch (k) {
    case "t":
      return { k, id, v: r.pick(TEXTS) };
    case "z":
      return { k, id, v: r.chance(0.5) ? null : false };
    case "e":
      return {
        k,
        id,
        tag: r.pick(TAGS),
        pi: r.int(PROPS.length),
        ...children(),
      };
    case "f":
      return { k, id, ...children() };
    case "c": {
      const c = r.pick<CompKind>(["str", "num", "null", "frag", "wrap"]);
      const kids = c === "frag" || c === "wrap"
        ? children()
        : { keyed: false, kids: [] };
      return { k, id, c, v: r.pick(["p", "qq", "p"]), ...kids };
    }
    case "svg":
      return { k, id, vi: r.int(3) };
    case "ta":
      return { k, id, v: r.pick(["", "hi", "a b"]) };
    case "sel":
      return { k, id, v: r.pick(["a", "b", "c"]) };
    case "in":
      return { k, id, ii: r.int(INPUTS.length) };
    case "btn":
      return { k, id, dis: r.chance(0.5), v: r.pick(["go", "x"]) };
    case "b": {
      const b = { k, id, fb: r.int(FALLBACKS.length), keyed: false, kids: [] };
      const keyed = r.chance(0.3);
      const n = 1 + r.int(3);
      const kids: Spec[] = [];
      for (let i = 0; i < n; i++) kids.push(gen(r, depth - 1, true, keyed));
      // Make most boundaries actually carry a thrower — the fallback paths are
      // the point of having a boundary in the alphabet at all.
      if (r.chance(0.7)) {
        // Anywhere among its siblings: a thrower after them is the late SSR
        // thrower shape (see `hasLateSsrThrower`).
        kids.splice(r.int(kids.length + 1), 0, {
          k: "x",
          id: nextId++,
          when: r.pick(["r", "r", "s", "s", "a"] as const),
        });
      }
      return { ...b, keyed, kids };
    }
    case "x":
      return { k, id, when: r.pick(WHENS) };
  }
}

function genRoot(r: Rng): Spec {
  const kids: Spec[] = [];
  const keyed = r.chance(0.3);
  const n = 1 + r.int(4);
  for (let i = 0; i < n; i++) kids.push(gen(r, 3, false, keyed));
  return r.chance(0.8)
    ? { k: "e", id: nextId++, tag: "div", pi: 0, keyed, kids }
    : { k: "f", id: nextId++, keyed, kids };
}

const clone = (s: Spec): Spec => structuredClone(s);

function containers(s: Spec, out: (Spec & Kids)[] = []): (Spec & Kids)[] {
  if ("kids" in s) {
    out.push(s);
    for (const c of s.kids) containers(c, out);
  }
  return out;
}

/** A second tree that SHARES keys with the first: keyed siblings are
 *  shuffled/dropped/inserted, values and props change, components swap kind. */
function mutate(root: Spec, r: Rng): Spec {
  const t = clone(root);
  const all = containers(t);
  const steps = 1 + r.int(4);
  for (let i = 0; i < steps; i++) {
    const c = r.pick(all);
    const inB = c.k === "b" || r.chance(0.2);
    const op = r.int(6);
    if (op === 0 && c.kids.length > 1) {
      for (let j = c.kids.length - 1; j > 0; j--) {
        const m = r.int(j + 1);
        [c.kids[j], c.kids[m]] = [c.kids[m]!, c.kids[j]!];
      }
    } else if (op === 1 && c.kids.length > 0) {
      c.kids.splice(r.int(c.kids.length), 1);
    } else if (op === 2) {
      // A thrower is only legal under a boundary — `inB` is only true for one.
      c.kids.splice(
        r.int(c.kids.length + 1),
        0,
        gen(r, 1, c.k === "b" && inB, c.keyed),
      );
    } else if (op === 3 && c.k === "e") {
      c.pi = r.int(PROPS.length);
    } else if (op === 4 && c.k === "c") {
      c.c = r.pick<CompKind>(["str", "num", "null", "frag", "wrap"]);
      if (c.c !== "frag" && c.c !== "wrap") c.kids = [];
    } else {
      for (const x of c.kids) {
        if (x.k === "t") x.v = r.pick(TEXTS);
        else if (x.k === "ta") x.v = r.pick(["", "hi", "a b"]);
        else if (x.k === "sel") x.v = r.pick(["a", "b", "c"]);
        else if (x.k === "in") x.ii = r.int(INPUTS.length);
        else if (x.k === "x") x.when = r.pick(WHENS);
      }
    }
  }
  return t;
}

// ── the instrument's own coverage ────────────────────────────────────────

const SHAPES = [
  "fragment",
  "null-child",
  "false-child",
  "empty-string",
  "string",
  "number",
  "zero",
  "comp-str",
  "comp-num",
  "comp-null",
  "comp-frag",
  "comp-wrap",
  "keyed-list",
  "unkeyed-list",
  "svg-camel",
  "svg",
  "textarea",
  "select",
  "input-checked",
  "input-value",
  "button-disabled",
  "bool-attr",
  "style-empty",
  "style-string",
  "style-object",
  "class",
  "className",
  "boundary",
  "boundary-fallback-at-ssr",
  "throw-recover",
  "throw-start",
  "throw-always",
  "fallback-element",
  "fallback-string",
  "fallback-null",
  "fallback-fragment",
] as const;
type Shape = typeof SHAPES[number];
const seen = new Map<Shape, number>();
const see = (s: Shape) => seen.set(s, (seen.get(s) ?? 0) + 1);

function census(s: Spec): void {
  if ("kids" in s && s.kids.length > 1) {
    see(s.keyed ? "keyed-list" : "unkeyed-list");
  }
  switch (s.k) {
    case "t":
      if (s.v === "") see("empty-string");
      else if (s.v === 0) see("zero");
      else see(typeof s.v === "number" ? "number" : "string");
      break;
    case "z":
      see(s.v === null ? "null-child" : "false-child");
      break;
    case "f":
      see("fragment");
      break;
    case "c":
      see(`comp-${s.c}`);
      break;
    case "svg":
      see(s.vi % 3 === 0 ? "svg" : "svg-camel");
      break;
    case "ta":
      see("textarea");
      break;
    case "sel":
      see("select");
      break;
    case "in": {
      const p = INPUTS[s.ii % INPUTS.length]!;
      if ("checked" in p) see("input-checked");
      if ("value" in p) see("input-value");
      if (p.disabled) see("bool-attr");
      break;
    }
    case "btn":
      if (s.dis) see("button-disabled");
      break;
    case "e": {
      const p = PROPS[s.pi % PROPS.length]!;
      if (p.style === "") see("style-empty");
      else if (typeof p.style === "string") see("style-string");
      else if (p.style) see("style-object");
      if ("class" in p) see("class");
      if ("className" in p) see("className");
      if (p.hidden) see("bool-attr");
      break;
    }
    case "b": {
      see("boundary");
      see(
        ([
          "fallback-element",
          "fallback-string",
          "fallback-null",
          "fallback-fragment",
        ] as const)[
          s.fb % FALLBACKS.length
        ]!,
      );
      // Fallback at SSR: a DIRECT thrower that throws while flip is 0.
      if (s.kids.some((x) => x.k === "x" && x.when !== "s")) {
        see("boundary-fallback-at-ssr");
      }
      break;
    }
    case "x":
      see(
        s.when === "r"
          ? "throw-recover"
          : s.when === "s"
          ? "throw-start"
          : "throw-always",
      );
      break;
  }
  if ("kids" in s) { for (const c of s.kids) census(c); }
}

// ── the late SSR thrower ─────────────────────────────────────────────────
//
// Found by this gate: hydrating an `<ErrorBoundary>` whose SERVER render fell
// back, when the thrower is not the first thing its children hydrate. The
// markup at the boundary's slot IS the fallback, so every child before the
// thrower was hydrated against fallback markup — `h(EB, {fallback}, <span/>,
// <Boom/>)` met the fallback's `<b>` where it wanted `<span>` and `hydrate()`
// discarded the WHOLE server page (a dev warning; silent in prod), or, when
// nothing mismatched first, left debris (a null child's `<!---->` appended
// beside the fallback — seed 999 round 44). Fixed in renderer-hydrate.ts
// (`_Attempt`); these rounds assert everything, and the census below makes
// sure the generator keeps producing the shape.
let lateThrowerRounds = 0;

/** Does a thrower under `s` throw at SSR (`flip` 0) with no nearer boundary? */
function throwsAtSsr(s: Spec): boolean {
  if (s.k === "x") return s.when !== "s";
  if (s.k === "b") return false; // a nearer boundary catches it
  return "kids" in s && s.kids.some(throwsAtSsr);
}
/** Is the FIRST thing hydrated under these children the SSR-time thrower? */
function throwsFirst(kids: Spec[]): boolean {
  const k = kids[0];
  if (!k) return false;
  if (k.k === "x") return k.when !== "s";
  if (k.k === "f" || (k.k === "c" && k.c === "frag")) {
    return throwsFirst(k.kids);
  }
  return false;
}
/** LATE_SSR_THROWER: a boundary that falls back at SSR, whose thrower is not
 *  the first thing its children hydrate. */
function hasLateSsrThrower(s: Spec): boolean {
  if (s.k === "b" && s.kids.some(throwsAtSsr) && !throwsFirst(s.kids)) {
    return true;
  }
  return "kids" in s && s.kids.some(hasLateSsrThrower);
}

// ── comparing documents ──────────────────────────────────────────────────

let probe: HTMLElement | null = null;
/** The CSSOM is the one decider for what a style attribute MEANS: SSR spells
 *  `color:red`, `el.style` re-serializes `color: red;`. Same declarations —
 *  canonicalized, never dropped (`style=""` vs no attribute still differs). */
function canonStyle(css: string): string {
  probe!.style.cssText = css;
  return probe!.style.cssText;
}

/** Normalize markup for comparison. Everything below is a KNOWN, DOCUMENTED
 *  difference between markup the server wrote and markup the DOM built for
 *  the same live state; nothing else is touched, and the live state those
 *  attributes stand for is compared directly by {@link formState}:
 *
 *  - attribute ORDER — not semantic; a hydrated element keeps the server's
 *    order, a mounted one has the order `applyProps` wrote.
 *  - `<input value>` / `<input checked>` — the control's DEFAULT value /
 *    checkedness. SSR can only put a value on screen through them; the client
 *    assigns the live PROPERTY, which by the DOM spec never reflects back to
 *    the attribute. (renderer-differential.test.ts `normFormDefault`.)
 *  - `<option selected>` — SSR marks the option matching `<select value>`
 *    (vdom-ssr.ts); the client sets `select.value`, a property with no
 *    attribute. Same selection, two spellings.
 *  - `<textarea>` child text — a textarea has no `value` attribute, its
 *    DEFAULT value is its child text (vdom-ssr.ts `_ssrTextareaText`); the
 *    client assigns `.value`, which leaves the child text alone. The same
 *    default-vs-live split as `<input value>`.
 *  - style serialization — see {@link canonStyle}. */
function norm(html: string): string {
  return html
    .replace(
      /style="([^"]*)"/g,
      (_m, css: string) => `style="${canonStyle(css)}"`,
    )
    .replace(
      /<input\b[^>]*>/g,
      (tag) =>
        tag.replace(/\s(value="[^"]*"|checked(="[^"]*")?)(?=[\s/>])/g, ""),
    )
    .replace(
      /<option\b[^>]*>/g,
      (tag) => tag.replace(/\sselected(="[^"]*")?(?=[\s/>])/g, ""),
    )
    .replace(/(<textarea\b[^>]*>)[\s\S]*?(<\/textarea>)/g, "$1$2")
    .replace(
      /<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>/g,
      (_m, tag: string, attrs: string, close: string) => {
        const parts = attrs.match(/[^\s=]+(?:="[^"]*")?/g) ?? [];
        return `<${tag}${parts.length ? " " + parts.sort().join(" ") : ""}${
          close ? " /" : ""
        }>`;
      },
    );
}

/** The live state a user reads off the screen — what the normalized
 *  attributes above stand for, compared directly. */
function formState(root: Element): string[] {
  const out: string[] = [];
  for (const el of Array.from(root.querySelectorAll("input,textarea,select"))) {
    // deno-lint-ignore no-explicit-any
    const c = el as any;
    if (el.tagName === "INPUT") {
      out.push(`input|${c.type}|${c.value}|${c.checked}|${c.disabled}`);
    } else if (el.tagName === "TEXTAREA") out.push(`textarea|${c.value}`);
    else {
      // Which options are selected, read per OPTION — not `selectedIndex`:
      // happy-dom's parser leaves `selectedIndex` at -1 for markup with an
      // `<option selected>` (while `value` and `option.selected` are right),
      // which a browser never does. The per-option read is the same fact
      // without the emulator's stale cache.
      const opts = Array.from(c.options as ArrayLike<{ selected: boolean }>);
      out.push(`select|${c.value}|${opts.map((o) => +o.selected).join("")}`);
    }
  }
  return out;
}

/** A root's document, normalized, plus its live form state. */
function snap(host: Element): { html: string; form: string[] } {
  return { html: norm(host.innerHTML), form: formState(host) };
}

// ── the gate ─────────────────────────────────────────────────────────────

async function settle(...hs: MountHandle[]): Promise<void> {
  for (const x of hs) x._flush();
  await new Promise((r) => setTimeout(r, 0));
  for (const x of hs) x._flush();
}

async function freshMount(doc: Document, s: Spec): Promise<string> {
  // A fresh root of the same model. `tree` is shared by all roots, so every
  // live root would re-render to `s` too — which is exactly the state they are
  // meant to be in when this is called.
  tree.set(s);
  const host = doc.createElement("main");
  doc.body.appendChild(host);
  const handle = mount(host, App);
  await settle(handle);
  const out = norm(host.innerHTML);
  _unmount(handle);
  host.remove();
  return out;
}

Deno.test("air differential: SSR string == stream, mount == SSR+hydrate, and both follow the same updates", async () => {
  const win = new Window({ url: "https://localhost" });
  repairProxiedSiblings(win);
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  probe = doc.createElement("span");
  const origWarn = console.warn, origErr = console.error;
  let warns: string[] = [];
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(" "));
  // Caught render errors are logged by the boundary; they are the input here.
  console.error = () => {};
  const g = globalThis as Record<string, unknown>;
  const origDev = g.__aioDev;
  g.__aioDev = true;
  let rounds = 0,
    steps = 0,
    hydratedRounds = 0,
    recovered = 0,
    startedThrowing = 0;
  try {
    for (let round = 0; round < N; round++) {
      const seed = (SEED + round * 0x9E3779B9) >>> 0;
      const r = rngOf(seed);
      nextId = 1;
      const t1 = genRoot(r);
      const t2 = mutate(t1, r);
      census(t1);
      census(t2);
      const where = () =>
        `AIO_AIR_DIFF_SEED=${SEED} round ${round} (seed ${seed})\n  t1: ${
          JSON.stringify(t1)
        }\n  t2: ${JSON.stringify(t2)}`;

      tick.set(0);
      flip.set(0);
      tree.set(t1);
      // Ambient dev (`__aioDev`, what the test harness runs under), NOT
      // `setDevMode(true)`: the explicit form opts into `data-component`
      // stamping, a dev feature that CHANGES the DOM and that SSR never
      // writes (dev-flag.ts `isDevModeExplicit`). Off-then-auto re-arms the
      // once-per-id warning dedup so every round can warn afresh.
      setDevMode(false);
      setDevMode("auto");
      warns = [];

      // (a) the two SSR writers
      const ssr = renderToString(h(App, null));
      const chunks: string[] = [];
      for await (const c of renderToStream(h(App, null))) chunks.push(c);
      assertEquals(
        chunks.join(""),
        ssr,
        `renderToStream ≠ renderToString — ${where()}`,
      );

      // (b) mount vs the server's markup vs SSR + hydrate
      const mHost = doc.createElement("main");
      const hHost = doc.createElement("main");
      doc.body.append(mHost, hHost);
      const mh = mount(mHost, App);
      hHost.innerHTML = ssr;
      assertEquals(
        norm(hHost.innerHTML),
        norm(mHost.innerHTML),
        `the server's markup ≠ the mounted DOM — ${where()}`,
      );
      warns = [];
      const hh = hydrate(hHost, App);
      // (d) identical trees on both sides: hydrate must not report a
      // divergence (or fall back and discard the server's markup).
      if (hasLateSsrThrower(t1)) lateThrowerRounds++;
      assertEquals(
        warns.filter((w) => w.includes("hydrate()")),
        [],
        `hydrate reported a divergence for the SAME tree — ${where()}`,
      );
      assertEquals(
        snap(hHost),
        snap(mHost),
        `hydrated DOM ≠ mounted DOM — ${where()}`,
      );
      hydratedRounds++;

      const sameEverywhere = async (
        step: string,
        model: Spec,
        vsFresh: boolean,
      ) => {
        if (vsFresh) {
          const fresh = await freshMount(doc, model);
          await settle(mh, hh);
          assertEquals(
            snap(mHost).html,
            fresh,
            `${step}: mounted root ≠ a fresh mount of the same model — ${where()}`,
          );
        }
        assertEquals(
          snap(hHost),
          snap(mHost),
          `${step}: hydrated root ≠ mounted root — ${where()}`,
        );
        steps++;
      };

      // (c1) self re-render: only components re-run. `flip` 0→1 recovers
      // every thrower whose fallback the SERVER rendered.
      tick.set(1);
      flip.set(1);
      await settle(mh, hh);
      await sameEverywhere("c1 self re-render (recover)", t1, true);
      if (ssr.includes("boom-r")) recovered++;

      // (c2) whole-tree update to a second tree that shares keys with it.
      tree.set(t2);
      await settle(mh, hh);
      await sameEverywhere("c2 update to t2", t2, true);

      // (c3) `flip` 1→2: the `s` throwers START throwing on a self re-render.
      // The boundary renders its fallback IN THE THROWER'S PLACE and leaves its
      // other children alone (renderer-rerender.ts, "The boundary's other
      // children are untouched") — by design NOT what a fresh mount builds
      // (the whole region falls back), so this step compares the two live
      // roots only. That comparison is the one that matters: a hydrated
      // boundary that is not on the boundary stack does not catch at all.
      tick.set(2);
      flip.set(2);
      await settle(mh, hh);
      await sameEverywhere("c3 self re-render (start throwing)", t2, false);
      if (norm(hHost.innerHTML).includes("boom-s")) startedThrowing++;

      // (c4) `flip` 2→1: every `s` thrower recovers, and the two live roots
      // are back to exactly what a fresh mount of t2 builds.
      tick.set(3);
      flip.set(1);
      await settle(mh, hh);
      await sameEverywhere("c4 self re-render (recover again)", t2, true);

      _unmount(mh);
      _unmount(hh);
      mHost.remove();
      hHost.remove();
      rounds++;
    }
  } finally {
    console.warn = origWarn;
    console.error = origErr;
    g.__aioDev = origDev;
    setDevMode("auto");
    tree.set(null);
    await closeWindow(win);
  }
  console.log(
    `[air-diff] ${rounds} rounds, ${steps} update steps, ${hydratedRounds} ` +
      `hydrate-asserted (${lateThrowerRounds} with a late SSR thrower)`,
  );
  assertEquals(rounds, N, "every seeded round must run to its end");
  assertEquals(hydratedRounds, N, "every round must assert the hydrate side");
  assertEquals(steps, N * 4, "every round must compare all four update steps");
  // The instrument checks itself: a shape the generator never produced is a
  // shape this gate silently does not cover.
  const missing = SHAPES.filter((s) => !seen.get(s));
  assertEquals(missing, [], `generator shapes never produced: ${missing}`);
  assert(recovered > 0, "no server-rendered fallback was ever recovered");
  assert(
    N < 10 || lateThrowerRounds > 0,
    "the generator never produced a late SSR thrower",
  );
  assert(startedThrowing > 0, "no hydrated boundary ever caught a new throw");
});
