import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { signal } from "../src/signal.ts";
import { h } from "../src/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/aio-renderer.ts";
import { TransitionGroup } from "../src/transition-group.ts";
import { fade } from "../src/transition.ts";

const DOM_TEST_OPTS = { sanitizeOps: false, sanitizeResources: false };

function createDOM() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { win, doc, root };
}

Deno.test({
  name: "TransitionGroup: renders keyed children",
  ...DOM_TEST_OPTS,
  fn() {
    const { win, doc, root } = createDOM();
    _setDocument(doc);
    const items = signal(["a", "b", "c"]);
    const App = () =>
      h(
        TransitionGroup,
        { enter: fade, exit: fade },
        ...items.value.map((id) => h("div", { key: id, id }, id)),
      );
    const handle = mount(root, App);
    // Should render all 3 items inside wrapper span
    const wrapper = root.querySelector("span");
    assertEquals(wrapper !== null, true);
    assertEquals(wrapper!.querySelectorAll("div").length, 3);
    _unmount(handle);
    win.close();
  },
});

Deno.test({
  name: "TransitionGroup: new items get enter animation",
  ...DOM_TEST_OPTS,
  fn() {
    const { win, doc, root } = createDOM();
    _setDocument(doc);
    const items = signal(["a", "b"]);
    const App = () =>
      h(
        TransitionGroup,
        { enter: fade, exit: fade },
        ...items.value.map((id) => h("div", { key: id, id }, id)),
      );
    const handle = mount(root, App);
    assertEquals(root.querySelectorAll("div").length, 2);

    // Add item
    items.set(["a", "b", "c"]);
    handle._flush();
    assertEquals(root.querySelectorAll("div").length, 3);

    // New item "c" should have enter animation
    const c = root.querySelector("#c") as HTMLElement;
    assertEquals(c !== null, true);
    assertEquals(c.style.animation !== "", true);

    _unmount(handle);
    win.close();
  },
});

Deno.test({
  name: "TransitionGroup: removed items have deferred exit",
  ...DOM_TEST_OPTS,
  async fn() {
    const { win, doc, root } = createDOM();
    _setDocument(doc);
    const items = signal(["a", "b", "c"]);
    const App = () =>
      h(
        TransitionGroup,
        { enter: fade, exit: fade },
        ...items.value.map((id) => h("div", { key: id, id }, id)),
      );
    const handle = mount(root, App);
    assertEquals(root.querySelectorAll("div").length, 3);

    // Remove middle item
    items.set(["a", "c"]);
    handle._flush();

    // "b" should still be in DOM (exit animation in progress)
    assertEquals(root.querySelector("#b") !== null, true);

    // After animation duration
    await new Promise((r) => setTimeout(r, 400));
    assertEquals(root.querySelector("#b"), null);

    _unmount(handle);
    win.close();
  },
});

Deno.test({
  name: "TransitionGroup: reorder preserves all items",
  ...DOM_TEST_OPTS,
  fn() {
    const { win, doc, root } = createDOM();
    _setDocument(doc);
    const items = signal(["a", "b", "c"]);
    const App = () =>
      h(
        TransitionGroup,
        { enter: fade, exit: fade },
        ...items.value.map((id) => h("div", { key: id, id }, id)),
      );
    const handle = mount(root, App);

    // Reorder
    items.set(["c", "a", "b"]);
    handle._flush();

    // All items still present
    assertEquals(root.querySelectorAll("div").length, 3);
    assertEquals(root.querySelector("#a") !== null, true);
    assertEquals(root.querySelector("#b") !== null, true);
    assertEquals(root.querySelector("#c") !== null, true);

    _unmount(handle);
    win.close();
  },
});

Deno.test({
  name: "TransitionGroup: works with empty list",
  ...DOM_TEST_OPTS,
  fn() {
    const { win, doc, root } = createDOM();
    _setDocument(doc);
    const items = signal<string[]>([]);
    const App = () =>
      h(
        TransitionGroup,
        { enter: fade, exit: fade },
        ...items.value.map((id) => h("div", { key: id, id }, id)),
      );
    const handle = mount(root, App);
    assertEquals(root.querySelectorAll("div").length, 0);
    _unmount(handle);
    win.close();
  },
});
