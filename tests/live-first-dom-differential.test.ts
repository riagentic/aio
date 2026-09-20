// Differential fuzzer for `_liveFirstDom`: a component that re-renders ON ITS
// OWN SIGNAL and swaps its ROOT leaves every ancestor's `_dom` copy pointing at
// a detached node — and the next PARENT diff reads that copy as "where child i
// is". `tests/renderer-differential.test.ts` drives `_diff` directly, so it can
// never produce that state: the staleness needs an OUT-OF-BAND re-render, which
// only the real renderer performs.
//
// So this drives the real one. Every step flips signals (nested roots swap at
// several depths), then mutates the list model (reorder, insert, remove,
// replace, reverse, tail toggle), and the incrementally diffed DOM must equal a
// FRESH mount of the same model and the same signal state — and the dev
// alignment tripwire must stay silent, because the render is correct.
//
// Rows cover the shapes whose first node is a copy: a component, a component
// two and three levels above the swapping one (the auto-memo skip carries the
// copy across those), a Fragment whose first slot occupies zero nodes (a
// Portal), a Fragment with a real first child, an ErrorBoundary and a Suspense.
// Roots swap between an element, a different element, a two-node Fragment,
// nothing at all, and a bare string — every case `_liveFirstDom` branches on.
//
// A failure prints the seed, round, step and model, so a sweep comes back as a
// one-line repro:
//
//     for s in 1 7 31 99 12345; do FUZZ_SEED=$s deno test -A //       tests/live-first-dom-differential.test.ts; done
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import {
  ErrorBoundary,
  Fragment,
  h,
  Portal,
  Suspense,
} from "../src/air/vdom.ts";
import type { ComponentFn, VNode } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  mount,
  setDevMode,
} from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";
import { fuzzEnvInt } from "./fuzz-seed.ts";

// The seed is FIXED by default — CI must explore the same programs on every
// run, or a red build is not reproducible from its own commit.
const SEED = fuzzEnvInt("FUZZ_SEED", 0x1234567) & 0x7fffffff;
const ROUNDS = fuzzEnvInt("FUZZ_ROUNDS", 200, 1);
const STEPS = fuzzEnvInt("FUZZ_STEPS", 8, 1);

function rng(seed: number): () => number {
  let s = seed || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

const WARNS: string[] = [];
const origWarn = console.warn;
const origErr = console.error;

// ── signals that flip a nested component's ROOT ─────────────────────────
const SIGS = [signal(0), signal(0), signal(0), signal(0)];

type P = { v: string; si: number };

// depth 0 — reads its signal, swaps its ROOT SHAPE
const Leaf: ComponentFn = (p: P) => {
  const m = SIGS[p.si]!.value % 5;
  if (m === 0) return h("p", { class: "lf" }, p.v);
  if (m === 1) return h("b", { class: "lf" }, p.v);
  if (m === 2) return h(Fragment, null, h("i", null, p.v), h("u", null, "-"));
  if (m === 3) return null;
  return p.v as unknown as VNode; // a bare STRING root — a text node no vnode carries
};
// one/two/three levels of indirection that do NOT read the signal
const Mid: ComponentFn = (p: P) => h(Leaf, p);
const Deep: ComponentFn = (p: P) => h(Mid, p);
const Deeper: ComponentFn = (p: P) => h(Deep, p);
// a fragment whose first slot is a zero-node child, then the swapping chain
const FragWrap: ComponentFn = (p: P) =>
  h(
    Fragment,
    null,
    h(Portal, { target: PORTAL_TARGET }, h("z", null, "p")),
    h(Deep, p),
  );
// a fragment with a real first child
const FragWrap2: ComponentFn = (p: P) =>
  h(Fragment, null, h("s", null, "."), h(Deeper, p));
const BoundWrap: ComponentFn = (p: P) =>
  h(ErrorBoundary, { fallback: () => h("em", null, "e") }, h(Deep, p));
const SusWrap: ComponentFn = (p: P) =>
  h(Suspense, { fallback: h("em", null, "s") }, h(Mid, p));

// deno-lint-ignore no-explicit-any
let PORTAL_TARGET: any;

type Row = { key: number; shape: number; v: string; si: number };

function buildRow(r: Row, keyed: boolean): VNode | string | number {
  const p: P = { v: r.v, si: r.si };
  const k = keyed ? { key: String(r.key) } : {};
  switch (r.shape) {
    case 0:
      return h("li", { ...k, class: "el" }, r.v);
    case 1:
      return h(Leaf, { ...p, ...k });
    case 2:
      return h(Mid, { ...p, ...k });
    case 3:
      return h(Deep, { ...p, ...k });
    case 4:
      return h(FragWrap, { ...p, ...k });
    case 5:
      return h(BoundWrap, { ...p, ...k });
    case 6:
      return h(Fragment, k, h("q", null, r.v), h("r", null, r.v));
    case 7:
      return h(SusWrap, { ...p, ...k });
    case 8:
      return h(FragWrap2, { ...p, ...k });
    default:
      return h(Deeper, { ...p, ...k });
  }
}

type Model = { rows: Row[]; keyed: boolean; tail: boolean };

const MODEL = signal<Model>({ rows: [], keyed: false, tail: true });

const App: ComponentFn = () => {
  const m = MODEL.value;
  return h(
    "div",
    { class: "app" },
    h("header", null, "h"),
    h("ul", null, ...m.rows.map((r) => buildRow(r, m.keyed))),
    m.tail ? h("footer", null, "f") : null,
  );
};

function norm(s: string): string {
  return s.replace(/ data-component="[^"]*"/g, "");
}

Deno.test("differential: a nested root swap leaves the parent diff aligned", async () => {
  const rand = rng(SEED);
  console.warn = (...a: unknown[]) => WARNS.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => WARNS.push(a.map(String).join(" "));
  try {
    setDevMode(true);
    for (let round = 0; round < ROUNDS; round++) {
      const win = new Window({ url: "http://localhost/" });
      // deno-lint-ignore no-explicit-any
      _setDocument(win.document as any);
      const doc = win.document;
      doc.body.innerHTML =
        `<div id="a"></div><div id="b"></div><div id="pt"></div>`;
      PORTAL_TARGET = doc.getElementById("pt")!;
      for (const s of SIGS) s.set(0);

      let nextKey = 0;
      const mkRow = (): Row => ({
        key: nextKey++,
        shape: Math.floor(rand() * 10),
        v: "v" + Math.floor(rand() * 4),
        si: Math.floor(rand() * SIGS.length),
      });
      const model: Model = {
        rows: Array.from({ length: 1 + Math.floor(rand() * 5) }, mkRow),
        keyed: rand() < 0.5,
        tail: true,
      };

      MODEL.set(model);
      const hA = mount(doc.getElementById("a")!, App);
      hA._flush();
      const warnBase = WARNS.length;

      for (let step = 0; step < STEPS; step++) {
        // 1. out-of-band: flip signals → nested components swap their roots
        const flips = 1 + Math.floor(rand() * 3);
        for (let f = 0; f < flips; f++) {
          const i = Math.floor(rand() * SIGS.length);
          SIGS[i]!.set(SIGS[i]!.value + 1 + Math.floor(rand() * 4));
        }
        // 2. mutate the model
        const op = Math.floor(rand() * 7);
        if (op === 0 && model.rows.length > 0) {
          model.rows.splice(Math.floor(rand() * model.rows.length), 1);
        } else if (op === 1) {
          model.rows.splice(
            Math.floor(rand() * (model.rows.length + 1)),
            0,
            mkRow(),
          );
        } else if (op === 2 && model.rows.length > 1) {
          const i = Math.floor(rand() * model.rows.length);
          const j = Math.floor(rand() * model.rows.length);
          const [x] = model.rows.splice(i, 1);
          model.rows.splice(j, 0, x!);
        } else if (op === 3 && model.rows.length > 0) {
          const i = Math.floor(rand() * model.rows.length);
          model.rows[i] = { ...model.rows[i]!, shape: Math.floor(rand() * 10) };
        } else if (op === 4) {
          model.rows.reverse();
        } else if (op === 5 && model.rows.length > 0) {
          const i = Math.floor(rand() * model.rows.length);
          model.rows[i] = {
            ...model.rows[i]!,
            v: "v" + Math.floor(rand() * 4),
          };
        } else {
          model.tail = !model.tail;
        }
        // 3. re-render the parent with the new model
        MODEL.set({ ...model, rows: [...model.rows] });
        hA._flush();

        // 4. oracle — a fresh mount of the SAME model + signal state
        const bEl = doc.getElementById("b")!;
        const hB = mount(bEl, App);
        hB._flush();
        const got = norm(doc.getElementById("a")!.innerHTML);
        const want = norm(bEl.innerHTML);
        if (got !== want) {
          throw new Error(
            `SEED=${SEED} round=${round} step=${step} keyed=${model.keyed}\n` +
              `model=${JSON.stringify(model)}\n` +
              `sigs=${SIGS.map((s) => s.value).join(",")}\n` +
              `got : ${got}\nwant: ${want}`,
          );
        }
        _unmount(hB);
        bEl.innerHTML = "";
      }
      const bad = WARNS.slice(warnBase).filter((w) =>
        /desync|aio bug|holds the wrong node|ran out of DOM|diffed against/
          .test(w)
      );
      if (bad.length) {
        throw new Error(
          `SEED=${SEED} round=${round} tripwire fired on a correct render:\n` +
            bad.join("\n"),
        );
      }
      _unmount(hA);
      await closeWindow(win);
    }
  } finally {
    console.warn = origWarn;
    console.error = origErr;
    setDevMode("auto");
  }
});
