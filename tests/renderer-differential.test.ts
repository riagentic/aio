// Differential fuzzer: the INCREMENTAL renderer vs a FRESH render of the same
// model — and SSR+hydrate vs mount.
//
// A reconciler's whole promise is that `render(model_n)` and
// `render(model_0) + diff(model_1) + … + diff(model_n)` are the same document.
// Nothing in the code says so: the incremental path is a hand-written cursor
// walk over sibling nodes, and every defect it has is SILENT — the DOM stays
// well-formed, it is simply not the DOM the model describes. `testUI` cannot
// see it (it reads the vnode tree, which is correct by construction), and a
// unit test only sees the shapes someone already thought of.
//
// So the class is pinned by construction instead: random trees, random
// structural mutations, and after EVERY step the incrementally-diffed DOM must
// equal a fresh render of the same model, byte for byte. The shapes in the op
// set are the ones that broke — bare text siblings with COLLIDING values (the
// reconciler used to find an old text node by scanning for equal content, so
// two `{" "}` separators or two equal numbers reconciled into each other),
// empty fragments (a container that must hold its slot with a comment anchor),
// null children, components that render a bare string, and 0-node children
// (Portal / component → null) that a cursor must step OVER, not past.
//
// The hydrate axis exists because bug class #3 is invisible to `mount`: SSR
// emitted nothing for an empty Fragment while `createDom` emits an anchor, so a
// hydrated list that starts empty grew ABOVE its header. `renderToString` and
// `hydrate` are public API; they must produce the same document as `mount`.
//
// A failure prints the seed, the round, the step and both models, so anything a
// sweep finds comes back as a one-line repro.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { fuzzEnvInt } from "./fuzz-seed.ts";
import {
  ErrorBoundary,
  Fragment,
  h,
  renderToString,
  Suspense,
  type VNode,
} from "../src/air/vdom.ts";
import { _diff, _render } from "../src/air/vdom.ts";
import { setDevMode } from "../src/air/aio-renderer.ts";
import { _hydrateNode } from "../src/air/renderer-hydrate.ts";
import { renderToStream } from "../src/air/ssr-stream.ts";
import { signal } from "../src/state/signal.ts";
import { lazy } from "../src/air/vdom-lazy.ts";

// The seed is FIXED by default — CI must explore the same programs on every
// run, or a red build is not reproducible from its own commit. `FUZZ_SEED` /
// `FUZZ_ROUNDS` let a sweep explore beyond them:
//
//     for s in 1 7 31 99 12345; do FUZZ_SEED=$s deno test -A \
//       tests/renderer-differential.test.ts; done
const SEED = fuzzEnvInt("FUZZ_SEED", 0x5eeda12d) & 0x7fffffff;
const ROUNDS = fuzzEnvInt("FUZZ_ROUNDS", 150, 1);
const STEPS = fuzzEnvInt("FUZZ_STEPS", 6, 1);

// ── the model ────────────────────────────────────────────────────────────

/** A tree spec. `id` is stable across mutations so keys travel with the node.
 *  `keyed` lives on the PARENT (all kids keyed or none — mixed keys are an app
 *  bug with documented degradation, not a reconciler contract); `keyedKey` is
 *  that flag projected onto each child just before building. */
type Base = { id: number; keyedKey?: string };
/** How a container keys its children.
 *  `NONE` — positional reconciliation.
 *  `STABLE` — a key that travels with the child (`key={row.id}`), the shape
 *  keyed diffing exists for.
 *  `INDEX` — `key={i}`: the key COLLIDES with the ordinal, so a head insert
 *  silently re-labels every sibling and the reconciler matches row 0's old
 *  vnode against row 1's new one. The document must still come out right (that
 *  is the reconciler's job); only node identity is forfeit, which is why
 *  `key={i}` is a hazard and not a bug. It was absent from the alphabet
 *  entirely, so nothing ever drove the two child-diff algorithms with keys that
 *  MOVE between renders while the children stay put. */
const NONE = 0, STABLE = 1, INDEX = 2;
type Spec =
  | (Base & { k: "t"; v: string })
  | (Base & { k: "x" }) // null child → _Null placeholder
  | (Base & { k: "e"; tag: string; pi: number; keyed: number; kids: Spec[] })
  | (Base & { k: "s" }) // an SVG subtree — namespaced element + kebab attrs
  | (Base & { k: "i"; ii: number }) // a VOID form control — <input>
  | (Base & { k: "u"; keyed: number; kids: Spec[]; boom?: boolean }) // Suspense
  | (Base & { k: "f"; keyed: number; kids: Spec[] })
  | (Base & { k: "b"; keyed: number; kids: Spec[]; boom?: boolean }) // ErrorBoundary
  | (Base & { k: "c"; c: number; keyed: number; kids: Spec[] });

// Every prop shape below must serialize IDENTICALLY through SSR and through
// `applyProps`, because both differentials compare `innerHTML`. That is itself
// the property: an attribute rule that lives in two places (the SSR writer and
// the DOM patcher) is one edit away from producing two different documents for
// the same vnode, and the divergence is invisible until a user hydrates.
// `t` is here because it is the semantic marker BOTH sides must drop; `onClick`
// because SSR must drop it and hydrate must attach it.
let _clicks = 0;
const CLICK = () => {
  _clicks++;
};
const PROPS: Record<string, unknown>[] = [
  {},
  { id: "i" },
  { className: "c1 c2" },
  { className: ["c1", "c2"] },
  { title: "ti", "data-n": "1" },
  { style: "color:red" },
  { style: { color: "red", marginTop: 2 } },
  { hidden: true },
  { disabled: true }, // a boolean-ish attr on an element that has no such prop
  { t: "Marker" },
  { onClick: CLICK, "data-c": "1" },
];

/** Deliberately tiny so sibling text COLLIDES — equal-valued siblings are the
 *  shape a content scan cannot tell apart, and `{" "}` separators, repeated
 *  labels and equal numbers make them ordinary rather than exotic. */
const TEXTS = ["a", "a", "b", " ", "1", "1", "x"];
const TAGS = ["div", "p", "i"];

/** Prop sets for the `<input>` leaf — the props that are DOM PROPERTIES on a
 *  form control (`value`, `checked`, `readOnly`) and the ones SSR writes as
 *  bare boolean tokens (`checked`, `disabled`, `readOnly`, `multiple`). */
const INPUTS: Record<string, unknown>[] = [
  { type: "text" },
  { type: "text", value: "v1" },
  { type: "text", value: "v2", placeholder: "p" },
  { type: "checkbox", checked: true },
  { type: "checkbox" },
  { type: "text", disabled: true, readOnly: true },
  { type: "text", value: "v1", disabled: false },
];

// Components are module-level so their identity is stable across renders (a
// fresh closure would be a different `tag` and force a replace, hiding the
// diff paths this exists to test).
// deno-lint-ignore no-explicit-any
type P = any;
/** Renders a BARE STRING — owns a text node that `getDom` cannot see. */
const CText = (p: P) => String(p.v);
/** Renders an element around its children. */
const CWrap = (p: P) => h("span", null, ...(p.children ?? []));
/** Renders a Fragment — a region nested inside another region. */
const CFrag = (p: P) => h(Fragment, null, ...(p.children ?? []));
/** Renders nothing — occupies ZERO nodes; a cursor must not step over it. */
const CNull = () => null;
const COMPS = [CText, CWrap, CFrag, CNull];

/** Throws on render — the only way to reach an ErrorBoundary's FALLBACK, which
 *  is decided separately in all five commit paths (createDom, renderToString,
 *  renderToStream, hydrate, diff). Nothing in the alphabet ever failed, so the
 *  fallback branches — including the one where a hydrating boundary must claim
 *  the fallback markup the server already wrote — were never driven. */
const CThrow = () => {
  throw new Error("boom");
};
/** Never resolves, so it is permanently `_LAZY_PENDING` — the Suspense
 *  equivalent: the fallback is what every path must render. */
const CPending = lazy(() => new Promise<never>(() => {}));
/** Module-level so the fallback's identity is stable across renders. */
const EB_FALLBACK = () => h("b", null, "!");
const SUSPENSE_FALLBACK = "…";

/** Stamp `data-sid` on every element — see `case "e"`. Only the identity test
 *  turns this on. */
let _stampSid = false;

function build(s: Spec): VNode | string | null {
  const key = s.keyedKey;
  switch (s.k) {
    case "t":
      return s.v;
    case "x":
      return null;
    case "s":
      // SVG: a namespaced element with a camelCase attr that must stay
      // camelCase (`viewBox`) and one that must become kebab (`strokeWidth` →
      // `stroke-width`). SSR and applyProps both go through `svgAttrName`; if
      // either stopped, this renders a differently-attributed document.
      return h(
        "svg",
        { viewBox: "0 0 8 8", ...(key ? { key } : {}) },
        h("circle", { cx: 4, cy: 4, r: 3, strokeWidth: 2, fillOpacity: "0.5" }),
      );
    case "i":
      // A VOID element (`renderToString` self-closes it, `createDom` cannot put
      // children in it) that is ALSO a form control, so its props are the ones
      // that become DOM PROPERTIES rather than attributes (`value`, `checked`,
      // `disabled`, `readOnly`) and the ones SSR emits as bare boolean tokens.
      // Neither shape existed in the alphabet: TAGS was div/p/i, so nothing
      // here ever crossed the `k in el && _DOM_PROPS.has(k)` branch of
      // `_writeProp`, the `_BOOL_ATTR_TAGS` branch of the SSR writer, or the
      // VOID_ELEMENTS branch of either.
      return h("input", {
        ...INPUTS[s.ii % INPUTS.length],
        ...(key ? { key } : {}),
      });
    case "u":
      // Suspense is the third REGION container. It has its own branch in every
      // commit path (createDom / renderToString / renderToStream / hydrate /
      // diff) — the same shape as ErrorBoundary, decided separately five times.
      return h(
        Suspense as never,
        { fallback: SUSPENSE_FALLBACK, ...(key ? { key } : {}) },
        ...(s.boom ? [h(CPending, null)] : []),
        ...s.kids.map(build),
      );
    case "e":
      // `data-sid` is the model's id carried into the document — the only way
      // to ask the DOM "which node is spec 7 sitting in NOW", which is what the
      // identity oracle at the bottom of this file needs and what innerHTML
      // equality can never answer. It is stamped ONLY for that test: an
      // attribute that survives a whole-prop-set swap while its neighbours are
      // removed and re-added lands in a different attribute ORDER than a fresh
      // render produces, and order is not semantic — the other tests compare
      // markup byte for byte and must keep doing so.
      return h(
        s.tag,
        {
          ...PROPS[s.pi % PROPS.length],
          ...(_stampSid ? { "data-sid": String(s.id) } : {}),
          ...(key ? { key } : {}),
        },
        ...s.kids.map(build),
      );
    case "f":
      return h(Fragment, key ? { key } : null, ...s.kids.map(build));
    case "b":
      // An ErrorBoundary is a REGION like a Fragment, but it is decided in its
      // own branch of every commit path (mount / SSR / hydrate / diff) — so it
      // gets its own coverage rather than being assumed equivalent.
      return h(
        ErrorBoundary as never,
        { fallback: EB_FALLBACK, ...(key ? { key } : {}) },
        ...(s.boom ? [h(CThrow, null)] : []),
        ...s.kids.map(build),
      );
    case "c": {
      const C = COMPS[s.c]!;
      const props: Record<string, unknown> = key ? { key } : {};
      if (C === CText) props.v = s.kids.map(textOf).join("") || "t";
      return h(C as never, props, ...s.kids.map(build));
    }
  }
}
function textOf(s: Spec): string {
  return s.k === "t" ? s.v : "";
}

// ── generation ───────────────────────────────────────────────────────────

function makeRnd(seed: number) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  return {
    rnd,
    pick: (n: number) => Math.floor(rnd() * n),
    of: <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!,
  };
}
type Rnd = ReturnType<typeof makeRnd>;

let _nextId = 1;
const el = (r: Rnd, kids: Spec[]): Spec => ({
  k: "e",
  id: _nextId++,
  tag: r.of(TAGS),
  pi: r.pick(PROPS.length),
  keyed: NONE,
  kids,
});

function leaf(r: Rnd): Spec {
  const roll = r.pick(13);
  if (roll < 4) return { k: "t", id: _nextId++, v: r.of(TEXTS) };
  if (roll < 5) return { k: "x", id: _nextId++ };
  if (roll < 6) return { k: "s", id: _nextId++ };
  if (roll < 7) return { k: "i", id: _nextId++, ii: r.pick(INPUTS.length) };
  if (roll < 9) {
    return { k: "c", id: _nextId++, c: r.pick(4), keyed: NONE, kids: [] };
  }
  return el(r, []);
}

function gen(r: Rnd, depth: number): Spec {
  if (depth <= 0) return leaf(r);
  const n = r.pick(4); // 0..3 — 0 exercises EMPTY containers
  const kids = Array.from({ length: n }, () => gen(r, depth - 1));
  const roll = r.pick(11);
  if (roll < 4) return el(r, kids);
  if (roll < 6) return { k: "f", id: _nextId++, keyed: NONE, kids };
  if (roll < 7) {
    return { k: "b", id: _nextId++, keyed: NONE, kids, boom: r.pick(4) === 0 };
  }
  if (roll < 8) {
    return { k: "u", id: _nextId++, keyed: NONE, kids, boom: r.pick(4) === 0 };
  }
  if (roll < 10) {
    return { k: "c", id: _nextId++, c: r.pick(3), keyed: NONE, kids };
  }
  return leaf(r);
}

function genRoot(r: Rnd): Spec {
  const kids = Array.from({ length: 1 + r.pick(4) }, () => gen(r, 2));
  return r.pick(2) === 0
    ? {
      k: "e",
      id: _nextId++,
      tag: "div",
      pi: r.pick(PROPS.length),
      keyed: NONE,
      kids,
    }
    : { k: "f", id: _nextId++, keyed: NONE, kids };
}

// ── mutation ─────────────────────────────────────────────────────────────

type Container = Extract<Spec, { kids: Spec[] }>;
const isContainer = (s: Spec): s is Container => "kids" in s;

function clone(s: Spec): Spec {
  return isContainer(s) ? { ...s, kids: s.kids.map(clone) } : { ...s };
}
function containers(s: Spec, out: Container[] = []): Container[] {
  if (isContainer(s)) {
    out.push(s);
    for (const k of s.kids) containers(k, out);
  }
  return out;
}
/** Every COMPONENT node in the tree — the targets for op 13.
 *
 *  `containers()` walks containers, `texts()` walks text leaves; a component
 *  had no collector at all, which is why no mutation could ever change one IN
 *  PLACE. That gap is what let rimote R-10 ship: `CNull` was in the component
 *  alphabet from the start, so the fuzzer could BUILD a component that renders
 *  nothing — it just could never make an existing one start or stop doing so,
 *  and that transition is the entire bug. A fuzzer is only as strong as its op
 *  set, and an op set nobody audits is a coverage claim nobody checked. */
function comps(s: Spec, out: Extract<Spec, { k: "c" }>[] = []) {
  if (s.k === "c") out.push(s);
  if (isContainer(s)) { for (const k of s.kids) comps(k, out); }
  return out;
}
function texts(s: Spec, out: Extract<Spec, { k: "t" }>[] = []) {
  if (s.k === "t") out.push(s);
  else if (isContainer(s)) { for (const k of s.kids) texts(k, out); }
  return out;
}

/** One random structural edit. Every op is a shape that has broken the
 *  reconciler: reorder (positional identity), text edits over a colliding
 *  alphabet, emptying/filling containers (anchors), keying/unkeying (the two
 *  child-diff algorithms), and retagging (type mismatch replacement). */
function mutate(root: Spec, r: Rnd): Spec {
  const next = clone(root);
  const cs = containers(next);
  const op = r.pick(15);
  const c = r.of(cs);
  switch (op) {
    case 11: // swap an element's whole prop set (add/remove/replace attributes)
      if (c.k === "e") c.pi = r.pick(PROPS.length);
      break;
    case 0: { // retarget a text value (often colliding with a sibling)
      const ts = texts(next);
      if (ts.length) r.of(ts).v = r.of(TEXTS);
      break;
    }
    case 1: { // swap two siblings
      if (c.kids.length >= 2) {
        const i = r.pick(c.kids.length), j = r.pick(c.kids.length);
        [c.kids[i], c.kids[j]] = [c.kids[j]!, c.kids[i]!];
      }
      break;
    }
    case 2: // rotate
      if (c.kids.length >= 2) c.kids.push(c.kids.shift()!);
      break;
    case 3: // insert
      c.kids.splice(r.pick(c.kids.length + 1), 0, gen(r, 1));
      break;
    case 4: // remove
      if (c.kids.length) c.kids.splice(r.pick(c.kids.length), 1);
      break;
    case 5: // replace a child wholesale
      if (c.kids.length) c.kids[r.pick(c.kids.length)] = gen(r, 1);
      break;
    case 6: // empty it out
      c.kids = [];
      break;
    case 7: // fill an empty one
      if (!c.kids.length) {
        c.kids = Array.from({ length: 1 + r.pick(2) }, () => leaf(r));
      }
      break;
    case 8: // re-key the whole child list — none / stable / by INDEX
      c.keyed = r.pick(3);
      break;
    case 9: // retag an element
      if (c.k === "e") c.tag = r.of(TAGS);
      break;
    case 12: // flip a boundary into / out of its FALLBACK
      if (c.k === "b" || c.k === "u") c.boom = !c.boom;
      break;
    case 14: { // a form control's PROP SET changes in place
      // Found by the coverage gate above, the same shape as R-10: `i` nodes
      // could be generated with a prop set and never given a different one,
      // so `value`/`checked`/`disabled`/`readOnly` — the props that become DOM
      // PROPERTIES rather than attributes, and that SSR writes as bare boolean
      // tokens — were never diffed from one set to another on the same node.
      const is: Extract<Spec, { k: "i" }>[] = [];
      const walk = (n: Spec) => {
        if (n.k === "i") is.push(n);
        if (isContainer(n)) { for (const k of n.kids) walk(k); }
      };
      walk(next);
      if (is.length) {
        const t = r.of(is);
        t.ii = (t.ii + 1 + r.pick(INPUTS.length - 1)) % INPUTS.length;
      }
      break;
    }
    case 13: { // the SAME component starts/stops rendering null (rimote R-10)
      // In place — same spec id, same position, same siblings. That is the
      // distinction from op 5 (replace wholesale), which swaps in a NEW node
      // and therefore never exercises "this component's output appeared or
      // vanished". A component with no DOM of its own has no position anchor,
      // so the element it later returns can only be appended — which is how a
      // prompt written first rendered last, under every framework test that
      // starts in the visible state.
      const cn = comps(next);
      if (cn.length) {
        const t = r.of(cn);
        t.c = (t.c + 1 + r.pick(COMPS.length - 1)) % COMPS.length;
      }
      break;
    }
    case 10: // wrap a child in a fragment (new region mid-list)
      if (c.kids.length) {
        const i = r.pick(c.kids.length);
        c.kids[i] = {
          k: "f",
          id: _nextId++,
          keyed: NONE,
          kids: [c.kids[i]!],
        };
      }
      break;
  }
  return next;
}

/** Project the parent's `keyed` flag onto each child as a stable key. */
function applyKeys(s: Spec, key?: string): void {
  s.keyedKey = key;
  if (isContainer(s)) {
    s.kids.forEach((k, i) =>
      applyKeys(
        k,
        s.keyed === STABLE
          ? `k${k.id}`
          : s.keyed === INDEX
          ? `i${i}`
          : undefined,
      )
    );
  }
}
function toVNode(s: Spec): VNode {
  applyKeys(s);
  return build(s) as VNode;
}

// ── harness ──────────────────────────────────────────────────────────────

/** Canonicalize `style="…"` before comparing SSR-parsed markup with markup the
 *  DOM built: SSR writes the declaration text verbatim (`color:red`) while
 *  `style.cssText` re-serializes it (`color: red;`). Same document, two
 *  spellings — the DOM owns that serialization and neither side is wrong.
 *  Nothing ELSE is normalized: every other difference is a real one. */
function normStyle(html: string): string {
  return html.replace(
    /style="([^"]*)"/g,
    (_m, css: string) =>
      `style="${
        css.split(";").map((d) => d.trim().replace(/:\s+/, ":")).filter(Boolean)
          .join(";")
      }"`,
  );
}

function freshHost(doc: Document, s: Spec): Element {
  const host = doc.createElement("main");
  _render(host, toVNode(clone(s)), null, { doc });
  return host as unknown as Element;
}
function fresh(doc: Document, s: Spec): string {
  return freshHost(doc, s).innerHTML;
}

/** Drop a form control's DEFAULT attributes before comparing SSR-derived markup
 *  with markup the DOM built.
 *
 *  `<input value="…">` and `<input checked>` are the control's DEFAULT value
 *  and checkedness. SSR has no other way to put a value on screen before JS
 *  runs, so it must emit them; assigning `el.value` on the client sets the LIVE
 *  property and — by the DOM spec — does not reflect back to the attribute. The
 *  same control in the same live state therefore has two markup spellings, and
 *  neither is wrong.
 *
 *  So the attribute pair is normalized here and the thing that actually decides
 *  what the user sees is compared DIRECTLY instead — {@link formState}, which
 *  reads the live properties innerHTML equality can never see. This is the only
 *  normalization besides `style` serialization; every other difference is real.
 *  (The remaining divergence is behavioural and narrow: `form.reset()` restores
 *  the server's values on a hydrated page and empty ones on a client-mounted
 *  one. If that is ever unified, delete this and the markup will match.) */
function normFormDefault(html: string): string {
  return html.replace(
    /<input\b[^>]*>/g,
    (tag) => tag.replace(/\s(value="[^"]*"|checked(="[^"]*")?)(?=[\s>])/g, ""),
  );
}

/** Every `<input>`'s LIVE state, in document order — the properties a user
 *  reads off the screen and a form submits, none of which appear in markup. */
function formState(root: Element): string[] {
  return Array.from(root.querySelectorAll("input")).map((el) => {
    const i = el as unknown as HTMLInputElement;
    return `${i.type}|${i.value}|${i.checked}|${i.disabled}|${i.readOnly}`;
  });
}

const seen: string[] = [];

// ── the fuzzer's own coverage gate ───────────────────────────────────────
//
// A differential fuzzer is only as strong as its OP SET, and an op set nobody
// audits is a coverage claim nobody checked. rimote R-10 proved the cost: a
// component that renders `null` was in the NODE alphabet from the start
// (`CNull`), so the fuzzer could build one — but no mutation could make an
// existing component start or stop rendering nothing, and that TRANSITION is
// the entire bug. It shipped, and a user found it when an approval prompt
// rendered off the bottom of their window.
//
// So the alphabet checks itself: every node kind the generator can produce
// must be REACHABLE BY A MUTATION. Adding a kind without a way to change one
// in place fails here, at the moment the kind is added, instead of in someone
// else's app.
Deno.test("differential: every node kind the generator makes, a mutation can change", () => {
  const KINDS = ["t", "x", "e", "s", "i", "u", "f", "b", "c"] as const;
  // A kind is "reached" when some mutation changed a node of that kind IN
  // PLACE — same id, different content. Wholesale replacement (op 5) does not
  // count: it swaps in a new node and so never exercises a transition.
  const touched = new Set<string>();
  const index = (s: Spec, out = new Map<number, Spec>()): Map<number, Spec> => {
    out.set(s.id, s);
    if (isContainer(s)) { for (const k of s.kids) index(k, out); }
    return out;
  };
  const r = makeRnd(0x5eed);
  for (let round = 0; round < 4000; round++) {
    const before = genRoot(r);
    const after = mutate(before, r);
    const bi = index(before), ai = index(after);
    for (const [id, b] of bi) {
      const a = ai.get(id);
      if (!a || a.k !== b.k) continue; // gone, or replaced wholesale
      if (JSON.stringify(a) !== JSON.stringify(b)) touched.add(b.k);
    }
  }
  // `x` (a null child) and `s` (an SVG subtree) carry no mutable fields at
  // all — their only meaningful transition is being replaced, which op 5
  // already does. Exempted explicitly rather than silently: if either ever
  // gains a field, delete it from here and give it an op.
  const CONTENT_FREE = new Set(["x", "s"]);
  const missing = KINDS.filter((k) => !touched.has(k) && !CONTENT_FREE.has(k));
  assertEquals(
    missing,
    [],
    `these node kinds can be GENERATED but never MUTATED, so the fuzzer can ` +
      `never test a transition into or out of them — the exact gap that let ` +
      `a null-rendering component ship a positional bug. Add an op in ` +
      `mutate() that changes one in place.`,
  );
});

Deno.test("differential: incremental diff renders what a fresh render would", () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => {
    const s = a.map(String).join(" ");
    // The dev tripwire is part of the contract under test: it must fire on a
    // desync AND stay silent on every correct render, or it is decoration.
    if (/desync|wrong slot|no position|leftover/.test(s)) warnings.push(s);
  };
  try {
    for (let round = 0; round < ROUNDS; round++) {
      setDevMode(false); // resets the once-per-id warning dedup
      setDevMode(true);
      const r = makeRnd((SEED + round * 7919) & 0x7fffffff);
      _nextId = 1;
      let spec = genRoot(r);
      const history: Spec[] = [clone(spec)];

      const host = doc.createElement("main");
      let prev = toVNode(clone(spec));
      _render(host, prev, null, { doc });
      const repro = (step: number, why: string) =>
        `FUZZ_SEED=${SEED} round ${round} step ${step}: ${why}\n  models: ${
          JSON.stringify(history.map(strip))
        }`;
      assertEquals(
        host.innerHTML,
        fresh(doc, spec),
        repro(0, "initial render"),
      );

      for (let step = 1; step <= STEPS; step++) {
        spec = mutate(spec, r);
        history.push(clone(spec));
        const nextV = toVNode(clone(spec));
        _diff(host, nextV, prev, { doc });
        prev = nextV;
        assertEquals(
          host.innerHTML,
          fresh(doc, spec),
          repro(step, "incremental DOM ≠ fresh render"),
        );
        assertEquals(
          warnings,
          [],
          repro(step, `dev tripwire fired: ${warnings.join(" | ")}`),
        );
        seen.push(host.innerHTML);
      }
    }
  } finally {
    setDevMode(false);
    console.warn = origWarn;
    win.happyDOM.close();
  }
  // A fuzzer that explored nothing is a vacuous green (see fuzz-seed.ts).
  assert(
    new Set(seen).size > ROUNDS / 2,
    `only ${new Set(seen).size} distinct documents over ${
      ROUNDS * STEPS
    } steps — the generator collapsed`,
  );
});

Deno.test("differential: SSR + hydrate + diff renders what mount would", () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  let hydrated = 0, fellBack = 0;
  try {
    for (let round = 0; round < ROUNDS; round++) {
      const r = makeRnd((SEED + round * 104729) & 0x7fffffff);
      _nextId = 1;
      let spec = genRoot(r);
      const history: Spec[] = [clone(spec)];
      const repro = (step: number, why: string) =>
        `FUZZ_SEED=${SEED} round ${round} step ${step}: ${why}\n  models: ${
          JSON.stringify(history.map(strip))
        }`;

      const host = doc.createElement("main");
      let prev = toVNode(clone(spec));
      host.innerHTML = renderToString(prev);
      const consumed = _hydrateNode(host, prev, { doc }, false, 0);
      if (consumed < 0) {
        // Same recovery the public `hydrate()` performs on a mismatch.
        fellBack++;
        host.innerHTML = "";
        _render(host, prev, null, { doc });
      } else {
        hydrated++;
      }
      const cmp = (step: number, why: string) => {
        const ref = freshHost(doc, spec);
        assertEquals(
          normFormDefault(normStyle(host.innerHTML)),
          normFormDefault(normStyle(ref.innerHTML)),
          repro(step, why),
        );
        // The live form state is NOT in the markup — a control can carry the
        // right attributes and still show the wrong value.
        assertEquals(
          formState(host as unknown as Element),
          formState(ref),
          repro(step, `${why} (live form state)`),
        );
      };
      cmp(0, "hydrated DOM ≠ mounted DOM");

      for (let step = 1; step <= STEPS; step++) {
        spec = mutate(spec, r);
        history.push(clone(spec));
        const nextV = toVNode(clone(spec));
        _diff(host, nextV, prev, { doc });
        prev = nextV;
        cmp(step, "post-hydrate diff ≠ fresh render");
      }
    }
  } finally {
    win.happyDOM.close();
  }
  // If every round fell back to a full render, this suite proved only that the
  // fallback works — the hydrate path itself would be untested.
  assert(
    hydrated > ROUNDS / 10,
    `only ${hydrated}/${
      hydrated + fellBack
    } rounds hydrated without falling back — the hydrate path is not being exercised`,
  );
});

/** Compact a spec for a repro line (drop the projected keys). */
// deno-lint-ignore no-explicit-any
function strip(s: Spec): any {
  const { keyedKey: _k, ...rest } = s;
  // deno-lint-ignore no-explicit-any
  const o = rest as any;
  if (o.kids) o.kids = o.kids.map(strip);
  return o;
}

// ── hydration is a NO-OP on markup the server itself wrote ────────────────
//
// The two differentials above compare DOCUMENTS. That is necessary and not
// sufficient: `hydrate()` recovers from any mismatch by wiping the root and
// client-rendering it, which produces a byte-identical document while throwing
// away everything SSR is for — the server markup, the paint already on screen,
// and (in prod) with no diagnostic at all. A green "hydrated DOM ≠ mounted DOM"
// can therefore mean "hydration works" OR "hydration never happens".
//
// So this pins the property directly: on markup produced by aio's own SSR,
// hydration must ADOPT it. No fallback, every element node the parser built is
// the node the vnode tree ends up pointing at (never re-created), every handler
// is live, and the first update patches those same nodes instead of replacing
// them. The shape that broke it was the most ordinary one there is — two
// adjacent text children (`{"Hello "}{name}`), which HTML parsing merges into a
// single node that the hydrator then could not split.
Deno.test("differential: hydrate ADOPTS the server's markup — no fallback, no node re-created", () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  let elementsAdopted = 0, clicksProven = 0;
  try {
    for (let round = 0; round < ROUNDS; round++) {
      const r = makeRnd((SEED + round * 15485863) & 0x7fffffff);
      _nextId = 1;
      const spec = genRoot(r);
      const repro = (why: string) =>
        `FUZZ_SEED=${SEED} round ${round}: ${why}\n  model: ${
          JSON.stringify(strip(clone(spec)))
        }`;

      const host = doc.createElement("main");
      const prev = toVNode(clone(spec));
      host.innerHTML = renderToString(prev);
      const before = elementsOf(host);

      const consumed = _hydrateNode(host, prev, { doc }, false, 0);
      assert(
        consumed >= 0,
        repro(
          "hydrate() reported a mismatch and would have discarded the server " +
            "HTML for a full client render",
        ),
      );

      const after = elementsOf(host);
      assertEquals(
        after.length,
        before.length,
        repro("hydration changed the element count"),
      );
      for (let i = 0; i < before.length; i++) {
        assert(
          after[i] === before[i],
          repro(
            `element ${i} (<${
              before[i]!.tagName.toLowerCase()
            }>) was re-created by hydration`,
          ),
        );
      }
      elementsAdopted += before.length;

      // Every handler the vnode tree declares must be live on the adopted node.
      for (const target of host.querySelectorAll("[data-c]")) {
        const seen = _clicks;
        // Non-bubbling: hydrate attaches per-element listeners here (there is
        // no active root, so no delegation), and a bubbling click would also
        // fire every handler-bearing ANCESTOR. Delegation via the public
        // `hydrate()` is covered separately.
        target.dispatchEvent(
          new win.Event("click", { bubbles: false }) as unknown as Event,
        );
        assertEquals(
          _clicks,
          seen + 1,
          repro(
            `onClick on the hydrated <${target.tagName.toLowerCase()}> ` +
              `did not fire — the markup was adopted but the handler was not`,
          ),
        );
        clicksProven++;
      }

      // …and the next update patches THOSE nodes. A hydrate that attaches to
      // the markup but leaves the vnodes without `_dom` looks perfect until the
      // first render, which then rebuilds the page underneath the user.
      const nextSpec = clone(spec);
      const ts = texts(nextSpec);
      if (ts.length) ts[0]!.v = "ZZ";
      const nextV = toVNode(clone(nextSpec));
      _diff(host, nextV, prev, { doc });
      const patched = elementsOf(host);
      assertEquals(
        patched.length,
        before.length,
        repro("the first post-hydrate update changed the element count"),
      );
      for (let i = 0; i < before.length; i++) {
        assert(
          patched[i] === before[i],
          repro(
            `the first post-hydrate update replaced element ${i} (<${
              before[i]!.tagName.toLowerCase()
            }>) instead of patching it`,
          ),
        );
      }
      const ref = freshHost(doc, nextSpec);
      assertEquals(
        normFormDefault(normStyle(host.innerHTML)),
        normFormDefault(normStyle(ref.innerHTML)),
        repro("post-hydrate update ≠ fresh render"),
      );
      assertEquals(
        formState(host as unknown as Element),
        formState(ref),
        repro("post-hydrate update ≠ fresh render (live form state)"),
      );
    }
  } finally {
    win.happyDOM.close();
  }
  // Negative evidence is worthless if the sweep touched nothing.
  assert(
    elementsAdopted > ROUNDS,
    `only ${elementsAdopted} elements adopted over ${ROUNDS} rounds`,
  );
  assert(clicksProven > 0, "no hydrated handler was ever exercised");
});

/** Every element under `root`, in document order — identity, not markup. */
function elementsOf(root: Node): Element[] {
  const out: Element[] = [];
  const walk = (n: Node) => {
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType === 1) {
        out.push(c as Element);
        walk(c);
      }
    }
  };
  walk(root);
  return out;
}

// ── the two SSR writers are one document ─────────────────────────────────
//
// `renderToString` and `renderToStream` are separate implementations of the
// same output, and each used to carry its own copy of the attribute loop. They
// drifted: the streaming writer kept emitting the `t` semantic marker after the
// string writer stopped, so which entry point the server happened to use
// decided whether the page carried attributes the client renderer never
// produces. One shape-specific parity test existed (an empty Fragment); this
// asserts the whole class over every tree the generator can build.
Deno.test("differential: renderToStream emits exactly what renderToString does", async () => {
  for (let round = 0; round < ROUNDS; round++) {
    const r = makeRnd((SEED + round * 32452843) & 0x7fffffff);
    _nextId = 1;
    const spec = genRoot(r);
    const v = toVNode(clone(spec));
    const chunks: string[] = [];
    for await (const c of renderToStream(v)) chunks.push(c);
    assertEquals(
      chunks.join(""),
      renderToString(toVNode(clone(spec))),
      `FUZZ_SEED=${SEED} round ${round}: the streaming and string SSR writers ` +
        `produced different HTML\n  model: ${
          JSON.stringify(strip(clone(spec)))
        }`,
    );
  }
});

// ── a signal value is a value ────────────────────────────────────────────
//
// `class={x}` and `class={someSignal}` describe the same element, and a signal
// prop takes a different code path to the DOM (a per-prop effect, not the diff).
// That path used to carry its OWN copy of the prop→DOM rule, and the copies
// disagreed: no `svgAttrName` mapping (`strokeWidth` landed as an attribute SVG
// ignores, so the stroke never changed) and no `k in el` guard (`disabled` on a
// non-form element became an invisible JS expando instead of the attribute the
// server rendered). Every difference was silent and none of it was reachable
// from a test that used only one of the two forms — so the equivalence is
// asserted directly, for every prop shape the fuzzer knows plus the SVG ones.
Deno.test("differential: a signal-valued prop renders exactly what the plain value does", () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  let compared = 0;
  try {
    const shapes: Array<[string, Record<string, unknown>]> = [
      ...PROPS.filter((p) => !("onClick" in p)).map((p) =>
        ["div", p] as [string, Record<string, unknown>]
      ),
      ["circle", { strokeWidth: 2 }],
      ["circle", { fillOpacity: "0.5" }],
      ["circle", { cx: 4 }],
      ["div", { hidden: false }],
      ["div", { title: null }],
      ["input", { value: "v" }],
      ["input", { disabled: true }],
      ["div", { style: { color: "red" } }],
      ["div", { style: "color:red" }],
    ];
    for (const [tag, props] of shapes) {
      for (const k of Object.keys(props)) {
        const plainHost = doc.createElement("main");
        _render(plainHost, h(tag, { ...props }), null, { doc });
        const sigHost = doc.createElement("main");
        _render(
          sigHost,
          h(tag, { ...props, [k]: signal(props[k]) }),
          null,
          { doc },
        );
        // Attribute ORDER is not semantic (signal props are written after the
        // plain ones), so compare the attribute SET.
        const attrs = (host: Element) =>
          Array.from((host.firstChild as Element).attributes)
            .map((a) => `${a.name}=${a.value}`).sort();
        assertEquals(
          attrs(sigHost as unknown as Element),
          attrs(plainHost as unknown as Element),
          `<${tag} ${k}={signal(${
            JSON.stringify(props[k])
          })}> rendered differently from the same plain value`,
        );
        // The live property matters too — an attribute is not the whole DOM.
        const a = plainHost.firstChild as unknown as Record<string, unknown>;
        const b = sigHost.firstChild as unknown as Record<string, unknown>;
        if (k in (a as object) && (a[k] === null || typeof a[k] !== "object")) {
          assertEquals(b[k], a[k], `<${tag}>.${k} property diverged`);
        }
        compared++;
      }
    }
  } finally {
    win.happyDOM.close();
  }
  assert(compared >= 15, `only ${compared} prop shapes compared`);
});

// ── a diff must PATCH, never re-create ────────────────────────────────────
//
// Everything above compares DOCUMENTS. `innerHTML` equality is structurally
// blind to node IDENTITY: a reconciler that tears a row out and builds an
// identical one in its place produces byte-identical markup and passes every
// assertion in this file — while the user watching it loses the caret in the
// input they were typing in, the text they had selected, the scroll offset of
// the list, the uncontrolled value of every field, and any imperative handle a
// `ref` was holding. That is the single most consequential property a keyed
// reconciler has, and nothing was asserting it for the diff path (the hydrate
// test asserts it, but only for hydration and only for one text edit).
//
// So: build a FULLY KEYED tree, apply only edits that keep every surviving
// node's identity (reorders at both ends, reversal, insert/remove at both ends,
// prop swaps, text edits, and duplicated keys), and after every step require
// that a spec which is still in the model, still has the same tag, and still
// sits at the same path of keyed ancestors, occupies THE SAME DOM node it did
// before. `data-sid` makes "the node spec X occupies now" answerable; the rest
// is the contract.

/** Force keys on every container so identity is the reconciler's job, not the
 *  positional accident that unkeyed reconciliation is allowed to be. */
function keyAll(s: Spec): void {
  if (s.k === "b" || s.k === "u") s.boom = false;
  if (isContainer(s)) {
    s.keyed = STABLE;
    for (const k of s.kids) keyAll(k);
  }
}

/** id → { path of ancestor ids, tag } for every ELEMENT spec, plus the ids that
 *  are TAINTED: they, or one of their ancestors, occur twice in the tree.
 *
 *  A duplicated id is a duplicated KEY, which is an app bug the reconciler only
 *  promises to degrade gracefully on (dev warns `dup-key-…`; `diffKeyed` lets
 *  the LAST old occurrence win the key and removes the shadowed one, so the
 *  first next occurrence adopts the wrong subtree). The document stays right —
 *  which the innerHTML assertion still checks on every one of these steps —
 *  but node identity is explicitly not promised, so it is not asserted. */
function elementMeta(s: Spec) {
  const meta = new Map<number, { path: string; tag: string }>();
  const counts = new Map<number, number>();
  const paths = new Map<number, number[]>();
  const walk = (n: Spec, path: number[]) => {
    counts.set(n.id, (counts.get(n.id) ?? 0) + 1);
    if (n.k === "e") {
      meta.set(n.id, { path: path.join("/"), tag: n.tag });
      paths.set(n.id, path);
    }
    if (isContainer(n)) { for (const k of n.kids) walk(k, [...path, n.id]); }
  };
  walk(s, []);
  const tainted = new Set<number>();
  for (const [id, p] of paths) {
    if ([...p, id].some((a) => (counts.get(a) ?? 0) > 1)) tainted.add(id);
  }
  return { meta, tainted };
}

/** data-sid → the element node currently carrying it. */
function sidNodes(host: Element): Map<number, Element> {
  const out = new Map<number, Element>();
  for (const el of host.querySelectorAll("[data-sid]")) {
    const sid = Number(el.getAttribute("data-sid"));
    if (out.has(sid)) out.delete(sid); // ambiguous — excluded by `dupes` anyway
    else out.set(sid, el as unknown as Element);
  }
  return out;
}

/** Identity-preserving edits only. Every op here leaves the surviving specs
 *  with the same id, the same tag and the same keyed-ancestor path, so a
 *  correct keyed reconciler must MOVE their nodes rather than rebuild them.
 *  The ends are exercised explicitly — head insert/remove and full reversal are
 *  where a cursor-walking reconciler bottoms out. */
function mutateKeyed(root: Spec, r: Rnd): Spec {
  const next = clone(root);
  const cs = containers(next);
  const c = r.of(cs);
  switch (r.pick(13)) {
    case 0: { // text edit (values collide by design)
      const ts = texts(next);
      if (ts.length) r.of(ts).v = r.of(TEXTS);
      break;
    }
    case 1: // swap two siblings
      if (c.kids.length >= 2) {
        const i = r.pick(c.kids.length), j = r.pick(c.kids.length);
        [c.kids[i], c.kids[j]] = [c.kids[j]!, c.kids[i]!];
      }
      break;
    case 2: // rotate left (first → last)
      if (c.kids.length >= 2) c.kids.push(c.kids.shift()!);
      break;
    case 3: // rotate right (last → first)
      if (c.kids.length >= 2) c.kids.unshift(c.kids.pop()!);
      break;
    case 4: // full reversal
      c.kids.reverse();
      break;
    case 5: // insert at the HEAD
      c.kids.unshift(gen(r, 1));
      break;
    case 6: // insert at the TAIL
      c.kids.push(gen(r, 1));
      break;
    case 7: // insert in the middle
      c.kids.splice(r.pick(c.kids.length + 1), 0, gen(r, 1));
      break;
    case 8: // remove the HEAD
      c.kids.shift();
      break;
    case 9: // remove the TAIL
      c.kids.pop();
      break;
    case 10: // remove a random child
      if (c.kids.length) c.kids.splice(r.pick(c.kids.length), 1);
      break;
    case 11: // swap an element's whole prop set
      if (c.k === "e") c.pi = r.pick(PROPS.length);
      break;
    case 12: // DUPLICATE a child — same id ⇒ the same key twice (AIO-417)
      if (c.kids.length) {
        c.kids.splice(r.pick(c.kids.length + 1), 0, clone(r.of(c.kids)));
      }
      break;
  }
  keyAll(next);
  return next;
}

/** Sort each start tag's attributes. Only this test needs it: `data-sid`
 *  survives a whole-prop-set swap that removes and re-adds its neighbours, so
 *  the incremental document spells the same attributes in a different order.
 *  Attribute order is not semantic (the signal-prop test above compares sets
 *  for the same reason); nothing else is normalized. */
function normAttrOrder(html: string): string {
  return html.replace(
    /<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>/g,
    (_m, tag: string, attrs: string, close: string) => {
      const parts = attrs.match(/[^\s=]+(?:="[^"]*")?/g) ?? [];
      return `<${tag}${parts.length ? " " + parts.sort().join(" ") : ""}${
        close ? " /" : ""
      }>`;
    },
  );
}

Deno.test("differential: a keyed diff MOVES the node it already has — never re-creates it", () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  let identitiesChecked = 0;
  _stampSid = true;
  try {
    for (let round = 0; round < ROUNDS; round++) {
      const r = makeRnd((SEED + round * 2038074743) & 0x7fffffff);
      _nextId = 1;
      let spec = genRoot(r);
      keyAll(spec);
      const history: Spec[] = [clone(spec)];
      const repro = (step: number, why: string) =>
        `FUZZ_SEED=${SEED} round ${round} step ${step}: ${why}\n  models: ${
          JSON.stringify(history.map(strip))
        }`;

      const host = doc.createElement("main");
      let prev = toVNode(clone(spec));
      _render(host, prev, null, { doc });

      for (let step = 1; step <= STEPS; step++) {
        const before = sidNodes(host as unknown as Element);
        const beforeMeta = elementMeta(spec);
        spec = mutateKeyed(spec, r);
        history.push(clone(spec));
        const afterMeta = elementMeta(spec);
        const nextV = toVNode(clone(spec));
        _diff(host, nextV, prev, { doc });
        prev = nextV;

        // The document is still what a fresh render says — otherwise identity
        // is the wrong thing to be arguing about.
        assertEquals(
          normAttrOrder(host.innerHTML),
          normAttrOrder(fresh(doc, spec)),
          repro(step, "incremental DOM ≠ fresh render"),
        );

        const after = sidNodes(host as unknown as Element);
        for (const [id, m] of beforeMeta.meta) {
          const n = afterMeta.meta.get(id);
          if (!n) continue; // removed — nothing to preserve
          if (n.path !== m.path || n.tag !== m.tag) continue; // moved subtree / retag
          if (beforeMeta.tainted.has(id) || afterMeta.tainted.has(id)) continue;
          const b = before.get(id), a = after.get(id);
          if (!b || !a) continue;
          assert(
            a === b,
            repro(
              step,
              `<${m.tag} data-sid="${id}"> was RE-CREATED instead of moved — ` +
                `a user's caret, selection, scroll offset and uncontrolled ` +
                `input value in that node are gone`,
            ),
          );
          identitiesChecked++;
        }
      }
    }
  } finally {
    _stampSid = false;
    win.happyDOM.close();
  }
  assert(
    identitiesChecked > ROUNDS * STEPS,
    `only ${identitiesChecked} node identities compared — the oracle saw nothing`,
  );
});

// ── a form control's state is its PROPERTIES, not its markup ──────────────
//
// Everything above compares documents. For a form control that is the wrong
// question: `<input>`'s state lives in `.value`/`.checked`, `<textarea>`'s value
// IS its child text, and `defaultValue`/`defaultChecked` are DOM properties
// whose content-attribute spelling is a DIFFERENT NAME (`value`, `checked`).
// The client patcher knows this — `_writeProp` routes every `_DOM_PROPS` key to
// a property assignment — and the SSR writer did not: it emitted the JSX name
// verbatim, so the server shipped `defaultValue="Alice"` and `value="…"` on a
// textarea, attributes no browser has ever read. And `hydrate()` never applies
// props at all, so nothing on the client repaired it: a server-rendered form
// came up EMPTY and stayed empty.
//
// So the property under test is the one that matters to a user filling in a
// form: whatever the control shows after a client mount, it must also show
// after SSR + hydrate — and, for everything markup can carry, from the server
// HTML alone before any JS runs.
type FormCase = {
  name: string;
  make: () => VNode;
  /** The element to read, as an index path from the host. */
  at?: number[];
  read: Record<string, unknown>;
  /** Properties markup alone cannot carry — checked after hydrate only. */
  ssrCannot?: string[];
};

const FORM_CASES: FormCase[] = [
  {
    name: "<input value>",
    make: () => h("input", { type: "text", value: "Alice" }),
    read: { value: "Alice" },
  },
  {
    name: "<input defaultValue>",
    make: () => h("input", { type: "text", defaultValue: "Alice" }),
    read: { value: "Alice", defaultValue: "Alice" },
  },
  {
    name: "<input checked>",
    make: () => h("input", { type: "checkbox", checked: true }),
    read: { checked: true },
  },
  {
    name: "<input defaultChecked>",
    make: () => h("input", { type: "checkbox", defaultChecked: true }),
    read: { checked: true, defaultChecked: true },
  },
  {
    name: "<input indeterminate>",
    make: () => h("input", { type: "checkbox", indeterminate: true }),
    read: { indeterminate: true },
    ssrCannot: ["indeterminate"], // no content attribute exists
  },
  {
    name: "<textarea value>",
    make: () => h("textarea", { value: "hello" }),
    read: { value: "hello" },
  },
  {
    name: "<textarea defaultValue>",
    make: () => h("textarea", { defaultValue: "hello" }),
    read: { value: "hello" },
  },
  {
    name: "<textarea> with a text child",
    make: () => h("textarea", null, "hello"),
    read: { value: "hello" },
  },
  {
    name: "<select value>",
    make: () =>
      h(
        "select",
        { value: "b" },
        h("option", { value: "a" }, "a"),
        h("option", { value: "b" }, "b"),
      ),
    read: { value: "b" },
    ssrCannot: ["value"], // <select> has no value attribute; <option selected> is the markup
  },
  {
    name: "<option selected>",
    make: () =>
      h(
        "select",
        null,
        h("option", { value: "a" }, "a"),
        h("option", { value: "b", selected: true }, "b"),
      ),
    read: { value: "b" },
  },
  {
    name: "<input disabled readOnly>",
    make: () => h("input", { type: "text", disabled: true, readOnly: true }),
    read: { disabled: true, readOnly: true },
  },
];

Deno.test("differential: a form control holds the same live state after SSR+hydrate as after mount", () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  try {
    for (const c of FORM_CASES) {
      const at = (host: Element) => {
        let n: Node = host;
        for (const i of c.at ?? [0]) n = n.childNodes[i]!;
        return n as unknown as Record<string, unknown>;
      };

      // 1. client mount — the reference. This is what the developer sees when
      //    they build the page with no server in the picture at all.
      const mHost = doc.createElement("main");
      _render(mHost, c.make(), null, { doc });
      for (const [k, want] of Object.entries(c.read)) {
        assertEquals(
          at(mHost as unknown as Element)[k],
          want,
          `${c.name}: a client mount got .${k} wrong — the fixture is wrong`,
        );
      }

      // 2. the server's HTML, with no JS at all. Everything markup can carry
      //    must already be there: that is the entire point of SSR.
      const ssr = renderToString(c.make());
      const pHost = doc.createElement("main");
      pHost.innerHTML = ssr;
      for (const [k, want] of Object.entries(c.read)) {
        if (c.ssrCannot?.includes(k)) continue;
        assertEquals(
          at(pHost as unknown as Element)[k],
          want,
          `${c.name}: the server HTML does not express .${k} — a browser ` +
            `showing this page before (or without) hydration renders the ` +
            `wrong control.\n  markup: ${ssr}`,
        );
      }

      // 3. SSR + hydrate — must land at the mount state, including the props
      //    markup cannot carry.
      const hHost = doc.createElement("main");
      hHost.innerHTML = ssr;
      const consumed = _hydrateNode(hHost, c.make(), { doc }, false, 0);
      assert(consumed >= 0, `${c.name}: hydration reported a mismatch`);
      for (const [k, want] of Object.entries(c.read)) {
        assertEquals(
          at(hHost as unknown as Element)[k],
          want,
          `${c.name}: after SSR + hydrate the control's .${k} is wrong — the ` +
            `page renders a control the state does not describe, and nothing ` +
            `repairs it.\n  markup: ${ssr}`,
        );
      }
    }
  } finally {
    win.happyDOM.close();
  }
});

// ── removing a prop must leave the element at its DEFAULT ─────────────────
//
// `applyProps` retires a removed `_DOM_PROPS` prop by resetting the PROPERTY,
// which is not the same thing as removing it: a checkbox's `.value` reads
// through its `value` content attribute and answers the platform default `"on"`
// only while there is none. Assigning `""` therefore left `value=""` behind —
// and on a hydrated page the SERVER's value, which the client had never
// written. The control kept reporting a value the component no longer contains
// and the form submitted it, while a fresh render of the very same model
// reported `"on"`. Nothing in the DOM shows the difference.
//
// The table is (props → props-without-one-key) and the answer must be the same
// down all three routes a page can reach that state: client mount, SSR +
// hydrate, and the incremental diff.
const REMOVAL_CASES: Array<[string, Record<string, unknown>, string[]]> = [
  ["checkbox value", { type: "checkbox", value: "yes" }, ["value"]],
  ["radio value", { type: "radio", value: "yes" }, ["value"]],
  ["checkbox checked", { type: "checkbox", checked: true }, ["checked"]],
  ["text value", { type: "text", value: "abc" }, ["value"]],
  ["text defaultValue", { type: "text", defaultValue: "abc" }, [
    "defaultValue",
  ]],
  ["disabled", { type: "text", disabled: true }, ["disabled"]],
  ["readOnly", { type: "text", readOnly: true }, ["readOnly"]],
  ["everything at once", {
    type: "checkbox",
    value: "yes",
    checked: true,
    disabled: true,
  }, ["value", "checked", "disabled"]],
];

Deno.test("differential: removing a prop leaves the control where a fresh render of the same model puts it", () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  try {
    for (const [name, before, drop] of REMOVAL_CASES) {
      const after: Record<string, unknown> = { ...before };
      for (const k of drop) delete after[k];
      const state = (host: Element) =>
        formState(host)[0] + " · " + host.innerHTML;

      // What the model says, with nothing before it.
      const refHost = doc.createElement("main");
      _render(refHost, h("input", { ...after }), null, { doc });
      const want = formState(refHost as unknown as Element)[0];

      for (const route of ["mount", "hydrate"] as const) {
        const host = doc.createElement("main");
        const prev = h("input", { ...before });
        if (route === "mount") {
          _render(host, prev, null, { doc });
        } else {
          host.innerHTML = renderToString(h("input", { ...before }));
          assert(
            _hydrateNode(host, prev, { doc }, false, 0) >= 0,
            `${name}: hydration reported a mismatch`,
          );
        }
        _diff(host, h("input", { ...after }), prev, { doc });
        assertEquals(
          formState(host as unknown as Element)[0],
          want,
          `${name} (${route} → diff): dropping ${drop.join("+")} left the ` +
            `control in a state the model does not describe — a form submits ` +
            `it and nothing shows it.\n  got  ${
              state(host as unknown as Element)
            }\n  want ${state(refHost as unknown as Element)}`,
        );
      }
    }
  } finally {
    win.happyDOM.close();
  }
});

// ── a boundary keeps its SLOT and its NODES while it shows a fallback ─────
//
// The fuzzer reaches these through random trees; the shapes are ordinary
// enough to be worth naming, because each one is silent and each one lasts for
// as long as the boundary stays in its fallback — which for a `<Suspense>` is
// the entire load, i.e. every render the user is actually watching.
//
//  · the fallback must stay in the boundary's SLOT. A bare-string fallback
//    carries no `_dom`, so "where does this region end" answered "at the end of
//    the parent" and `<Suspense fallback="Loading…">` — the most ordinary
//    spelling there is — moved itself below every sibling on the first
//    re-render.
//  · the fallback's NODES must be patched, not rebuilt. A spinner rebuilt on
//    every render restarts its CSS animation from frame zero; an error
//    fallback rebuilt on every render loses focus and selection inside it.
//  · a boundary that RECOVERS into empty content must keep a comment anchor,
//    exactly as a mount gives it one — without a position, the next render
//    anchors its whole region at the parent's first child.
//  · and the dev tripwire must stay silent throughout: it checked the
//    boundary's CHILDREN against a region that holds the FALLBACK, so a caught
//    error printed "this is an aio bug; please report" on every render.
const Boom = CThrow;
const Pending = CPending;

Deno.test("differential: a boundary showing a fallback keeps its slot and patches its nodes", () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => {
    warnings.push(a.map(String).join(" "));
  };
  setDevMode(true);
  try {
    const shapes: Array<[string, (empty: boolean) => VNode]> = [
      ["Suspense, string fallback", (empty) =>
        h(
          "div",
          null,
          h("span", null, "header"),
          h(
            Suspense as never,
            { fallback: "Loading…" },
            ...(empty ? [] : [h(Pending, null)]),
          ),
          h("span", null, "footer"),
        )],
      ["Suspense, element fallback", (empty) =>
        h(
          "div",
          null,
          h("span", null, "header"),
          h(
            Suspense as never,
            { fallback: h("i", null, "spin") },
            ...(empty ? [] : [h(Pending, null)]),
          ),
          h("span", null, "footer"),
        )],
      ["Suspense, fragment fallback", (empty) =>
        h(
          "div",
          null,
          h("span", null, "header"),
          h(
            Suspense as never,
            { fallback: h(Fragment, null, "L", "…") },
            ...(empty ? [] : [h(Pending, null)]),
          ),
          h("span", null, "footer"),
        )],
      ["ErrorBoundary, string fallback", (empty) =>
        h(
          "div",
          null,
          h("span", null, "header"),
          h(
            ErrorBoundary as never,
            { fallback: () => "Oops" },
            ...(empty ? [] : [h(Boom, null)]),
          ),
          h("span", null, "footer"),
        )],
      ["ErrorBoundary, element fallback", (empty) =>
        h(
          "div",
          null,
          h("span", null, "header"),
          h(
            ErrorBoundary as never,
            { fallback: () => h("i", null, "Oops") },
            ...(empty ? [] : [h(Boom, null)]),
          ),
          h("span", null, "footer"),
        )],
    ];

    for (const [name, tree] of shapes) {
      const host = doc.createElement("main");
      let prev = tree(false);
      _render(host, prev, null, { doc });
      const mounted = host.innerHTML;
      const nodes = () => Array.from(host.firstChild!.childNodes);
      const before = nodes();

      // Three idle re-renders: the fallback stays put, and stays the SAME nodes.
      for (let i = 0; i < 3; i++) {
        const next = tree(false);
        _diff(host, next, prev, { doc });
        prev = next;
        assertEquals(
          host.innerHTML,
          mounted,
          `${name}: re-render ${i} moved the fallback out of the boundary's ` +
            `slot — it is not where a mount of the same tree puts it`,
        );
        const now = nodes();
        assertEquals(
          now.length,
          before.length,
          `${name}: re-render ${i} changed the node count`,
        );
        for (let j = 0; j < before.length; j++) {
          assert(
            now[j] === before[j],
            `${name}: re-render ${i} REBUILT the fallback's node ${j} instead ` +
              `of patching it — a spinner's animation restarts from frame ` +
              `zero and any focus or selection inside the fallback is lost`,
          );
        }
      }

      // Recover into EMPTY content: the boundary must still hold its slot.
      const empty = tree(true);
      _diff(host, empty, prev, { doc });
      const emptyHost = doc.createElement("main");
      _render(emptyHost, tree(true), null, { doc });
      assertEquals(
        host.innerHTML,
        emptyHost.innerHTML,
        `${name}: recovering into empty content did not leave the boundary ` +
          `where a mount of the same tree leaves it — with no anchor it has ` +
          `no position, and the next render puts its region at the parent's ` +
          `first child`,
      );
    }
    assertEquals(
      warnings.filter((w) => /desync|aio bug/.test(w)),
      [],
      "the dev tripwire fired on a correct render — a boundary showing its " +
        "fallback does not hold its children, so checking them against its " +
        "region reports a desync for every app whose ErrorBoundary caught",
    );
  } finally {
    setDevMode(false);
    console.warn = origWarn;
    win.happyDOM.close();
  }
});

// ── a boundary going to its fallback takes ONLY its own nodes ─────────────
//
// The child diff can throw PART WAY THROUGH. `diffKeyed` retires a
// type-mismatched child before it creates the replacement, and creating the
// replacement is exactly what throws — so by the time the boundary's `catch`
// runs, the region is already SHORTER than the old model it is about to replay
// over it. The replay then walked one node too far and removed the boundary's
// NEXT SIBLING: keyed rows inside an `<ErrorBoundary>` that start throwing
// silently deleted the element after the boundary, and nothing said so.
Deno.test("differential: a boundary that falls back removes its own region and nothing else", () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  try {
    const tree = (boom: boolean) =>
      h(
        "div",
        null,
        h("span", null, "header"),
        h(
          ErrorBoundary as never,
          { fallback: () => h("b", null, "!") },
          // Keyed children — `diffKeyed`, whose non-keyed slot is filled by the
          // bare-text child and whose first new child is the one that throws.
          ...(boom ? [h(CThrow, null)] : []),
          h("p", { key: "p" }),
          h("i", { key: "i" }),
          "tail",
        ),
        h("span", null, "footer"),
      );
    for (const withSibling of [true, false]) {
      const host = doc.createElement("main");
      const prev = withSibling
        ? tree(false)
        : h("div", null, h("span", null, "header"), tree(false).children[1]!);
      _render(host, prev as VNode, null, { doc });
      const next = withSibling
        ? tree(true)
        : h("div", null, h("span", null, "header"), tree(true).children[1]!);
      _diff(host, next as VNode, prev as VNode, { doc });
      const ref = doc.createElement("main");
      _render(ref, next as VNode, null, { doc });
      assertEquals(
        host.innerHTML,
        ref.innerHTML,
        `a boundary whose keyed children started throwing did not leave the ` +
          `document a mount of the same tree produces — it took a node that ` +
          `was not part of its region`,
      );
    }
  } finally {
    win.happyDOM.close();
  }
});
