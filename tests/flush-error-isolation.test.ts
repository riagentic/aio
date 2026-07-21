// Regression (AIO-409): an uncaught error while re-rendering ONE component must
// not freeze the other components queued in the same flush. `_rerenderComponent`
// catches a component's own render error (AIO-138), but a throw from a CHILD
// reached via `_diff` (no ErrorBoundary above it) escapes `_rerenderComponent`
// entirely. Before the fix that escaped the flush for-loop, abandoning every
// not-yet-processed instance in the batch — their `pendingRender` stayed true, so
// they froze permanently and silently (same strand class as AIO-408). The error
// itself was always visible; the collateral silent freeze of unrelated
// components was the danger.

import { assertEquals } from "jsr:@std/assert";
import { signal } from "../src/state/signal.ts";
import { h } from "../src/air/vdom.ts";
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

Deno.test("a throwing component does not strand its flush siblings", async () => {
  const { doc, root, cleanup } = dom();
  _setDocument(doc);

  const boom = signal(false);
  const pcell = signal("p0");
  const sib = signal(0);

  // Child throws when `boom` is set. It has no ErrorBoundary above, so the throw
  // propagates through the parent's re-render diff and escapes _rerenderComponent.
  const Child = () => {
    if (boom.value) throw new Error("intentional child render failure");
    return h("span", { id: "child" }, "ok");
  };
  // Parent re-renders on pcell and renders Child inline → Parent is the FIRST
  // batch item; if it strands the loop, Sibling (queued after) freezes.
  const Parent = () => {
    void pcell.value;
    return h("div", { id: "parent" }, h(Child as never, null));
  };
  const Sibling = () => h("div", { id: "sib" }, `s=${sib.value}`);

  const App = () =>
    h(
      "div",
      null,
      h("div", { key: "p" }, h(Parent as never, null)),
      h("div", { key: "s" }, h(Sibling as never, null)),
    );

  const handle = mount(root, App);
  assertEquals(root.querySelector("#child")?.textContent, "ok", "child init");
  assertEquals(root.querySelector("#sib")?.textContent, "s=0", "sib init");

  // Silence the expected console.error from the caught throw.
  const origErr = console.error;
  console.error = () => {};
  try {
    // Burst: trigger the child throw via the parent's re-render AND bump the
    // sibling — both scheduled in one flush, Parent first.
    boom.set(true);
    pcell.set("p1"); // forces Parent to re-render → diff Child → throw
    sib.set(1);
    for (let t = 0; t < 4; t++) await tick();
  } finally {
    console.error = origErr;
  }

  // The sibling MUST have updated despite the parent's throw.
  assertEquals(
    root.querySelector("#sib")?.textContent,
    "s=1",
    "sibling must update even though a sibling component threw during the same flush",
  );

  // And the sibling must stay reactive afterwards.
  sib.set(2);
  for (let t = 0; t < 4; t++) await tick();
  assertEquals(
    root.querySelector("#sib")?.textContent,
    "s=2",
    "sibling still reactive",
  );

  _unmount(handle);
  await cleanup();
});
