import { assertEquals, assertExists } from "@std/assert";
import { Window } from "happy-dom";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { useDimensions } from "../src/air/dimensions.ts";
import type { DimensionsState } from "../src/air/dimensions.ts";

function createDOM() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { document: doc, root, cleanup: () => win.happyDOM.close() };
}

Deno.test({
  name: "useDimensions: returns ref and dimension signals",
  async fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);
    const captured: { dims: DimensionsState | null } = { dims: null };

    function App() {
      captured.dims = useDimensions();
      return h("div", { ref: captured.dims.ref }, "hello");
    }

    const handle = mount(root, App);
    assertExists(captured.dims);
    const dims = captured.dims as DimensionsState;
    assertExists(dims.ref);
    assertEquals(typeof dims.width.value, "number");
    assertEquals(typeof dims.height.value, "number");
    // happy-dom elements have 0 dimensions
    assertEquals(dims.width.value, 0);
    assertEquals(dims.height.value, 0);
    _unmount(handle);
    await cleanup();
  },
});

Deno.test({
  name: "useDimensions: persists ref identity across re-renders",
  async fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);
    const refs: DimensionsState[] = [];

    function App() {
      const dims = useDimensions();
      refs.push(dims);
      return h("div", { ref: dims.ref }, "hello");
    }

    const handle = mount(root, App);
    assertEquals(refs.length, 1);
    _unmount(handle);
    await cleanup();
  },
});

// Without a ResizeObserver the hook used to return immediately, leaving both
// signals at their initial 0 for the component's whole life: a layout that
// branches on `width.value < 600` silently took the narrow path forever, with
// nothing logged. A measurement is still possible — it just cannot TRACK — so
// take it, and say that live updates are off.
//
// (Deno has no global ResizeObserver, so this environment IS the no-observer
// case; the test above pins the same path for an element that measures 0.)
Deno.test({
  name:
    "useDimensions: with no ResizeObserver, the element is still measured once",
  async fn() {
    const win = new Window({ url: "https://localhost" });
    const doc = win.document as unknown as Document;
    // happy-dom reports every element as 0×0; give this window a real layout
    // so "measured" and "left at the initial 0" are distinguishable.
    // deno-lint-ignore no-explicit-any
    const proto = (win as any).HTMLElement.prototype;
    Object.defineProperty(proto, "clientWidth", {
      get: () => 640,
      configurable: true,
    });
    Object.defineProperty(proto, "clientHeight", {
      get: () => 48,
      configurable: true,
    });
    const root = doc.createElement("div");
    doc.body.appendChild(root);
    _setDocument(doc);
    try {
      const captured: { dims: DimensionsState | null } = { dims: null };
      function App() {
        captured.dims = useDimensions();
        return h("div", { ref: captured.dims.ref }, "hello");
      }
      const handle = mount(root, App);
      const dims = captured.dims as DimensionsState;
      assertEquals(dims.width.value, 640, "measured at mount, not left at 0");
      assertEquals(dims.height.value, 48);
      _unmount(handle);
    } finally {
      await win.happyDOM.close();
    }
  },
});

// A computed padding of "" (happy-dom, jsdom, a detached element) made
// `clientWidth - parseFloat("")` NaN, and NaN compares false against
// everything: a responsive branch is then neither narrow nor wide.
Deno.test({
  name: "useDimensions: a dimension is always a finite number, never NaN",
  async fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);
    const captured: { dims: DimensionsState | null } = { dims: null };
    function App() {
      captured.dims = useDimensions();
      return h("div", { ref: captured.dims.ref }, "hello");
    }
    const handle = mount(root, App);
    const dims = captured.dims as DimensionsState;
    assertEquals(Number.isFinite(dims.width.value), true);
    assertEquals(Number.isFinite(dims.height.value), true);
    _unmount(handle);
    await cleanup();
  },
});
