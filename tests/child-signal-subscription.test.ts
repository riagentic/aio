// AIO-7.5: each component instance independently re-renders when ITS tracked
// signals change — no `void sig.value` parent incantation required.

import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { signal } from "../src/state/signal.ts";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";

function createDOM(): {
  document: Document;
  root: HTMLElement;
  cleanup: () => void;
} {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { document: doc, root, cleanup: () => win.happyDOM.close() };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

Deno.test({
  name: "7.5: child reading a module signal updates when parent never reads it",
  async fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const sig = signal("first");
    const Child = () => h("span", null, sig.value);
    // Parent does NOT read sig — no void sig.value incantation.
    const Parent = () => h("div", null, h(Child, null));
    const handle = mount(root, Parent);
    await flush();
    assertEquals(root.querySelector("span")!.textContent, "first");

    sig.set("second");
    handle._flush();
    await flush();
    assertEquals(
      root.querySelector("span")!.textContent,
      "second",
      "child must re-render on its own subscription",
    );
    _unmount(handle);
    await cleanup();
  },
});

Deno.test({
  name: "7.5: parent re-render does not orphan the child's subscription",
  async fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const childSig = signal("a");
    const parentSig = signal(0);
    const Child = () => h("span", null, childSig.value);
    const Parent = () => {
      const n = parentSig.value; // parent re-renders on parentSig only
      return h("div", { "data-n": String(n) }, h(Child, null));
    };
    const handle = mount(root, Parent);
    await flush();
    assertEquals(root.querySelector("span")!.textContent, "a");

    parentSig.set(1); // parent-driven re-render reconciles the child
    handle._flush();
    await flush();

    childSig.set("b"); // child's own signal AFTER parent re-render
    handle._flush();
    await flush();
    assertEquals(
      root.querySelector("span")!.textContent,
      "b",
      "child subscription must survive parent reconciliation",
    );
    _unmount(handle);
    await cleanup();
  },
});
