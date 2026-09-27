// A boundary that falls back on a parent re-render removes EVERYTHING its
// children built — even after a child re-rendered itself into a new shape.
//
// A boundary's `_dom` is a copy of its first child's first node, refreshed
// only when the boundary itself is diffed. A child that re-renders on its OWN
// signal and swaps its root (`<em>` → a Fragment) detaches that node behind
// the boundary's back. The catch then judged the region's position "unknown"
// and skipped the sweep, so a sibling the failed pass had already inserted
// stayed on the page beside the fallback — and when the error cleared, the
// recovery built it AGAIN: two copies of a row, and a stray one above it.
// `<ErrorBoundary>` and `<Suspense>` share the region code, and both did it.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import {
  type ComponentFn,
  ErrorBoundary,
  Fragment,
  h,
  Suspense,
  type VNode,
} from "../src/air/vdom.ts";
import { lazy } from "../src/air/vdom-lazy.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";

const Pending = lazy(() => new Promise<never>(() => {}));
const Throws = () => {
  throw new Error("E");
};

async function scenario(
  boundary: (kids: (VNode | null)[]) => VNode,
  failing: ComponentFn,
  fallbackHtml: string,
): Promise<void> {
  const win = new Window({ url: "http://localhost/" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const origError = console.error;
  console.error = () => {};
  const top = signal(0);
  const lead = signal(0);
  const Lead = () =>
    lead.value
      ? h(Fragment, null, "l", h("em", null, "L"))
      : h("em", null, "L0");
  const App = () => {
    const t = top.value;
    return h(
      "div",
      null,
      boundary([
        h(Lead as ComponentFn, null),
        t ? h("u", null, "new") : null,
        t === 1 ? h(failing, null) : h("span", null, "C"),
      ]),
      "tail",
    );
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  const handle = mount(root, App as ComponentFn);
  try {
    lead.set(1); // Lead re-renders itself: <em> → "l"<em>
    await tick();
    assertEquals(
      root.innerHTML,
      "<div>l<em>L</em><!----><span>C</span>tail</div>",
    );
    top.set(1); // the parent inserts <u>, then a later child fails
    await tick();
    assertEquals(root.innerHTML, `<div>${fallbackHtml}tail</div>`);
    top.set(2); // recovered
    await tick();
    assertEquals(
      root.innerHTML,
      "<div>l<em>L</em><u>new</u><span>C</span>tail</div>",
    );
  } finally {
    _unmount(handle);
    console.error = origError;
    _setDocument(null as never);
    await closeWindow(win);
  }
}

Deno.test("ErrorBoundary: a catch after a child reshaped itself leaves no debris", async () => { // aio-ok: scenario() asserts every step
  await scenario(
    (kids) =>
      h(
        ErrorBoundary,
        { fallback: (e: Error) => h("b", null, "fb:" + e.message) },
        ...kids,
      ),
    Throws as ComponentFn,
    "<b>fb:E</b>",
  );
});

Deno.test("Suspense: a fallback after a child reshaped itself leaves no debris", async () => { // aio-ok: scenario() asserts every step
  await scenario(
    (kids) => h(Suspense, { fallback: h("b", null, "wait") }, ...kids),
    Pending as ComponentFn,
    "<b>wait</b>",
  );
});
