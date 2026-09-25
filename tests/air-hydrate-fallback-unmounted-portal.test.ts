// A hydration mismatch never deletes content OUTSIDE the app from a portal's
// target.
//
// On a mismatch `hydrate()` tears down the whole vnode tree before rendering
// from scratch. A `<Portal>` the walk never reached was never mounted — it had
// no region anchor — and its teardown walked the target from
// `target.firstChild` as if that were its own content: a
// `<Portal target={document.body}>Saved</Portal>` removed the page's first
// body node (a site header the app does not own) as its "text".
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h, Portal, renderToString } from "../src/air/vdom.ts";
import type { ComponentFn } from "../src/air/vdom.ts";
import { _setDocument, _unmount, hydrate } from "../src/air/aio-renderer.ts";

Deno.test("hydrate mismatch fallback leaves the target's own content alone", async () => {
  const win = new Window();
  try {
    const doc = win.document as unknown as Document;
    _setDocument(doc);
    let server = true;
    const App = () =>
      h(
        "main",
        null,
        // Structural server/client difference → hydrate falls back.
        h(server ? "h1" : "h2", null, "T"),
        h(Portal, { target: doc.body }, "Saved"),
      );
    const html = renderToString(h(App, null));
    doc.body.innerHTML =
      `<header id="top">Brand</header><div id="app">${html}</div>`;
    server = false;
    const handle = hydrate(doc.getElementById("app"), App as ComponentFn);
    assertEquals(doc.getElementById("top")?.textContent, "Brand");
    assertEquals(
      doc.getElementById("app")!.innerHTML,
      "<main><h2>T</h2></main>",
    );
    assertEquals(doc.body.textContent, "BrandTSaved");
    _unmount(handle);
    assertEquals(doc.getElementById("top")?.textContent, "Brand");
    assertEquals(doc.body.textContent!.includes("Saved"), false);
  } finally {
    await closeWindow(win);
  }
});
