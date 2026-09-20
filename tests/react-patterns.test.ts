// React code runs on AIR — proven against REAL React, not against a reading of
// its docs.
//
// Each pattern below is written ONCE, against a small kit (h, useState,
// useEffect, …), and run twice: under react + react-dom 19 (a test-only
// dependency; nothing ships with it) and under AIR, importing the React
// spellings from `aio/air`. The same interactions drive both, and after every
// step the page (innerHTML) and the pattern's own log (effect/cleanup order)
// must be IDENTICAL. A difference is an AIR bug — this is what makes
// "write React and it works" a checked fact.
//
// Covered: state + functional updates batched in one handler, effects with
// deps and cleanup order, useCallback identity as an effect dep, useMemo
// recompute, useRef (render counter + DOM ref), context, keyed lists that
// keep a child's local state across a reorder, a controlled input, a
// conditional child whose cleanup runs on unmount.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import * as air from "../src/air.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
// React decides at IMPORT time whether a DOM exists (`canUseDOM`), and Deno
// has no `window` then — so a statically imported react-dom silently fell
// back to its legacy change handling and a controlled input never fired
// onChange (measured: 0 calls). A DOM is installed FIRST, then React loads.
// React ships no types (they are @types/react); the test only drives it.
const importWindow = new Window({ url: "https://localhost" });
(globalThis as Any).window = importWindow;
(globalThis as Any).document = importWindow.document;
const React: Any = await import("react");
const createRoot: Any = ((await import("react-dom/client")) as Any).createRoot;
delete (globalThis as Any).window;
delete (globalThis as Any).document;
addEventListener("unload", () => void closeWindow(importWindow));
type Kit = {
  h: Any;
  Fragment: Any;
  useState: Any;
  useEffect: Any;
  useMemo: Any;
  useCallback: Any;
  useRef: Any;
  createContext: Any;
  useContext: Any;
};
type Pattern = {
  name: string;
  /** Build the root component from the kit; `log` records observable order. */
  app: (k: Kit, log: string[]) => Any;
  /** Interactions, each followed by a settle and a snapshot. */
  steps: ((root: HTMLElement) => void)[];
};

const reactKit: Kit = {
  h: React.createElement,
  Fragment: React.Fragment,
  useState: React.useState,
  useEffect: React.useEffect,
  useMemo: React.useMemo,
  useCallback: React.useCallback,
  useRef: React.useRef,
  createContext: React.createContext,
  useContext: React.useContext,
};
const airKit: Kit = {
  h: air.h,
  Fragment: air.Fragment,
  useState: air.useState,
  useEffect: air.useEffect,
  useMemo: air.useMemo,
  useCallback: air.useCallback,
  useRef: air.useRef,
  createContext: air.createContext,
  useContext: air.useContext,
};

const click = (root: HTMLElement, sel: string) =>
  (root.querySelector(sel) as HTMLElement).click();
/** Type the way a user does: the native value setter (React tracks the
 *  property, so assigning `.value` directly is invisible to it), then an
 *  `input` event. */
function type(root: HTMLElement, sel: string, text: string): void {
  const el = root.querySelector(sel) as HTMLInputElement;
  const proto = Object.getPrototypeOf(el);
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, text);
  el.dispatchEvent(
    new (el.ownerDocument.defaultView as Any).Event("input", {
      bubbles: true,
    }),
  );
}

const PATTERNS: Pattern[] = [
  {
    name: "state: click, and two functional updates in one handler",
    app: ({ h, useState }) =>
      function App() {
        const [n, setN] = useState(0);
        return h(
          "div",
          null,
          h("span", { id: "n" }, String(n)),
          h("button", { id: "inc", onClick: () => setN(n + 1) }, "+"),
          h("button", {
            id: "two",
            onClick: () => {
              setN((v: number) => v + 1);
              setN((v: number) => v + 1);
            },
          }, "+2"),
        );
      },
    steps: [(r) => click(r, "#inc"), (r) => click(r, "#two")],
  },
  {
    name: "effect: deps drive re-runs; cleanup runs before the next run",
    app: ({ h, useState, useEffect }, log) =>
      function App() {
        const [a, setA] = useState(0);
        const [b, setB] = useState(0);
        useEffect(() => {
          log.push(`run a=${a}`);
          return () => log.push(`cleanup a=${a}`);
        }, [a]);
        return h(
          "div",
          null,
          h("button", { id: "a", onClick: () => setA(a + 1) }, "a"),
          h("button", { id: "b", onClick: () => setB(b + 1) }, "b"),
          h("i", null, `${a}/${b}`),
        );
      },
    steps: [
      (r) => click(r, "#b"),
      (r) => click(r, "#a"),
      (r) => click(r, "#b"),
    ],
  },
  {
    name: "effect with no deps array: runs after every render",
    app: ({ h, useState, useEffect }, log) =>
      function App() {
        const [n, setN] = useState(0);
        useEffect(() => {
          log.push(`every ${n}`);
          return () => log.push(`undo ${n}`);
        });
        return h("button", { id: "x", onClick: () => setN(n + 1) }, String(n));
      },
    steps: [(r) => click(r, "#x"), (r) => click(r, "#x")],
  },
  {
    name: "useCallback: a stable identity keeps a deps effect from re-running",
    app: ({ h, useState, useEffect, useCallback }, log) =>
      function App() {
        const [n, setN] = useState(0);
        const load = useCallback(() => 1, []);
        useEffect(() => {
          log.push("subscribe");
          return () => log.push("unsubscribe");
        }, [load]);
        return h("button", { id: "x", onClick: () => setN(n + 1) }, String(n));
      },
    steps: [(r) => click(r, "#x"), (r) => click(r, "#x")],
  },
  {
    name: "useMemo: recomputes only when a dep changes",
    app: ({ h, useState, useMemo }, log) =>
      function App() {
        const [a, setA] = useState(2);
        const [b, setB] = useState(0);
        const sq = useMemo(() => {
          log.push(`compute ${a}`);
          return a * a;
        }, [a]);
        return h(
          "div",
          null,
          h("button", { id: "a", onClick: () => setA(a + 1) }, "a"),
          h("button", { id: "b", onClick: () => setB(b + 1) }, "b"),
          h("b", null, `${sq}:${b}`),
        );
      },
    steps: [(r) => click(r, "#b"), (r) => click(r, "#a")],
  },
  {
    name: "useRef: a render counter that does not re-render, and a DOM ref",
    app: ({ h, useState, useEffect, useRef }, log) =>
      function App() {
        const renders = useRef(0);
        renders.current++;
        const box = useRef(null);
        const [n, setN] = useState(0);
        useEffect(() => {
          log.push(
            `ref ${(box.current as Any)?.tagName} renders=${renders.current}`,
          );
        }, [n]);
        return h(
          "section",
          { ref: box },
          h("button", { id: "x", onClick: () => setN(n + 1) }, String(n)),
        );
      },
    steps: [(r) => click(r, "#x")],
  },
  {
    name: "context: a Provider's new value reaches the consumer",
    app: ({ h, useState, useContext, createContext }) => {
      const Theme = createContext("light");
      function Label() {
        return h("em", null, useContext(Theme));
      }
      return function App() {
        const [t, setT] = useState("light");
        return h(
          Theme.Provider,
          { value: t },
          h("button", { id: "t", onClick: () => setT("dark") }, "t"),
          h(Label, null),
        );
      };
    },
    steps: [(r) => click(r, "#t")],
  },
  {
    name:
      "keyed list: add, remove, reorder — a child keeps its own state by key",
    app: ({ h, useState }) => {
      function Row({ id }: { id: string }) {
        const [hits, setHits] = useState(0);
        return h(
          "li",
          null,
          h(
            "button",
            { class: `hit-${id}`, onClick: () => setHits(hits + 1) },
            id,
          ),
          h("span", null, String(hits)),
        );
      }
      return function App() {
        const [ids, setIds] = useState(["a", "b", "c"]);
        return h(
          "div",
          null,
          h(
            "button",
            { id: "rev", onClick: () => setIds([...ids].reverse()) },
            "rev",
          ),
          h(
            "button",
            { id: "add", onClick: () => setIds([...ids, "d"]) },
            "add",
          ),
          h(
            "button",
            { id: "del", onClick: () => setIds(ids.slice(1)) },
            "del",
          ),
          h("ul", null, ...ids.map((id: string) => h(Row, { key: id, id }))),
        );
      };
    },
    steps: [
      (r) => click(r, ".hit-b"),
      (r) => click(r, "#rev"),
      (r) => click(r, "#add"),
      (r) => click(r, "#del"),
      (r) => click(r, ".hit-b"),
    ],
  },
  {
    name: "controlled input: onChange sees every keystroke",
    app: ({ h, useState }) =>
      function App() {
        const [v, setV] = useState("");
        return h(
          "div",
          null,
          h("input", {
            id: "in",
            value: v,
            onChange: (e: Any) => setV(e.target.value),
          }),
          h("p", null, `[${v}]`),
        );
      },
    steps: [(r) => type(r, "#in", "h"), (r) => type(r, "#in", "hi")],
  },
  {
    name: "conditional child: unmounting it runs its cleanup",
    app: ({ h, useState, useEffect }, log) => {
      function Child() {
        useEffect(() => {
          log.push("child mount");
          return () => log.push("child cleanup");
        }, []);
        return h("span", null, "child");
      }
      return function App() {
        const [on, setOn] = useState(true);
        return h(
          "div",
          null,
          h("button", { id: "t", onClick: () => setOn(!on) }, "t"),
          on ? h(Child, null) : null,
        );
      };
    },
    steps: [(r) => click(r, "#t"), (r) => click(r, "#t")],
  },
];

/** One snapshot: the page, every input's LIVE value, and the log. */
type Snap = { html: string; values: string[]; log: string[] };
/** Normalized, and only for what a renderer may choose:
 *  - comment nodes (fragment/anchor markers);
 *  - an input's `value` ATTRIBUTE. React also mirrors a controlled input's
 *    value into the attribute; AIR sets the property only. What the user sees
 *    and types is identical (`values` compares the live property); the
 *    attribute shows only in `form.reset()` / `[value=…]` selectors. Copying
 *    React would change those for every existing aio app — the surface is not
 *    broken for parity. A known, deliberate difference (docs/ui/react.md). */
const norm = (html: string) =>
  html.replace(/<!--.*?-->/g, "").replace(
    /(<input[^>]*?) value="[^"]*"/g,
    "$1",
  );
const snap = (root: HTMLElement, log: string[]): Snap => ({
  html: norm(root.innerHTML),
  values: [...root.querySelectorAll("input")].map((i) =>
    (i as HTMLInputElement).value
  ),
  log: [...log],
});

async function runReact(p: Pattern, win: Window): Promise<Snap[]> {
  (globalThis as Any).IS_REACT_ACT_ENVIRONMENT = true;
  const g = globalThis as Any;
  const saved = { window: g.window, document: g.document };
  g.window = win;
  g.document = win.document;
  try {
    const root = win.document.createElement("div") as unknown as HTMLElement;
    win.document.body.appendChild(root as Any);
    const log: string[] = [];
    const App = p.app(reactKit, log);
    const r = createRoot(root);
    const snaps: Snap[] = [];
    await React.act(() => r.render(React.createElement(App)));
    snaps.push(snap(root, log));
    for (const step of p.steps) {
      await React.act(() => step(root));
      snaps.push(snap(root, log));
    }
    await React.act(() => r.unmount());
    snaps.push(snap(root, log));
    return snaps;
  } finally {
    g.window = saved.window;
    g.document = saved.document;
  }
}

async function runAir(p: Pattern, win: Window): Promise<Snap[]> {
  _setDocument(win.document as unknown as Document);
  const root = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(root as Any);
  const log: string[] = [];
  const App = p.app(airKit, log);
  const settle = async () => {
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const snaps: Snap[] = [];
  const handle = mount(root, App);
  await settle();
  snaps.push(snap(root, log));
  for (const step of p.steps) {
    step(root);
    await settle();
    snaps.push(snap(root, log));
  }
  _unmount(handle);
  await settle();
  snaps.push(snap(root, log));
  return snaps;
}

for (const p of PATTERNS) {
  Deno.test(`react patterns: ${p.name} — AIR matches React 19`, async () => {
    const rw = new Window({ url: "https://localhost" });
    const aw = new Window({ url: "https://localhost" });
    try {
      const want = await runReact(p, rw);
      const got = await runAir(p, aw);
      for (let i = 0; i < want.length; i++) {
        const at = i === 0
          ? "first render"
          : i === want.length - 1
          ? "unmount"
          : `after step ${i}`;
        assertEquals(got[i]!.html, want[i]!.html, `${p.name}: page, ${at}`);
        assertEquals(got[i]!.log, want[i]!.log, `${p.name}: log, ${at}`);
        assertEquals(
          got[i]!.values,
          want[i]!.values,
          `${p.name}: input values, ${at}`,
        );
      }
    } finally {
      await closeWindow(rw);
      await closeWindow(aw);
    }
  });
}
