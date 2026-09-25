// A component INSIDE a Portal that re-renders on its own signal keeps its
// event handlers.
//
// A portal's content is wired to the portal TARGET's delegation root, because
// the mount root is not an ancestor of it. A self re-render runs inside the
// root flush, which made the MOUNT root the active delegation root — so every
// handler the re-render (re)registered (an inline arrow is a new function on
// every render) was owned by a root the click never bubbles through. A modal
// with local state answered its first click and then went dead.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h, Portal } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  mount,
  useSignal,
} from "../src/air/aio-renderer.ts";

Deno.test("a stateful component inside a Portal keeps its click handlers across self re-renders", async () => {
  const win = new Window();
  try {
    const doc = win.document as unknown as Document;
    _setDocument(doc);
    const root = doc.createElement("div");
    const target = doc.createElement("div");
    doc.body.append(root, target);
    let clicks = 0;
    const Dialog = () => {
      const n = useSignal(0);
      const bump = () => {
        clicks++;
        n.set(n.get() + 1);
      };
      // A button that exists only after the first re-render is wired by that
      // re-render alone — its handler has no registration from the mount.
      return h(
        "div",
        null,
        h("button", { id: "a", onClick: bump }, `n${n.get()}`),
        n.get() > 0 ? h("button", { id: "b", onClick: bump }, "more") : null,
      );
    };
    const handle = mount(
      root,
      () => h("main", null, h(Portal, { target }, h(Dialog, null))),
    );
    handle._flush();
    const click = (id: string) => {
      (doc.getElementById(id) as HTMLElement).click();
      handle._flush();
    };
    click("a");
    click("a");
    click("b");
    click("a");
    assertEquals(clicks, 4);
    assertEquals(doc.getElementById("a")!.textContent, "n4");
    _unmount(handle);
  } finally {
    await closeWindow(win);
  }
});
