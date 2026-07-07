// AIO-390: onMount must run after the component's DOM subtree + refs are
// committed, so ref.current is the real node (not null) inside onMount.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { h } from "../src/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/aio-renderer.ts";
import { onMount, useRef } from "../src/renderer-lifecycle.ts";

function createDOM() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { document: doc, root, cleanup: () => win.happyDOM.close() };
}

Deno.test({
  name: "onMount: ref.current is committed (non-null) for own subtree",
  async fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    let tagInMount: string | null = null;
    const App = () => {
      const ref = useRef<HTMLElement>(null!);
      onMount(() => {
        tagInMount = ref.current ? ref.current.nodeName : null;
      });
      return h("canvas", { ref });
    };
    const handle = mount(root, App);
    assertEquals(tagInMount, "CANVAS"); // was null before AIO-390
    _unmount(handle);
    await cleanup();
  },
});

Deno.test({
  name: "onMount: children mount before parent (bottom-up)",
  async fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const order: string[] = [];
    const Child = () => {
      onMount(() => order.push("child"));
      return h("span", null, "c");
    };
    const Parent = () => {
      onMount(() => order.push("parent"));
      return h("div", null, h(Child, null));
    };
    const handle = mount(root, Parent);
    assertEquals(order, ["child", "parent"]);
    _unmount(handle);
    await cleanup();
  },
});
