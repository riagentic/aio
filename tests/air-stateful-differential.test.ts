// Mount-level differential over the STATEFUL alphabet: context providers and
// consumers (incl. behind an auto-memo-skipped wrapper), components reading
// signals and swapping their root, effects that write a signal another
// component renders, a component writing a signal mid-render, `memo` with a
// comparator, class+className, style objects whose keys come and go, SVG with
// classes, controlled form controls (input / textarea / select), Portals into
// a live and a null target, and a throwing sibling beside a Portal inside an
// ErrorBoundary — in keyed and unkeyed lists that move.
//
// Oracle after EVERY step: the incrementally updated host (and every portal
// target) equals a FRESH mount of the same model and signal state, markup and
// control properties alike; and SSR → hydrate of the final model equals mount.
//
//     for s in 1 7 31 99 12345; do FUZZ_SEED=$s deno test -A \
//       tests/air-stateful-differential.test.ts; done
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import {
  ErrorBoundary,
  Fragment,
  h,
  Portal,
  renderToString,
} from "../src/air/vdom.ts";
import type { ComponentFn, VNode } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  afterRender,
  createContext,
  hydrate,
  mount,
  setDevMode,
  useContext,
  useContextSelector,
} from "../src/air/aio-renderer.ts";
import { memo } from "../src/air/memo.ts";
import { Show } from "../src/air/show.ts";
import { signal } from "../src/state/signal.ts";
import type { MountHandle } from "../src/air/renderer-types.ts";
import { fuzzEnvInt } from "./fuzz-seed.ts";
import { mulberry32 } from "./sync/properties/_prop.ts";

const SEED = fuzzEnvInt("FUZZ_SEED", 0x57a7e) & 0x7fffffff;
const ROUNDS = fuzzEnvInt("FUZZ_ROUNDS", 120, 1);
const STEPS = fuzzEnvInt("FUZZ_STEPS", 8, 1);

// deno-lint-ignore no-explicit-any
type P = any;

const SIGS = [signal(0), signal(0), signal(0)];
/** Written ONLY by effect components (one writer per slot per tree). */
const EFF = [signal("-"), signal("-")];
/** Written mid-render by `Reent`. */
const REENT = signal("r");
const Ctx = createContext("dflt");
/** Signal-valued PROPS (bound, not diffed). */
const CLS = signal("k0");
const COL = signal("red");
const HTML = ["<b>x</b>", "<i>y</i>z", ""];

const PROPS: Record<string, unknown>[] = [
  {},
  { class: "a", className: "b" },
  { className: "c" },
  { class: ["x", "y"] },
  { style: { color: "red", marginTop: 2 } },
  { style: { opacity: 0, "--v": "1" } },
  { style: { color: "blue" } },
  { style: "padding:1px" },
  { title: "t", "data-k": "1" },
  { hidden: true },
  { tabIndex: 0, "aria-label": "L" },
];
const TEXTS = ["a", "a", "b", " ", "0", ""];
const TAGS = ["div", "span", "section"];

// ── components (module-level: stable identity) ──────────────────────────
const SigRead: ComponentFn = (p: P) => {
  const m = SIGS[p.si]!.value % 4;
  if (m === 0) return h("b", { class: "s" + p.si }, String(m));
  if (m === 1) return h(Fragment, null, h("i", null, "f"), "t");
  if (m === 2) return null;
  return String(SIGS[p.si]!.value) as unknown as VNode;
};
const CtxRead: ComponentFn = () => h("u", null, useContext(Ctx));
const CtxSel: ComponentFn = () =>
  h("em", null, String(useContextSelector(Ctx, (v: string) => v.length)));
/** Constant props → the auto-memo skip; its body holds the readers. */
const Stable: ComponentFn = (p: P) =>
  h("q", null, h(CtxRead, null), h(SigRead, { si: p.si }));
const EffWrite: ComponentFn = (p: P) => {
  afterRender(() => EFF[p.wi]!.set(p.v));
  return h("s", null, p.v);
};
const EffRead: ComponentFn = (p: P) => h("small", null, EFF[p.wi]!.value);
const Reent: ComponentFn = (p: P) => {
  REENT.set(p.v);
  return h("mark", null, REENT.value);
};
const ShowSig: ComponentFn = (p: P) =>
  h(
    Show as never,
    {
      when: SIGS[p.si]!.value % 3,
      fallback: p.fb ? h("i", null, "no") : undefined,
    },
    ((v: number) =>
      v === 1 ? h("b", null, String(v)) : String(v)) as unknown as VNode,
  );
const Boom: ComponentFn = () => {
  throw new Error("boom");
};
const Wrap: ComponentFn = (p: P) => h("article", null, ...(p.children ?? []));
const Memo = memo(Wrap as never, () => true) as unknown as ComponentFn;

// ── the model ───────────────────────────────────────────────────────────
type Spec =
  | { k: "t"; id: number; v: string }
  | {
    k: "e";
    id: number;
    tag: string;
    pi: number;
    keyed: boolean;
    kids: Spec[];
  }
  | { k: "svg"; id: number; pi: number }
  | { k: "in"; id: number; kind: number; v: string; hd: boolean }
  | { k: "sig"; id: number; si: number }
  | { k: "cr"; id: number; sel: boolean }
  | { k: "st"; id: number; si: number }
  | { k: "ew"; id: number; wi: number; v: string }
  | { k: "er"; id: number; wi: number }
  | { k: "re"; id: number; v: string }
  | { k: "pv"; id: number; v: string; keyed: boolean; kids: Spec[] }
  | { k: "f"; id: number; keyed: boolean; kids: Spec[] }
  | { k: "m"; id: number; keyed: boolean; kids: Spec[] }
  | { k: "eb"; id: number; boom: boolean; keyed: boolean; kids: Spec[] }
  | { k: "pt"; id: number; live: boolean; keyed: boolean; kids: Spec[] }
  /** `{list.map(…)}` — an ARRAY passed as one child */
  | { k: "a"; id: number; keyed: boolean; kids: Spec[] }
  /** `{cond && …}` — false / true / undefined / null / 0 as a child */
  | { k: "v"; id: number; vi: number }
  | { k: "sh"; id: number; si: number; fb: boolean }
  /** signal-valued class + style decl + a signal child */
  | { k: "sp"; id: number; si: number }
  | { k: "dh"; id: number; hi: number };
const VALS = [false, true, undefined, null, 0];
type Container = Extract<Spec, { kids: Spec[] }>;

let TARGETS = new Map<number, Element>();
let DOC: Document;
function targetOf(id: number): Element {
  let t = TARGETS.get(id);
  if (!t) {
    t = DOC.createElement("aside") as unknown as Element;
    t.setAttribute("data-pt", String(id));
    TARGETS.set(id, t);
  }
  return t;
}
const noop = () => {};

// deno-lint-ignore no-explicit-any
function build(s: Spec, key?: string): any {
  const kp = key !== undefined ? { key } : {};
  const kids = (c: Container) =>
    c.kids.map((k) => build(k, c.keyed ? "k" + k.id : undefined));
  switch (s.k) {
    case "t":
      return s.v;
    case "e":
      return h(s.tag, { ...PROPS[s.pi], ...kp }, ...kids(s));
    case "svg":
      return h(
        "svg",
        { viewBox: "0 0 4 4", ...PROPS[s.pi], ...kp },
        h("rect", { width: 2, height: 2, className: "r", strokeWidth: 1 }),
      );
    case "in": {
      const hp = s.hd ? { onInput: noop, onChange: noop } : {};
      if (s.kind === 0) return h("input", { value: s.v, ...hp, ...kp });
      if (s.kind === 1) {
        return h("input", {
          type: "checkbox",
          checked: s.v === "a",
          ...hp,
          ...kp,
        });
      }
      if (s.kind === 2) return h("textarea", { value: s.v, ...hp, ...kp });
      return h(
        "select",
        { value: s.v, ...hp, ...kp },
        ...["a", "b", "0"].map((o) => h("option", { value: o }, o)),
      );
    }
    case "sig":
      return h(SigRead, { si: s.si, ...kp });
    case "cr":
      return h(s.sel ? CtxSel : CtxRead, kp);
    case "st":
      return h(Stable, { si: s.si, ...kp });
    case "ew":
      return h(EffWrite, { wi: s.wi, v: s.v, ...kp });
    case "er":
      return h(EffRead, { wi: s.wi, ...kp });
    case "re":
      return h(Reent, { v: s.v, ...kp });
    case "pv":
      return h(Ctx.Provider, { value: s.v, ...kp }, ...kids(s));
    case "f":
      return h(Fragment, key !== undefined ? kp : null, ...kids(s));
    case "m":
      return h(Memo, kp, ...kids(s));
    case "eb":
      return h(
        ErrorBoundary as never,
        { fallback: () => h("b", null, "!"), ...kp },
        ...kids(s),
        ...(s.boom ? [h(Boom, null)] : []),
      );
    case "a":
      return kids(s);
    case "sh":
      return h(ShowSig, { si: s.si, fb: s.fb, ...kp });
    case "sp":
      return h(
        "p",
        { class: CLS, style: { color: COL, marginTop: 1 }, ...kp },
        SIGS[s.si] as unknown as VNode,
      );
    case "dh":
      return h("div", {
        dangerouslySetInnerHTML: { __html: HTML[s.hi] },
        ...kp,
      });
    case "v":
      return VALS[s.vi];
    case "pt":
      return h(
        Fragment,
        key !== undefined ? kp : null,
        h(
          Portal as never,
          { target: s.live ? targetOf(s.id) : null },
          ...kids(s),
        ),
        h("hr", null),
      );
  }
}

// ── generation / mutation ───────────────────────────────────────────────
type Rnd = { pick: (n: number) => number; of: <T>(a: readonly T[]) => T };
function makeRnd(seed: number): Rnd {
  const r = mulberry32(seed);
  return {
    pick: (n) => Math.floor(r() * n),
    of: (a) => a[Math.floor(r() * a.length)]!,
  };
}
let nextId = 1;
let writers = new Set<number>();

function leaf(r: Rnd): Spec {
  const id = nextId++;
  switch (r.pick(11)) {
    case 0:
    case 1:
      return { k: "t", id, v: r.of(TEXTS) };
    case 2:
      return { k: "svg", id, pi: r.pick(PROPS.length) };
    case 3:
      return {
        k: "in",
        id,
        kind: r.pick(4),
        v: r.of(["a", "b", "0"]),
        hd: r.pick(2) === 0,
      };
    case 4:
      return { k: "sig", id, si: r.pick(SIGS.length) };
    case 5:
      return { k: "cr", id, sel: r.pick(2) === 0 };
    case 6:
      return { k: "st", id, si: r.pick(SIGS.length) };
    case 7: {
      const wi = r.pick(EFF.length);
      if (writers.has(wi)) return { k: "er", id, wi };
      writers.add(wi);
      return { k: "ew", id, wi, v: r.of(["w1", "w2", "w3"]) };
    }
    case 8:
      return r.pick(2) === 0
        ? { k: "er", id, wi: r.pick(EFF.length) }
        : { k: "v", id, vi: r.pick(VALS.length) };
    case 9:
      switch (r.pick(4)) {
        case 0:
          return { k: "sh", id, si: r.pick(SIGS.length), fb: r.pick(2) === 0 };
        case 1:
          return { k: "sp", id, si: r.pick(SIGS.length) };
        case 2:
          return { k: "dh", id, hi: r.pick(HTML.length) };
      }
      return { k: "re", id, v: r.of(["r1", "r2"]) };
    default:
      return {
        k: "e",
        id,
        tag: r.of(TAGS),
        pi: r.pick(PROPS.length),
        keyed: false,
        kids: [],
      };
  }
}
function gen(r: Rnd, d: number): Spec {
  if (d <= 0) return leaf(r);
  const kids = Array.from({ length: r.pick(4) }, () => gen(r, d - 1));
  const id = nextId++, keyed = r.pick(2) === 0;
  switch (r.pick(10)) {
    case 9:
      return { k: "a", id, keyed, kids };
    case 0:
    case 1:
      return {
        k: "e",
        id,
        tag: r.of(TAGS),
        pi: r.pick(PROPS.length),
        keyed,
        kids,
      };
    case 2:
      return { k: "pv", id, v: r.of(["p1", "p22", "p333"]), keyed, kids };
    case 3:
      return { k: "f", id, keyed, kids };
    case 4:
      return { k: "m", id, keyed, kids };
    case 5:
      return { k: "eb", id, boom: r.pick(3) === 0, keyed, kids };
    case 6:
      return { k: "pt", id, live: r.pick(3) !== 0, keyed, kids };
    default:
      return leaf(r);
  }
}
const isC = (s: Spec): s is Container => "kids" in s;
function containers(s: Spec, out: Container[] = []): Container[] {
  if (isC(s)) {
    out.push(s);
    s.kids.forEach((k) => containers(k, out));
  }
  return out;
}
function allNodes(s: Spec, out: Spec[] = []): Spec[] {
  out.push(s);
  if (isC(s)) s.kids.forEach((k) => allNodes(k, out));
  return out;
}
function countWriters(s: Spec): Set<number> {
  const w = new Set<number>();
  for (const n of allNodes(s)) if (n.k === "ew") w.add(n.wi);
  return w;
}

function mutate(root: Spec, r: Rnd): void {
  const cs = containers(root);
  const c = r.of(cs);
  const n = c.kids.length;
  writers = countWriters(root);
  if (r.pick(3) === 0) {
    const i = r.pick(SIGS.length);
    SIGS[i]!.set(SIGS[i]!.peek() + 1 + r.pick(3));
    if (r.pick(2) === 0) CLS.set(r.of(["k0", "k1", ""]));
    if (r.pick(2) === 0) COL.set(r.of(["red", "blue"]));
  }
  switch (r.pick(10)) {
    case 0:
      if (n) c.kids.splice(r.pick(n), 1);
      break;
    case 1:
      c.kids.splice(r.pick(n + 1), 0, gen(r, r.pick(2)));
      break;
    case 2:
      if (n > 1) {
        const [x] = c.kids.splice(r.pick(n), 1);
        c.kids.splice(r.pick(n), 0, x!);
      }
      break;
    case 3:
      c.kids.reverse();
      break;
    case 4:
      c.keyed = !c.keyed;
      break;
    case 5: {
      const node = r.of(allNodes(root));
      if (node.k === "e" || node.k === "svg") node.pi = r.pick(PROPS.length);
      else if (node.k === "t") node.v = r.of(TEXTS);
      else if (node.k === "in") {
        node.v = r.of(["a", "b", "0"]);
        if (r.pick(3) === 0) node.hd = !node.hd;
      } else if (node.k === "pv") node.v = r.of(["p1", "p22", "p333"]);
      else if (node.k === "ew") node.v = r.of(["w1", "w2", "w3"]);
      else if (node.k === "eb") node.boom = !node.boom;
      else if (node.k === "pt") node.live = !node.live;
      else if (node.k === "re") node.v = r.of(["r1", "r2"]);
      else if (node.k === "v") node.vi = r.pick(VALS.length);
      else if (node.k === "sh") node.fb = !node.fb;
      else if (node.k === "dh") node.hi = r.pick(HTML.length);
      break;
    }
    case 6:
      if (n) c.kids[r.pick(n)] = gen(r, r.pick(2));
      break;
    default: {
      // signal flips only
      const i = r.pick(SIGS.length);
      SIGS[i]!.set(SIGS[i]!.peek() + 1 + r.pick(3));
      if (r.pick(2) === 0) CLS.set(r.of(["k0", "k1", ""]));
      if (r.pick(2) === 0) COL.set(r.of(["red", "blue"]));
    }
  }
}

// ── harness ─────────────────────────────────────────────────────────────
const MODEL = signal<Spec>({ k: "f", id: 0, keyed: false, kids: [] });
const App: ComponentFn = () =>
  h("main", null, build(JSON.parse(JSON.stringify(MODEL.value))));

/** Form-control DEFAULTS (SSR writes `selected`/`checked`/`value` and the
 *  textarea's text; mount writes properties) are compared through `controls`
 *  — the live properties — not through markup. */
const norm = (s: string) =>
  s.replace(/ data-component="[^"]*"/g, "").replace(/<!--[^>]*-->/g, "")
    .replace(/ (selected|checked|value)="[^"]*"/g, "")
    .replace(/<textarea([^>]*)>[^<]*<\/textarea>/g, "<textarea$1></textarea>");
function controls(root: Element): string {
  return [...root.querySelectorAll("input,textarea,select")].map((e) => {
    const x = e as unknown as HTMLInputElement;
    return `${e.tagName}:${x.value}:${x.checked}`;
  }).join("|");
}
/** Markup with each element's attributes in name order — attribute ORDER is
 *  not semantic (mount writes bound props after static ones; SSR in prop
 *  order). */
function html(root: Element): string {
  const c = root.cloneNode(true) as Element;
  for (const el of [c, ...c.querySelectorAll("*")]) {
    const at = el.getAttributeNames().sort().map((n) =>
      [n, el.getAttribute(n)!] as const
    );
    for (const [n] of at) el.removeAttribute(n);
    for (const [n, v] of at) el.setAttribute(n, v);
  }
  return norm(c.innerHTML);
}
function snap(host: Element, ids: number[]): string {
  return html(host) + "\n#" + controls(host) + "\n" +
    ids.map((id) => {
      const t = TARGETS.get(id);
      return t?.innerHTML ? `${id}=${html(t)}#${controls(t)}` : "";
    }).join(";");
}
function settle(hd: MountHandle) {
  for (let i = 0; i < 5; i++) hd._flush();
}

const WARNS: string[] = [];
async function run(mode: "diff" | "hydrate" | "mismatch"): Promise<number> {
  const r = makeRnd(SEED ^ { diff: 0, hydrate: 0x9e37, mismatch: 0x3c1 }[mode]);
  let compared = 0;
  const ow = console.warn, oe = console.error;
  console.warn = (...a: unknown[]) => WARNS.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => WARNS.push(a.map(String).join(" "));
  setDevMode(true);
  try {
    for (let round = 0; round < ROUNDS; round++) {
      const win = new Window({ url: "http://localhost/" });
      DOC = win.document as unknown as Document;
      _setDocument(DOC);
      TARGETS = new Map();
      DOC.body.innerHTML = `<div id="a"></div><div id="b"></div>`;
      for (const s of SIGS) s.set(0);
      CLS.set("k0");
      COL.set("red");
      for (const s of EFF) s.set("-");
      REENT.set("r");
      writers = new Set();
      const root: Spec = {
        k: "f",
        id: nextId++,
        keyed: false,
        kids: Array.from({ length: 1 + r.pick(4) }, () => gen(r, 2)),
      };
      MODEL.set(JSON.parse(JSON.stringify(root)));
      const a = DOC.getElementById("a")!;
      const warnBase = WARNS.length;
      let hA: MountHandle;
      if (mode === "mismatch") {
        // the server rendered a DIFFERENT model (client state moved on)
        const other = {
          k: "f",
          id: nextId++,
          keyed: false,
          kids: [gen(r, 2), gen(r, 1)],
        };
        MODEL.set(other as Spec);
        a.innerHTML = renderToString(h(App, null));
        MODEL.set(JSON.parse(JSON.stringify(root)));
        writers = countWriters(root);
        hA = hydrate(a, App);
      } else if (mode === "hydrate") {
        a.innerHTML = renderToString(h(App, null));
        hA = hydrate(a, App);
      } else hA = mount(a, App);
      settle(hA);
      // step -1 compares the first render itself (mount / hydrate)
      for (let step = -1; step < STEPS; step++) {
        const before = JSON.stringify(root);
        if (step >= 0) mutate(root, r);
        MODEL.set(JSON.parse(JSON.stringify(root)));
        settle(hA);
        const ptIds = allNodes(root).filter((n) => n.k === "pt").map((n) =>
          n.id
        );
        const got = snap(a, ptIds);
        // reference: unmount nothing; render the same model into b with
        // fresh portal targets
        const live = TARGETS;
        TARGETS = new Map();
        const b = DOC.getElementById("b")!;
        const hB = mount(b, App);
        settle(hB);
        const want = snap(b, ptIds);
        _unmount(hB);
        b.innerHTML = "";
        TARGETS = live;
        // re-settle A: the reference's effects/renders may write shared signals
        settle(hA);
        compared++;
        if (got !== want) {
          throw new Error(
            `${mode} SEED=${SEED} round=${round} step=${step}\n` +
              `before=${before}\nafter=${JSON.stringify(root)}\n` +
              `sigs=${SIGS.map((s) => s.peek())} eff=${
                EFF.map((s) => s.peek())
              }\n` +
              `got : ${got}\nwant: ${want}`,
          );
        }
      }
      const trip = mode === "mismatch"
        ? /desync|aio bug|holds the wrong node|ran out of DOM|diffed against/i
        : /desync|aio bug|holds the wrong node|ran out of DOM|diffed against|mismatch|disagree|fall(s|ing)? ?back/i;
      const bad = WARNS.slice(warnBase).filter((w) => trip.test(w));
      if (bad.length) {
        throw new Error(
          `${mode} SEED=${SEED} round=${round} tripwire:\n` + bad.join("\n") +
            `\nmodel=${JSON.stringify(root)}`,
        );
      }
      _unmount(hA);
      const left = [a, ...TARGETS.values()].map((e) => norm(e.innerHTML))
        .join("");
      if (left) {
        throw new Error(
          `${mode} SEED=${SEED} round=${round} left after unmount: ${left}\nmodel=${
            JSON.stringify(root)
          }`,
        );
      }
      await closeWindow(win);
    }
  } finally {
    console.warn = ow;
    console.error = oe;
    setDevMode("auto");
  }
  return compared;
}

Deno.test("stateful differential: incremental mount == fresh mount", async () => {
  assertEquals(await run("diff"), ROUNDS * (STEPS + 1));
});
Deno.test("stateful differential: SSR + hydrate + updates == fresh mount", async () => {
  assertEquals(await run("hydrate"), ROUNDS * (STEPS + 1));
});
Deno.test("stateful differential: hydrate over a DIFFERENT server model recovers", async () => {
  assertEquals(await run("mismatch"), ROUNDS * (STEPS + 1));
});
