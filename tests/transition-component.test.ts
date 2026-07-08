import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { signal } from "../src/state/signal.ts";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { Transition } from "../src/air/transition-component.ts";
import { fade } from "../src/air/transition.ts";

// happy-dom timers drained via win.happyDOM.close() — sanitizers re-enabled

function createDOM() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { win, doc, root };
}

Deno.test({
  name: "Transition: renders child normally",
  async fn() {
    const { win, doc, root } = createDOM();
    _setDocument(doc);
    const App = () =>
      h(
        Transition,
        { enter: fade, exit: fade },
        h("div", { id: "box" }, "hello"),
      );
    const handle = mount(root, App);
    const box = root.querySelector("#box");
    assertEquals(box !== null, true);
    assertEquals(box!.textContent, "hello");
    // Wait for enter animation timer to complete before unmount
    await new Promise((r) => setTimeout(r, 350));
    _unmount(handle);
    await win.happyDOM.close();
  },
});

Deno.test({
  name: "Transition: null child renders nothing",
  async fn() {
    const { win, doc, root } = createDOM();
    _setDocument(doc);
    const App = () => h(Transition, { enter: fade, exit: fade }, null);
    const handle = mount(root, App);
    // AIO-107: null children produce invisible comment placeholders for positional stability
    assertEquals(root.innerHTML, "<!---->");
    _unmount(handle);
    await win.happyDOM.close();
  },
});

Deno.test({
  name: "Transition: child removal is deferred during exit animation",
  async fn() {
    const { win, doc, root } = createDOM();
    _setDocument(doc);
    const show = signal(true);
    const App = () =>
      h(
        Transition,
        { enter: fade, exit: fade },
        show.value ? h("div", { id: "box" }, "hello") : null,
      );
    const handle = mount(root, App);
    assertEquals(root.querySelector("#box") !== null, true);

    // Trigger exit
    show.set(false);
    handle._flush();

    // Element should still be in DOM (deferred removal for exit animation)
    assertEquals(root.querySelector("#box") !== null, true);

    // After animation duration (300ms default + margin), element should be removed
    await new Promise((r) => setTimeout(r, 400));
    assertEquals(root.querySelector("#box"), null);

    _unmount(handle);
    await win.happyDOM.close();
  },
});

Deno.test({
  name: "Transition: enter animation applies css to element",
  async fn() {
    const { win, doc, root } = createDOM();
    _setDocument(doc);
    const App = () =>
      h(Transition, { enter: fade }, h("div", { id: "box" }, "hello"));
    const handle = mount(root, App);
    const box = root.querySelector("#box") as HTMLElement;
    assertEquals(box !== null, true);
    // Enter animation should have been applied via afterRender
    assertEquals(box.style.animation !== "", true);
    // Wait for enter animation timer to complete before unmount
    await new Promise((r) => setTimeout(r, 350));
    _unmount(handle);
    await win.happyDOM.close();
  },
});

Deno.test({
  name: "Transition: works without exit (immediate removal)",
  async fn() {
    const { win, doc, root } = createDOM();
    _setDocument(doc);
    const show = signal(true);
    const App = () =>
      h(
        Transition,
        { enter: fade },
        show.value ? h("div", { id: "box" }, "hello") : null,
      );
    const handle = mount(root, App);
    assertEquals(root.querySelector("#box") !== null, true);

    show.set(false);
    handle._flush();
    // No exit transition — should be removed immediately
    assertEquals(root.querySelector("#box"), null);

    // Wait for enter animation timer to complete before unmount
    await new Promise((r) => setTimeout(r, 350));
    _unmount(handle);
    await win.happyDOM.close();
  },
});
