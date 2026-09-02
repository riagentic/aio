// Regression (AIO-413/414): reconciling unkeyed children where multi-node
// siblings (a component that renders a Fragment, a Fragment of text) and
// zero-node siblings (a Portal) are interleaved with dynamic text.
//
// Two distinct root causes, both silent DOM corruption on re-render:
//  • AIO-413 — _updateContainerDom judged a text-only Fragment "empty" (bare
//    text carries no _dom), injecting a stray <!----> anchor every re-render.
//  • AIO-414 — diffUnkeyed ignored the Fragment's region anchor and walked from
//    parent.firstChild, clobbering preceding siblings; and its cursor advanced a
//    hardcoded 1 per untracked child, skipping past the sibling after a Portal
//    (which occupies 0 DOM nodes) and duplicating it.

import { assertEquals } from "@std/assert";
import { signal } from "../src/state/signal.ts";
import {
  ErrorBoundary,
  Fragment,
  h,
  Portal,
  Suspense,
} from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { Window } from "happy-dom";

function dom() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  const portalHost = doc.createElement("div");
  doc.body.appendChild(portalHost);
  return { doc, root, portalHost, cleanup: () => win.happyDOM.close() };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const Two = () => h(Fragment, null, h("span", null, "P"), h("span", null, "Q"));

Deno.test("component-fragment + dynamic text + text-fragment reconcile correctly", async () => {
  const { doc, root, cleanup } = dom();
  _setDocument(doc);
  const n = signal(0);
  const App = () =>
    h(
      "div",
      { id: "x" },
      h(Two as never, null),
      `n=${n.value}`,
      h(Fragment, null, "a", "b"),
    );
  const handle = mount(root, App);
  assertEquals(root.querySelector("#x")?.textContent, "PQn=0ab", "initial");
  assertEquals(root.querySelectorAll("#x span").length, 2, "spans present");
  assertEquals(root.querySelectorAll("#x").length, 1);

  n.set(5);
  await tick();
  await tick();
  assertEquals(
    root.querySelector("#x")?.textContent,
    "PQn=5ab",
    "after update",
  );
  assertEquals(root.querySelectorAll("#x span").length, 2, "spans preserved");
  // no stray comment nodes injected
  const comments = [...root.querySelector("#x")!.childNodes].filter((n) =>
    n.nodeType === 8
  );
  assertEquals(comments.length, 0, "no stray comment anchors");

  _unmount(handle);
  await cleanup();
});

Deno.test("portal between fragment and trailing text does not duplicate the text", async () => {
  const { doc, root, portalHost, cleanup } = dom();
  _setDocument(doc);
  const n = signal(0);
  const App = () =>
    h(
      "div",
      { id: "x" },
      h(Two as never, null),
      `n=${n.value}`,
      h("b", null, "!"),
      h(Fragment, null, "a", "b"),
      h(Portal, { target: portalHost }, h("i", null, "p")),
      " tail",
    );
  const handle = mount(root, App);
  assertEquals(
    root.querySelector("#x")?.textContent,
    "PQn=0!ab tail",
    "initial",
  );

  n.set(5);
  await tick();
  await tick();
  assertEquals(
    root.querySelector("#x")?.textContent,
    "PQn=5!ab tail",
    "trailing text after a portal must not duplicate",
  );
  assertEquals(portalHost.textContent, "p", "portal content intact");

  _unmount(handle);
  await cleanup();
});

Deno.test("text-only fragment child grows and shrinks correctly", async () => {
  const { doc, root, cleanup } = dom();
  _setDocument(doc);
  const k = signal(1);
  const App = () =>
    h(
      "div",
      { id: "x" },
      "pre:",
      h(Fragment, null, ...Array.from({ length: k.value }, (_, i) => "x" + i)),
    );
  const handle = mount(root, App);
  assertEquals(root.querySelector("#x")?.textContent, "pre:x0", "initial");

  k.set(3);
  await tick();
  await tick();
  assertEquals(root.querySelector("#x")?.textContent, "pre:x0x1x2", "grown");

  k.set(1);
  await tick();
  await tick();
  assertEquals(root.querySelector("#x")?.textContent, "pre:x0", "shrunk");

  _unmount(handle);
  await cleanup();
});

Deno.test("multi-child ErrorBoundary beside dynamic text reconciles correctly", async () => {
  const { doc, root, cleanup } = dom();
  _setDocument(doc);
  const n = signal(0);
  const App = () =>
    h(
      "div",
      { id: "x" },
      h(
        ErrorBoundary,
        { fallback: () => h("i", null, "e") },
        h("span", null, "A"),
        h("span", null, "B"),
      ),
      `n=${n.value}`,
    );
  const handle = mount(root, App);
  assertEquals(root.querySelector("#x")?.textContent, "ABn=0", "initial");
  n.set(5);
  await tick();
  await tick();
  assertEquals(
    root.querySelector("#x")?.textContent,
    "ABn=5",
    "boundary span kept",
  );
  assertEquals(
    root.querySelectorAll("#x span").length,
    2,
    "both children present",
  );
  _unmount(handle);
  await cleanup();
});

Deno.test("multi-child Suspense beside dynamic text reconciles correctly", async () => {
  const { doc, root, cleanup } = dom();
  _setDocument(doc);
  const n = signal(0);
  const App = () =>
    h(
      "div",
      { id: "x" },
      h(
        Suspense,
        { fallback: h("i", null, "…") },
        h("span", null, "A"),
        h("span", null, "B"),
      ),
      `n=${n.value}`,
    );
  const handle = mount(root, App);
  assertEquals(root.querySelector("#x")?.textContent, "ABn=0", "initial");
  n.set(5);
  await tick();
  await tick();
  assertEquals(
    root.querySelector("#x")?.textContent,
    "ABn=5",
    "suspense span kept",
  );
  _unmount(handle);
  await cleanup();
});
