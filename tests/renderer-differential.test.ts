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
import { Fragment, h, renderToString, type VNode } from "../src/air/vdom.ts";
import { _diff, _render } from "../src/air/vdom.ts";
import { setDevMode } from "../src/air/aio-renderer.ts";
import { _hydrateNode } from "../src/air/renderer-hydrate.ts";

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
type Spec =
  | (Base & { k: "t"; v: string })
  | (Base & { k: "x" }) // null child → _Null placeholder
  | (Base & { k: "e"; tag: string; keyed: boolean; kids: Spec[] })
  | (Base & { k: "f"; keyed: boolean; kids: Spec[] })
  | (Base & { k: "c"; c: number; keyed: boolean; kids: Spec[] });

/** Deliberately tiny so sibling text COLLIDES — equal-valued siblings are the
 *  shape a content scan cannot tell apart, and `{" "}` separators, repeated
 *  labels and equal numbers make them ordinary rather than exotic. */
const TEXTS = ["a", "a", "b", " ", "1", "1", "x"];
const TAGS = ["div", "p", "i"];

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

function build(s: Spec): VNode | string | null {
  const key = s.keyedKey;
  switch (s.k) {
    case "t":
      return s.v;
    case "x":
      return null;
    case "e":
      return h(s.tag, key ? { key } : null, ...s.kids.map(build));
    case "f":
      return h(Fragment, key ? { key } : null, ...s.kids.map(build));
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
function leaf(r: Rnd): Spec {
  const roll = r.pick(10);
  if (roll < 4) return { k: "t", id: _nextId++, v: r.of(TEXTS) };
  if (roll < 5) return { k: "x", id: _nextId++ };
  if (roll < 7) {
    return { k: "c", id: _nextId++, c: r.pick(4), keyed: false, kids: [] };
  }
  return { k: "e", id: _nextId++, tag: r.of(TAGS), keyed: false, kids: [] };
}

function gen(r: Rnd, depth: number): Spec {
  if (depth <= 0) return leaf(r);
  const n = r.pick(4); // 0..3 — 0 exercises EMPTY containers
  const kids = Array.from({ length: n }, () => gen(r, depth - 1));
  const roll = r.pick(10);
  if (roll < 4) {
    return { k: "e", id: _nextId++, tag: r.of(TAGS), keyed: false, kids };
  }
  if (roll < 7) return { k: "f", id: _nextId++, keyed: false, kids };
  if (roll < 9) {
    return { k: "c", id: _nextId++, c: r.pick(3), keyed: false, kids };
  }
  return leaf(r);
}

function genRoot(r: Rnd): Spec {
  const kids = Array.from({ length: 1 + r.pick(4) }, () => gen(r, 2));
  return r.pick(2) === 0
    ? { k: "e", id: _nextId++, tag: "div", keyed: false, kids }
    : { k: "f", id: _nextId++, keyed: false, kids };
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
  const op = r.pick(11);
  const c = r.of(cs);
  switch (op) {
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
    case 8: // toggle keys for the whole child list
      c.keyed = !c.keyed;
      break;
    case 9: // retag an element
      if (c.k === "e") c.tag = r.of(TAGS);
      break;
    case 10: // wrap a child in a fragment (new region mid-list)
      if (c.kids.length) {
        const i = r.pick(c.kids.length);
        c.kids[i] = {
          k: "f",
          id: _nextId++,
          keyed: false,
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
    for (const k of s.kids) applyKeys(k, s.keyed ? `k${k.id}` : undefined);
  }
}
function toVNode(s: Spec): VNode {
  applyKeys(s);
  return build(s) as VNode;
}

// ── harness ──────────────────────────────────────────────────────────────

function fresh(doc: Document, s: Spec): string {
  const host = doc.createElement("main");
  _render(host, toVNode(clone(s)), null, { doc });
  return host.innerHTML;
}

const seen: string[] = [];

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
      assertEquals(
        host.innerHTML,
        fresh(doc, spec),
        repro(0, "hydrated DOM ≠ mounted DOM"),
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
          repro(step, "post-hydrate diff ≠ fresh render"),
        );
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
