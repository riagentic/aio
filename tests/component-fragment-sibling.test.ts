// Regression (AIO-411): a COMPONENT that renders a Fragment occupies as many DOM
// nodes as the fragment splats — not one. The child-diff cursor advanced by
// `_domNodeCount`, which returned a flat 1 for any component, so when such a
// component preceded a dynamic text/element sibling in an unkeyed list the cursor
// desynced: sibling nodes were lost and dynamic text was written to the wrong
// position (silent DOM corruption — the app looked alive but rendered garbage).

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

Deno.test("dynamic text after a component that renders a fragment stays correct", async () => {
  const { doc, root, cleanup } = dom();
  _setDocument(doc);
  const n = signal(1);
  const Two = () => h(Fragment, null, h("span", null, "P"), h("span", null, "Q"));
  const App = () => h("div", { id: "x" }, h(Two as never, null), `n=${n.value}`);

  const handle = mount(root, App);
  assertEquals(root.querySelector("#x")?.textContent, "PQn=1", "initial");
  assertEquals(root.querySelectorAll("#x span").length, 2, "both fragment spans present initially");

  n.set(55);
  await tick();
  await tick();
  assertEquals(
    root.querySelector("#x")?.textContent,
    "PQn=55",
    "dynamic text updates without disturbing the component's fragment nodes",
  );
  assertEquals(root.querySelectorAll("#x span").length, 2, "both fragment spans still present");

  n.set(3);
  await tick();
  await tick();
  assertEquals(root.querySelector("#x")?.textContent, "PQn=3", "second update");
  assertEquals(root.querySelectorAll("#x span").length, 2, "spans preserved after second update");

  _unmount(handle);
  await cleanup();
});
