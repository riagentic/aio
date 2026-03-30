import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { h } from "../src/vdom.ts";
import { _setDocument, mount } from "../src/aio-renderer.ts";
import { signal } from "../src/signal.ts";

const S = { sanitizeOps: false, sanitizeResources: false } as const;

function setup() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { win, doc, root, cleanup: () => win.close() };
}

Deno.test({
  name: "signal binding: signal prop updates DOM directly",
  ...S,
  fn() {
    const { root, cleanup } = setup();
    const cls = signal("red");

    const App = () => h("div", { className: cls, id: "target" }, "hello");
    const handle = mount(root, App);

    const el = root.querySelector("#target") as HTMLElement;
    assertEquals(el.getAttribute("class"), "red");

    cls.set("blue");
    handle._flush();
    assertEquals(el.getAttribute("class"), "blue");
    cleanup();
  },
});

Deno.test({
  name: "signal binding: multiple signal props on same element",
  ...S,
  fn() {
    const { root, cleanup } = setup();
    const cls = signal("a");
    const title = signal("t1");

    const App = () =>
      h("div", { className: cls, title: title, id: "target" }, "hello");
    const handle = mount(root, App);

    const el = root.querySelector("#target") as HTMLElement;
    assertEquals(el.getAttribute("class"), "a");
    assertEquals(el.getAttribute("title"), "t1");

    cls.set("b");
    handle._flush();
    assertEquals(el.getAttribute("class"), "b");

    title.set("t2");
    handle._flush();
    assertEquals(el.getAttribute("title"), "t2");
    cleanup();
  },
});

Deno.test({
  name: "signal binding: style object with signal values",
  ...S,
  fn() {
    const { root, cleanup } = setup();
    const color = signal("red");

    const App = () =>
      h("div", { style: { color: color }, id: "target" }, "hello");
    const handle = mount(root, App);

    const el = root.querySelector("#target") as HTMLElement;
    assertEquals(el.style.color, "red");

    color.set("blue");
    handle._flush();
    assertEquals(el.style.color, "blue");
    cleanup();
  },
});

Deno.test({
  name: "signal binding: re-bind cleans old signal effects",
  ...S,
  fn() {
    const { root, cleanup } = setup();
    const sigA = signal("a");
    const sigB = signal("b");
    const which = signal(true);

    // Component switches which signal is bound to the title prop
    const App = () =>
      h("div", { title: which.value ? sigA : sigB, id: "target" }, "hello");

    const handle = mount(root, App);
    const el = root.querySelector("#target") as HTMLElement;
    assertEquals(el.getAttribute("title"), "a");

    // Switch to sigB
    which.set(false);
    handle._flush();
    assertEquals(el.getAttribute("title"), "b");

    // Old signal (sigA) should NOT update the DOM anymore
    sigA.set("stale");
    handle._flush();
    assertEquals(el.getAttribute("title"), "b"); // still b, not stale

    // New signal (sigB) should update
    sigB.set("updated");
    handle._flush();
    assertEquals(el.getAttribute("title"), "updated");
    cleanup();
  },
});

Deno.test({
  name: "signal binding: cleans up effects on unmount",
  ...S,
  fn() {
    const { root, cleanup } = setup();
    const cls = signal("red");
    const show = signal(true);

    const Child = () => h("div", { className: cls, id: "child" }, "child");
    const App = () => show.value ? h(Child, null) : h("span", null, "gone");

    const handle = mount(root, App);
    assertEquals(root.querySelector("#child") !== null, true);
    const subsBefore = cls._subscribers.size;

    show.set(false);
    handle._flush();
    assertEquals(root.querySelector("#child"), null);
    assertEquals(cls._subscribers.size < subsBefore, true);
    cleanup();
  },
});
