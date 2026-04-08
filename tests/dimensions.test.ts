import { assertEquals, assertExists } from "@std/assert";
import { Window } from "happy-dom";
import { h } from "../src/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/aio-renderer.ts";
import { useDimensions } from "../src/dimensions.ts";
import type { DimensionsState } from "../src/dimensions.ts";

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
