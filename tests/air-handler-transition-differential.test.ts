// Differential: an element whose event handlers come, go, swap and turn null
// across diffs must fire exactly the handlers a fresh mount of the same props
// fires.
//
// `onChange` and `onInput` share a slot: on a text control `onChange` IS the
// `input` event unless an `onInput` sits beside it (then it is native
// `change`). The diff kept that map for a handler that ARRIVED, but a handler
// turning null / absent was removed under a name recomputed from the NEW
// props, whether it had ever been registered or not:
//   · `onChange={save} onInput={live ? preview : undefined}` — `live` going
//     false deleted the `input` slot, which `onChange` owned: save never
//     fired again (and the same for a null `onChange` next to an `onInput`);
//   · `onChange={null}` beside a departing `onInput` removed `input` and left
//     the real registration on `change` live — a handler the component no
//     longer has kept firing.
//
//     for s in 1 2 3 4 5; do FUZZ_SEED=$s deno test -A \
//       tests/air-handler-transition-differential.test.ts; done
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
import { signal } from "../src/state/signal.ts";
import { fuzzEnvInt } from "./fuzz-seed.ts";

const SEED = fuzzEnvInt("FUZZ_SEED", 0xe7e27) & 0x7fffffff;
const ROUNDS = fuzzEnvInt("FUZZ_ROUNDS", 300, 1);
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
  ["input", { type: "text" }],
  ["input", { type: "checkbox" }],
  ["textarea", {}],
  ["select", {}],
  ["button", { type: "button" }],
  ["div", {}],
  ["input", { type: "file" }],
  ["input", { type: "range" }],
];
const EVS = [
  "onClick",
  "onInput",
  "onChange",
  "onKeyDown",
  "onFocus",
  "onBlur",
  "onPointerDown",
  "onMouseEnter",
];
/** [dispatched type, constructor, bubbles] */
const FIRE: readonly [string, string, boolean][] = [
  ["click", "MouseEvent", true],
  ["input", "Event", true],
  ["change", "Event", true],
  ["keydown", "KeyboardEvent", true],
  ["focus", "FocusEvent", false],
  ["blur", "FocusEvent", false],
  ["pointerdown", "PointerEvent", true],
  ["mouseenter", "MouseEvent", false],
];

let log: string[] = [];
const H: Record<string, (e: Event) => void> = {};
for (const e of EVS) {
  for (const v of ["A", "B"]) {
    H[e + v] = (ev: Event) => void log.push(`${e}${v}:${ev.type}`);
  }
}

type Model = { tag: number; type?: string; evs: Record<string, string | null> };
function gen(tag: number): Model {
  const evs: Model["evs"] = {};
  for (const e of EVS) {
    const r = rand();
    if (r >= 0.4) evs[e] = r < 0.55 ? null : r < 0.8 ? "A" : "B";
  }
  const m: Model = { tag, evs };
  // The input's TYPE decides `onChange`'s event, so it moves too.
  if (TAGS[tag]![0] === "input" && rand() < 0.2) {
    m.type = pick(["text", "checkbox", "file", "range"]);
  }
  return m;
}

const model = signal<Model | null>(null);
function build(m: Model) {
  const [t, base] = TAGS[m.tag]!;
  const p: Record<string, unknown> = { ...base };
  if (m.type) p.type = m.type;
  for (const [k, v] of Object.entries(m.evs)) {
    p[k] = v === null ? null : H[k + v];
  }
  return t === "select"
    ? h(
      t,
      p,
      h("option", { value: "a" }, "A"),
      h("option", { value: "b" }, "B"),
    )
    : h(t, p);
}
const App = () => {
  const m = model.value;
  return m ? h("main", null, h("section", null, build(m))) : null;
};

function fire(host: Element, win: Window): string {
  const el = host.querySelector("section")!.firstElementChild!;
  // deno-lint-ignore no-explicit-any
  const W = win as unknown as Record<string, any>;
  log = [];
  for (const [type, C, bubbles] of FIRE) {
    el.dispatchEvent(new W[C](type, { bubbles, cancelable: true }));
  }
  return log.join(",");
}

Deno.test("differential: handlers that come, go, swap and turn null fire what a fresh mount fires", async () => {
  setDevMode(true);
  const ow = console.warn;
  console.warn = () => {}; // a11y hints on bare handlers — not this test
  let checks = 0;
  try {
    for (let round = 0; round < ROUNDS; round++) {
      const win = new Window({ url: "http://localhost/" });
      try {
        const doc = win.document as unknown as Document;
        _setDocument(doc as never);
        doc.body.innerHTML = `<div id="a"></div><div id="b"></div>`;
        const tag = Math.floor(rand() * TAGS.length);
        let m = gen(tag);
        model.set(m);
        const host = doc.getElementById("a")!;
        const hyd = rand() < 0.4;
        const history = [JSON.stringify(m) + (hyd ? " (hydrate)" : "")];
        if (hyd) host.innerHTML = renderToString(h(App, null));
        const hA = hyd ? hydrate(host, App) : mount(host, App);
        hA._flush();
        for (let step = 0; step < STEPS; step++) {
          m = gen(tag);
          model.set(m);
          history.push(JSON.stringify(m));
          hA._flush();
          const got = fire(host, win);
          const b = doc.getElementById("b")!;
          const hB = mount(b, App);
          hB._flush();
          const want = fire(b, win);
          _unmount(hB);
          assertEquals(
            got,
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
    setDevMode(false);
  }
  assertEquals(checks, ROUNDS * STEPS);
});

// The two shapes, pinned directly.
Deno.test("handlers switched off together stop firing; a null onInput keeps its onChange", async () => {
  const win = new Window({ url: "http://localhost/" });
  const doc = win.document as unknown as Document;
  _setDocument(doc as never);
  const fireAll = (el: Element) => {
    for (const t of ["input", "change"]) {
      el.dispatchEvent(new win.Event(t, { bubbles: true }) as never);
    }
  };
  try {
    // `editing` off: both handlers null. `onChange` was on native `change`
    // (an `onInput` sat beside it) and stayed there.
    const log: string[] = [];
    const editing = signal(true);
    const host = doc.createElement("div");
    const hA = mount(host, () =>
      h("input", {
        type: "text",
        onInput: editing.value ? () => log.push("input") : null,
        onChange: editing.value ? () => log.push("change") : null,
      }));
    hA._flush();
    editing.set(false);
    hA._flush();
    fireAll(host.querySelector("input")!);
    assertEquals(log, [], "a handler the component no longer has fired");
    _unmount(hA);

    // A null `onInput` that then LEAVES the props (a forwarded `...rest`)
    // took the `input` slot `onChange` owns.
    const saved: string[] = [];
    const withKey = signal(true);
    const host2 = doc.createElement("div");
    const hB = mount(host2, () =>
      h("input", {
        type: "text",
        onChange: () => saved.push("save"),
        ...(withKey.value ? { onInput: null } : {}),
      }));
    hB._flush();
    withKey.set(false);
    hB._flush();
    fireAll(host2.querySelector("input")!);
    assertEquals(saved, ["save"], "onChange stopped firing");
    _unmount(hB);
  } finally {
    await closeWindow(win);
  }
});
