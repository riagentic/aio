// React code runs on AIR — the edges. The same differential as
// tests/react-patterns.test.ts (one pattern, run under React 19 and under AIR,
// identical page and log after every step), for the shapes that were found
// broken in the field rather than the everyday ones:
//
//  - state set DURING render ("storing information from previous renders"):
//    the body re-runs before committing, not one render behind;
//  - a useState setter compares with Object.is only — `force({})` and
//    `setTodos([...todos])` render, though shallow-equal;
//  - a React 19 callback ref's returned cleanup runs INSTEAD of ref(null);
//  - a useEffect whose deps change shape keeps every later hook on its slot.
//
// Non-differential checks (where React throws or only warns) sit at the end.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import * as air from "../src/air.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { island } from "../src/air/island.ts";

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
// Closed HERE, not from an `unload` handler. It exists only so `react` and
// `react-dom/client` see a DOM while they initialise; both have finished
// above, and `window`/`document` are already off the global. An unload
// handler cannot await, so it dropped `closeWindow`'s promise and left
// happy-dom's settle timer armed — the same unawaited-close shape that cost a
// shard in tests/air-ssr-attr-name.test.ts.
await closeWindow(importWindow);
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
    name: "setState during render: derived from the previous prop",
    app: ({ h, useState }) => {
      function C({ v }: Any) {
        const [prev, setPrev] = useState(v);
        const [changes, setChanges] = useState(0);
        if (prev !== v) {
          setPrev(v);
          setChanges(changes + 1);
        }
        return h("b", null, `${v}/${changes}`);
      }
      return function App() {
        const [v, setV] = useState(0);
        return h(
          "div",
          null,
          h("button", { id: "v", onClick: () => setV(v + 1) }, "v"),
          h(C, { v }),
        );
      };
    },
    steps: [(r) => click(r, "#v"), (r) => click(r, "#v")],
  },
  {
    name: "setState during render: the effect sees only the settled render",
    app: ({ h, useState, useEffect }, log) => {
      function C({ v }: Any) {
        const [prev, setPrev] = useState(v);
        const [changes, setChanges] = useState(0);
        if (prev !== v) {
          setPrev(v);
          setChanges((c: number) => c + 1);
        }
        useEffect(() => {
          log.push(`effect v=${v} changes=${changes}`);
          return () => log.push(`cleanup v=${v} changes=${changes}`);
        }, [v, changes]);
        useEffect(() => {
          log.push(`every ${v}/${changes}`);
        });
        return h("b", null, `${v}/${changes}`);
      }
      return function App() {
        const [v, setV] = useState(0);
        return h(
          "div",
          null,
          h("button", { id: "v", onClick: () => setV(v + 1) }, "v"),
          h(C, { v }),
        );
      };
    },
    steps: [(r) => click(r, "#v"), (r) => click(r, "#v")],
  },
  {
    name: "setState during render: on the first render, and on its own update",
    app: ({ h, useState, useEffect }, log) =>
      function App() {
        const [n, setN] = useState(0);
        const [shown, setShown] = useState(-1);
        if (shown !== n) setShown(n); // settles on the first render too
        useEffect(() => {
          log.push(`mounted shown=${shown}`);
        }, []);
        return h("button", { id: "x", onClick: () => setN(n + 2) }, `${shown}`);
      },
    steps: [(r) => click(r, "#x"), (r) => click(r, "#x")],
  },
  {
    name: "useState setter: Object.is — force({}) re-renders",
    app: ({ h, useState, useRef }) =>
      function App() {
        const [, force] = useState({});
        const box = useRef({ n: 0 });
        return h(
          "div",
          null,
          h("button", {
            id: "x",
            onClick: () => {
              box.current.n++;
              force({});
            },
          }, "x"),
          h("b", null, String(box.current.n)),
        );
      },
    steps: [(r) => click(r, "#x"), (r) => click(r, "#x")],
  },
  {
    name: "useState setter: Object.is — a copied array after a mutation",
    app: ({ h, useState }) =>
      function App() {
        const [todos, setTodos] = useState([{ t: "a", done: false }]);
        return h(
          "div",
          null,
          h("button", {
            id: "x",
            onClick: () => {
              todos[0]!.done = !todos[0]!.done;
              setTodos([...todos]);
            },
          }, "x"),
          h("b", null, todos.map((t: Any) => `${t.t}:${t.done}`).join(",")),
        );
      },
    steps: [(r) => click(r, "#x"), (r) => click(r, "#x")],
  },
  {
    name: "callback ref: a returned cleanup runs instead of ref(null)",
    app: ({ h, useState }, log) =>
      function App() {
        const [on, setOn] = useState(true);
        return h(
          "div",
          null,
          h("button", { id: "t", onClick: () => setOn(!on) }, "t"),
          on
            ? h("span", {
              ref: (el: Any) => {
                log.push(`attach ${el?.tagName ?? el}`);
                return () => log.push("detach");
              },
            }, "s")
            : null,
        );
      },
    steps: [(r) => click(r, "#t"), (r) => click(r, "#t")],
  },
  {
    name:
      "callback ref: a fresh ref each render — old cleanup, then new attach",
    app: ({ h, useState }, log) =>
      function App() {
        const [n, setN] = useState(0);
        return h(
          "div",
          null,
          h("button", { id: "x", onClick: () => setN(n + 1) }, "x"),
          h("i", {
            ref: (el: Any) => {
              log.push(`attach ${n} ${el?.tagName ?? el}`);
              return () => log.push(`detach ${n}`);
            },
          }, String(n)),
        );
      },
    steps: [(r) => click(r, "#x"), (r) => click(r, "#x")],
  },
  {
    name: "callback ref: returning nothing still gets null",
    app: ({ h, useState }, log) =>
      function App() {
        const [on, setOn] = useState(true);
        return h(
          "div",
          null,
          h("button", { id: "t", onClick: () => setOn(!on) }, "t"),
          on
            ? h("span", {
              ref: (el: Any) => {
                log.push(`ref ${el?.tagName ?? el}`);
              },
            }, "s")
            : null,
        );
      },
    steps: [(r) => click(r, "#t")],
  },
  {
    name:
      "useEffect deps change length (every dep differs) — later hooks keep their slots",
    app: ({ h, useState, useEffect, useRef }, log) =>
      function App() {
        const [ids, setIds] = useState([1, 2]);
        const r = useRef("r");
        useEffect(() => {
          log.push(`run ${ids.join()}`);
          return () => log.push(`clean ${ids.join()}`);
        }, ids);
        const [m] = useState("m");
        return h(
          "div",
          null,
          h("button", { id: "x", onClick: () => setIds([3]) }, "x"),
          h("b", null, `${ids.join()}|${r.current}|${m}`),
        );
      },
    steps: [(r) => click(r, "#x")],
  },
  {
    name:
      "useEffect: no deps → [] → [] → no deps — later hooks keep their slots",
    app: ({ h, useState, useEffect, useRef }, log) =>
      function App() {
        const [mode, setMode] = useState(0);
        const r = useRef("r");
        useEffect(
          () => {
            log.push(`run mode=${mode}`);
            return () => log.push(`clean mode=${mode}`);
          },
          mode === 1 || mode === 2 ? [] : undefined,
        );
        const [m] = useState("m");
        return h(
          "div",
          null,
          h("button", { id: "x", onClick: () => setMode(mode + 1) }, "x"),
          h("b", null, `${mode}|${r.current}|${m}`),
        );
      },
    steps: [
      (r) => click(r, "#x"),
      (r) => click(r, "#x"),
      (r) => click(r, "#x"),
    ],
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

// ── Where React throws or only warns: AIR's own answer, pinned ──────────

/** A fresh AIR page; `run` gets the root and returns what to unmount. */
async function airPage(
  run: (root: HTMLElement) => Promise<void> | void,
): Promise<void> {
  const win = new Window({ url: "https://localhost" });
  try {
    _setDocument(win.document as unknown as Document);
    const root = win.document.createElement("div") as unknown as HTMLElement;
    win.document.body.appendChild(root as Any);
    await run(root);
  } finally {
    await closeWindow(win);
  }
}
const tick = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
};

Deno.test("setState during render that never settles: a clear 'too many re-renders' throw", async () => {
  await airPage((root) => {
    let renders = 0;
    function Loop() {
      const [n, setN] = air.useState(0);
      renders++;
      setN(n + 1); // unconditional — React throws "Too many re-renders"
      return air.h("b", null, String(n));
    }
    let err: unknown;
    try {
      _unmount(mount(root, Loop));
    } catch (e) {
      err = e;
    }
    assertEquals(err instanceof Error, true, "a throw, not a hang");
    assertStringIncludes((err as Error).message, "too many re-renders");
    assertStringIncludes((err as Error).message, "<Loop>");
    assertEquals(renders, 26, "bounded: the first pass plus 25 re-runs");
  });
});

Deno.test("setState during render: a setter of ANOTHER component's state does not re-run this body", async () => {
  await airPage(async (root) => {
    const bodies: string[] = [];
    let setOuter: (v: number) => void = () => {};
    function Inner({ n }: Any) {
      bodies.push(`inner ${n}`);
      if (n === 0) setOuter(1); // the parent's state, written from the child
      return air.h("i", null, String(n));
    }
    function Outer() {
      const [n, set] = air.useState(0);
      setOuter = set;
      bodies.push(`outer ${n}`);
      return air.h(Inner, { n });
    }
    const hd = mount(root, Outer);
    await tick();
    // The parent heard the write the ordinary way (it was subscribed) and
    // re-rendered once; the child was not re-run in place for it.
    assertEquals(root.textContent, "1");
    assertEquals(bodies, ["outer 0", "inner 0", "outer 1", "inner 1"]);
    _unmount(hd);
  });
});

Deno.test("useEffect deps shrinking to [] — no crash, later hooks intact, re-run (React keeps it; both warn)", async () => {
  await airPage(async (root) => {
    const log: string[] = [];
    const warned: string[] = [];
    const warn = console.warn;
    const g = globalThis as Any;
    const wasDev = g.__aioDev;
    g.__aioDev = true; // the dev warning is what this checks
    console.warn = (...a: unknown[]) =>
      void warned.push(a.map(String).join(" "));
    try {
      function App() {
        const [ids, setIds] = air.useState([1, 2]);
        const r = air.useRef("r");
        air.useEffect(() => {
          log.push(`run ${ids.join()}`);
          return () => log.push(`clean ${ids.join()}`);
        }, ids);
        const [m] = air.useState("m");
        return air.h(
          "div",
          null,
          air.h("button", { id: "x", onClick: () => setIds(ids.slice(1)) }),
          air.h("b", null, `${ids.join()}|${r.current}|${m}`),
        );
      }
      const hd = mount(root, App);
      await tick();
      click(root, "#x");
      await tick();
      click(root, "#x");
      await tick();
      assertEquals(root.querySelector("b")!.textContent, "|r|m");
      // Length-first, the rule every deps hook in compat.ts shares: a deps
      // array of another length is a change. React compares only the common
      // prefix and would skip this last run.
      assertEquals(log, [
        "run 1,2",
        "clean 1,2",
        "run 2",
        "clean 2",
        "run ",
      ]);
      assertEquals(
        warned.filter((w) => w.includes("deps changed shape")).length,
        2,
        "dev says so, as React does",
      );
      _unmount(hd);
    } finally {
      console.warn = warn;
      g.__aioDev = wasDev;
    }
  });
});

Deno.test("island(): JSX props reach mount per instance, win over config.props, and update in place", async () => {
  await airPage(async (root) => {
    const calls: string[] = [];
    const Widget = island({
      load: () => Promise.resolve({ default: "W" }),
      mount: (container, _c, props) => {
        calls.push(`mount ${props.symbol}/${props.theme}`);
        container.textContent = `${props.symbol}/${props.theme}`;
        return {
          update(p) {
            calls.push(`update ${p.symbol}/${p.theme}`);
            container.textContent = `${p.symbol}/${p.theme}`;
          },
          unmount() {
            calls.push("unmount");
          },
        };
      },
      props: () => ({ symbol: "default", theme: "dark" }),
    });
    const sym = air.signal("MSFT");
    const other = air.signal(0);
    function App() {
      void other.value; // re-renders App without changing the JSX props
      return air.h(
        "div",
        null,
        air.h(Widget, { symbol: "AAPL" }),
        air.h(Widget, { symbol: sym.value, theme: "light" }),
      );
    }
    const hd = mount(root, App);
    await tick();
    assertEquals(
      [...root.firstElementChild!.children].map((d) => d.textContent),
      ["AAPL/dark", "MSFT/light"],
    );
    sym.set("GOOG");
    await tick();
    assertEquals(
      [...root.firstElementChild!.children].map((d) => d.textContent),
      ["AAPL/dark", "GOOG/light"],
    );
    other.set(1); // same JSX props — no update
    await tick();
    assertEquals(calls, [
      "mount AAPL/dark",
      "mount MSFT/light",
      "update GOOG/light",
    ]);
    _unmount(hd);
  });
});
