// An `<ErrorBoundary>` must recover when the component that threw on its FIRST
// render sits DEEPER than the boundary's direct child.
//
// A first-render throw has no instance of its own, so the signals it read are
// subscribed on the instance below it on the stack (`abortComponent`). With the
// thrower as the boundary's direct child that is the boundary's owner, which
// stays on screen. One wrapper deeper it is the WRAPPER — an instance built in
// the same failed pass and thrown away with it when the boundary swaps in its
// fallback. Measured:
//
//   <ErrorBoundary><Wrapper><Thrower/></Wrapper></ErrorBoundary>
//   boot (not ready)   <div><i>err:not ready</i></div>
//   after ready=true   <div><i>err:not ready</i></div>   ← never re-ran
//
// while the same tree without the wrapper recovered. The same shape as the
// `<Suspense>` retry fixed in c8f96c5ea: subscribe on the owner that is on
// screen.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { ErrorBoundary, h } from "../src/air/vdom.ts";
import type { ComponentFn, VNode } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";

type Shape = {
  /** Wrappers between the boundary and the thrower. */
  depth: number;
  /** Mount the boundary on a later render instead of at boot. */
  later?: boolean;
  /** Pass the boundary through a layout component's `children`. */
  viaLayout?: boolean;
  /** A fallback-less boundary between the real one and the wrappers. */
  bareInner?: boolean;
};

async function recovers(
  shape: Shape,
): Promise<{ before: string; after: string }> {
  const win = new Window({ url: "http://localhost/" });
  // deno-lint-ignore no-explicit-any
  const doc = win.document as any;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  const ready = signal(false);
  const show = signal(!shape.later);
  const Thrower = () => {
    if (!ready.value) throw new Error("not ready");
    return h("p", null, ["loaded"]);
  };
  let inner: ComponentFn = Thrower as ComponentFn;
  for (let i = 0; i < shape.depth; i++) {
    const C = inner;
    inner = (() => h("section", null, [h(C, null)])) as ComponentFn;
  }
  const Layout = (p: { children?: unknown }) =>
    h("article", null, p.children as VNode[]);
  const content = shape.bareInner
    ? h(ErrorBoundary, {}, [h(inner, null)])
    : h(inner, null);
  const boundary = () =>
    h(ErrorBoundary, {
      fallback: (e: Error) => h("i", null, ["err:" + e.message]),
    }, [content]);
  const App = () =>
    h("div", null, [
      !show.value
        ? "off"
        : shape.viaLayout
        ? h(Layout as ComponentFn, null, [boundary()])
        : boundary(),
    ]);
  const origErr = console.error;
  console.error = () => {};
  try {
    const hd = mount(root, App as ComponentFn);
    if (shape.later) {
      show.set(true);
      hd._flush();
    }
    const before = root.innerHTML;
    ready.set(true);
    hd._flush();
    const after = root.innerHTML;
    _unmount(hd);
    return { before, after };
  } finally {
    console.error = origErr;
    _setDocument(null as never);
    await closeWindow(win);
  }
}

const cases: [string, Shape, string][] = [
  ["direct child (already worked)", { depth: 0 }, "<div><p>loaded</p></div>"],
  [
    "one wrapper deep",
    { depth: 1 },
    "<div><section><p>loaded</p></section></div>",
  ],
  [
    "two wrappers deep",
    { depth: 2 },
    "<div><section><section><p>loaded</p></section></section></div>",
  ],
  [
    "mounted on a later render",
    { depth: 1, later: true },
    "<div><section><p>loaded</p></section></div>",
  ],
  [
    "the boundary passed through a layout's children",
    { depth: 1, viaLayout: true },
    "<div><article><section><p>loaded</p></section></article></div>",
  ],
  [
    "a fallback-less boundary in between",
    { depth: 1, bareInner: true },
    "<div><section><p>loaded</p></section></div>",
  ],
];

for (const [name, shape, loaded] of cases) {
  Deno.test(`ErrorBoundary deep first-render throw recovers: ${name}`, async () => {
    const { before, after } = await recovers(shape);
    assertEquals(
      before.includes("err:not ready"),
      true,
      `the boundary caught it: ${before}`,
    );
    assertEquals(after, loaded, "the signal that broke it must bring it back");
  });
}

Deno.test("ErrorBoundary deep first-render throw recovers: a NEW thrower under an existing wrapper", async () => {
  // The boundary and its wrapper are already on screen and GOOD; the owner's
  // re-render hands the wrapper a prop that mounts the thrower. The top of the
  // stack is then the committed wrapper — which the boundary's catch unmounts.
  const win = new Window({ url: "http://localhost/" });
  // deno-lint-ignore no-explicit-any
  const doc = win.document as any;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  const ready = signal(false);
  const mode = signal("idle");
  const Thrower = () => {
    if (!ready.value) throw new Error("not ready");
    return h("p", null, ["loaded"]);
  };
  const Wrapper = (p: { mode: string }) =>
    h("section", null, [
      p.mode === "go" ? h(Thrower as ComponentFn, null) : "idle",
    ]);
  const App = () =>
    h("div", null, [
      h(ErrorBoundary, {
        fallback: (e: Error) => h("i", null, ["err:" + e.message]),
      }, [h(Wrapper as ComponentFn, { mode: mode.value })]),
    ]);
  const origErr = console.error;
  console.error = () => {};
  try {
    const hd = mount(root, App as ComponentFn);
    assertEquals(root.innerHTML, "<div><section>idle</section></div>");
    mode.set("go");
    hd._flush();
    assertEquals(root.innerHTML, "<div><i>err:not ready</i></div>");
    ready.set(true);
    hd._flush();
    assertEquals(root.innerHTML, "<div><section><p>loaded</p></section></div>");
    _unmount(hd);
  } finally {
    console.error = origErr;
    _setDocument(null as never);
    await closeWindow(win);
  }
});
