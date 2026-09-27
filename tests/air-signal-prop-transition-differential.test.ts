// Differential: an element whose props MOVE between a plain value, a signal,
// a style object holding per-declaration signals, and absent — across diffs
// and signal writes — must equal a fresh mount of the same props, attribute
// set and live properties alike.
//
// `renderer-differential.test.ts` proves a signal prop renders what the plain
// value does, statically. The transitions are a different path: the diff hands
// a prop to the binding effect (or takes it back), and each side assumed the
// other had written nothing. Three silent defects lived there:
//   · `style={{ fontSize }}` → `style={sig}` (or back) kept the old
//     declarations: the side taking over had no record of what the other wrote;
//   · `style={{ color: sig }}` → a style without that signal left the
//     per-declaration binding alive — it kept writing `color` forever;
//   · a checkbox `value={sig}` going "" → null kept `value=""`, so `.value`
//     read "" instead of "on" (a null write looked "not drifted").
//
//     for s in 1 2 3 4 5; do FUZZ_SEED=$s deno test -A \
//       tests/air-signal-prop-transition-differential.test.ts; done
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h, renderToString } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  hydrate,
  mount,
  setDevMode,
} from "../src/air/aio-renderer.ts";
import { type Signal, signal } from "../src/state/signal.ts";
import { fuzzEnvInt } from "./fuzz-seed.ts";

const SEED = fuzzEnvInt("FUZZ_SEED", 0x57e1ab) & 0x7fffffff;
const ROUNDS = fuzzEnvInt("FUZZ_ROUNDS", 400, 1);
const STEPS = fuzzEnvInt("FUZZ_STEPS", 8, 1);

let s = SEED || 1;
const rand = () => {
  s ^= s << 13;
  s ^= s >>> 17;
  s ^= s << 5;
  return (s >>> 0) / 2 ** 32;
};
const pick = <T>(a: readonly T[]): T => a[Math.floor(rand() * a.length)]!;

const TAGS: readonly [string, Record<string, unknown>][] = [
  ["div", {}],
  ["input", { type: "text" }],
  ["input", { type: "checkbox" }],
  ["button", { type: "button" }],
  ["circle", {}],
  ["textarea", {}],
  ["a", {}],
];
const POOL: Record<string, readonly unknown[]> = {
  class: ["a", "b c", "", null],
  title: ["t", "", null, 0],
  style: [
    "color: red;",
    "",
    { color: "blue" },
    { marginTop: 3, color: "red" },
    null,
  ],
  hidden: [true, false, null],
  disabled: [true, false, null],
  value: ["v", "", "7", 5, null],
  checked: [true, false, null],
  strokeWidth: [1, 2, null],
  "data-x": ["1", "", null],
  id: ["i", null],
  tabIndex: [0, -1, null],
  href: ["/x", null],
  min: [0, 10, null],
  max: [20, 100, null],
  readOnly: [true, false, null],
  draggable: [true, false, null],
};
const KEYS = Object.keys(POOL);
const SIGS: Record<string, Signal<unknown>> = {};
for (const k of KEYS) SIGS[k] = signal(POOL[k]![0]);
/** The signal inside a style OBJECT (`style={{ color: inner }}`). */
const inner = signal<unknown>("green");

type Prop = { sig: true } | { v: unknown } | { inner: true };
type Model = { tag: number; props: Record<string, Prop> };

function gen(tag: number): Model {
  const props: Record<string, Prop> = {};
  for (const k of KEYS) {
    if (rand() < 0.5) continue;
    props[k] = k === "style" && rand() < 0.3
      ? { inner: true }
      : rand() < 0.35
      ? { sig: true }
      : { v: pick(POOL[k]!) };
  }
  return { tag, props };
}

const model = signal<Model | null>(null);
function build(m: Model) {
  const [t, base] = TAGS[m.tag]!;
  const p: Record<string, unknown> = { ...base };
  for (const [k, d] of Object.entries(m.props)) {
    // `readOnly` on SVG is not an SVG attribute; the HTML parser lowercases
    // it on the server path, which is not what this test is about.
    if (t === "circle" && k === "readOnly") continue;
    p[k] = "inner" in d
      ? { color: inner, fontSize: "3px" }
      : "sig" in d
      ? SIGS[k]
      : d.v;
  }
  return t === "circle" ? h("svg", null, h("circle", p)) : h(t, p);
}
const App = () => {
  const m = model.value;
  return m ? h("main", null, build(m)) : null;
};

function snap(host: Element, hydrated: boolean): string {
  // deno-lint-ignore no-explicit-any
  let el = host.querySelector("main")!.firstElementChild as any;
  if (el.tagName.toLowerCase() === "svg") el = el.firstElementChild;
  const attrs = Array.from(el.attributes as ArrayLike<Attr>)
    .map((a) =>
      a.name === "style"
        ? "style=" + (el.style.cssText as string).split(";")
          .map((x) => x.trim()).filter(Boolean).sort().join(";")
        : `${a.name}=${a.value}`
    )
    // The server writes `value` / `checked` as CONTENT attributes (the
    // defaults) and hydrate keeps them; a mount writes only the property. The
    // live property below is what the user sees and submits.
    .filter((x) => !hydrated || !/^(value|checked)=/.test(x))
    .sort();
  const live: Record<string, unknown> = {};
  for (
    const k of [
      "value",
      "checked",
      "disabled",
      "hidden",
      "readOnly",
      "tabIndex",
      "draggable",
      "title",
      "id",
      "className",
    ]
  ) {
    if (k in el && !(k === "value" && el.tagName === "TEXTAREA")) {
      live[k] = el[k];
    }
  }
  return JSON.stringify({ attrs, live });
}

Deno.test("differential: props moving between plain, signal, style-signal and absent converge on a fresh mount", async () => {
  setDevMode(true);
  const warns: string[] = [];
  const ow = console.warn, oe = console.error;
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void warns.push(a.map(String).join(" "));
  let checks = 0;
  try {
    for (let round = 0; round < ROUNDS; round++) {
      const win = new Window({ url: "http://localhost/" });
      try {
        const doc = win.document as unknown as Document;
        _setDocument(doc as never);
        doc.body.innerHTML = `<div id="a"></div><div id="b"></div>`;
        const tag = Math.floor(rand() * TAGS.length);
        for (const k of KEYS) SIGS[k]!.set(pick(POOL[k]!));
        inner.set("green");
        let m = gen(tag);
        model.set(m);
        const host = doc.getElementById("a")!;
        const hyd = rand() < 0.4;
        const history: string[] = [
          JSON.stringify(m) + (hyd ? " (hydrate)" : ""),
        ];
        if (hyd) host.innerHTML = renderToString(h(App, null));
        const hA = hyd ? hydrate(host, App) : mount(host, App);
        hA._flush();
        for (let step = 0; step < STEPS; step++) {
          if (rand() < 0.5) {
            m = gen(tag);
            model.set(m);
            history.push(JSON.stringify(m));
          } else {
            const k = pick(KEYS), v = pick(POOL[k]!);
            SIGS[k]!.set(v);
            if (rand() < 0.3) inner.set(pick(["red", "green", null]));
            history.push(
              `${k}.set(${JSON.stringify(v)}) inner=${inner.peek()}`,
            );
          }
          hA._flush();
          const b = doc.getElementById("b")!;
          const hB = mount(b, App);
          hB._flush();
          const want = snap(b, hyd);
          _unmount(hB);
          assertEquals(
            snap(host, hyd),
            want,
            `FUZZ_SEED=${SEED} round ${round} step ${step}\n  ` +
              history.join("\n  "),
          );
          checks++;
        }
        _unmount(hA);
      } finally {
        await closeWindow(win);
      }
    }
  } finally {
    console.warn = ow;
    console.error = oe;
    setDevMode(false);
  }
  const desync = warns.filter((w) => /desync|aio bug/.test(w));
  assertEquals(desync, [], "a dev desync tripwire fired on correct code");
  // Not vacuous: every round ran every step.
  assertEquals(checks, ROUNDS * STEPS);
});

// A server-rendered `<textarea value>` holds its value as a text child — the
// only way HTML can spell it — and the vnode has no children. The child-desync
// tripwire read that node as "leftover DOM children … the child reconciler
// desynced" on every re-render of every hydrated textarea: a false alarm that
// sends the author hunting for a bug in correct code.
Deno.test("hydrated <textarea value> re-renders without a desync warning", async () => {
  const win = new Window({ url: "http://localhost/" });
  const doc = win.document as unknown as Document;
  _setDocument(doc as never);
  setDevMode(true);
  const warns: string[] = [];
  const ow = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(" "));
  try {
    const text = signal("hello");
    const App = () => h("main", null, h("textarea", { value: text.value }));
    const host = doc.createElement("div");
    host.innerHTML = renderToString(h(App, null));
    const hA = hydrate(host, App);
    hA._flush();
    text.set("bye");
    hA._flush();
    assertEquals(host.querySelector("textarea")!.value, "bye");
    _unmount(hA);
  } finally {
    console.warn = ow;
    setDevMode(false);
    await closeWindow(win);
  }
  assertEquals(warns.filter((w) => /desync/.test(w)), []);
});

// The fuzzer reaches this shape rarely; pinned directly. A per-declaration
// style signal must stop writing once the style no longer names it.
Deno.test("style={{ color: sig }} → a style without it: the old binding stops writing", async () => {
  const win = new Window({ url: "http://localhost/" });
  const doc = win.document as unknown as Document;
  _setDocument(doc as never);
  try {
    for (const next of [undefined, "margin: 1px", { margin: "1px" }]) {
      const color = signal("red");
      const on = signal(true);
      const host = doc.createElement("div");
      const hA = mount(
        host,
        () => h("p", { style: on.value ? { color, fontSize: "3px" } : next }),
      );
      hA._flush();
      on.set(false);
      hA._flush();
      color.set("blue");
      hA._flush();
      assertEquals(
        (host.firstChild as HTMLElement).style.color,
        "",
        `style → ${JSON.stringify(next)}: a dropped signal still writes`,
      );
      _unmount(hA);
    }
  } finally {
    await closeWindow(win);
  }
});
