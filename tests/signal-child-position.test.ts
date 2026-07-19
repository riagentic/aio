// Regression (AIO-410): a Signal passed directly as a child binds to a text node
// located by walking the realized DOM, NOT by its array index. A multi-DOM-node
// sibling — a Fragment splats several nodes — makes the child's array index
// differ from its DOM index. The old `el.childNodes[idx]` lookup then landed on a
// non-text node; the nodeType guard skipped the bind entirely and the signal
// child silently never updated (frozen with no error — the worst failure mode).

import { assertEquals } from "jsr:@std/assert";
import { signal } from "../src/state/signal.ts";
import { Fragment, h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { Window } from "happy-dom";

function dom() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { doc, root, cleanup: () => win.happyDOM.close() };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

Deno.test("signal child after a fragment sibling stays reactive", async () => {
  const { doc, root, cleanup } = dom();
  _setDocument(doc);
  const count = signal(1);
  // Fragment (2 nodes) precedes a raw signal child under one element.
  const App = () =>
    h(
      "div",
      { id: "x" },
      h(Fragment, null, h("span", null, "A"), h("span", null, "B")),
      count as never,
    );
  const handle = mount(root, App);
  assertEquals(root.querySelector("#x")?.textContent, "AB1", "initial");

  count.set(999);
  await tick();
  assertEquals(root.querySelector("#x")?.textContent, "AB999", "signal must reflect");

  count.set(7);
  await tick();
  assertEquals(root.querySelector("#x")?.textContent, "AB7", "second update");

  _unmount(handle);
  await cleanup();
});

Deno.test("signal child between fragment and trailing text stays reactive", async () => {
  const { doc, root, cleanup } = dom();
  _setDocument(doc);
  const n = signal(0);
  const App = () =>
    h(
      "div",
      { id: "y" },
      h(Fragment, null, h("i", null, "x"), h("i", null, "y")),
      n as never,
      " end",
    );
  const handle = mount(root, App);
  assertEquals(root.querySelector("#y")?.textContent, "xy0 end", "initial");
  n.set(42);
  await tick();
  assertEquals(root.querySelector("#y")?.textContent, "xy42 end", "middle signal updates");
  _unmount(handle);
  await cleanup();
});

Deno.test("plain signal child (no multi-node siblings) still works", async () => {
  const { doc, root, cleanup } = dom();
  _setDocument(doc);
  const c = signal(3);
  const App = () => h("span", { id: "z" }, "n=", c as never);
  const handle = mount(root, App);
  assertEquals(root.querySelector("#z")?.textContent, "n=3", "initial");
  c.set(9);
  await tick();
  assertEquals(root.querySelector("#z")?.textContent, "n=9", "updates");
  _unmount(handle);
  await cleanup();
});
