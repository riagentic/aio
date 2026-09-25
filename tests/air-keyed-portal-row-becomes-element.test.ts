// A keyed row that switches from a `<Portal>` to an element under the SAME key
// (`editing ? <Portal key={id}>…</Portal> : <li key={id}>…</li>` — a row that
// pops out into a dialog and back) lands where the row is written.
//
// A portal occupies no node in its parent, so the keyed diff had no position
// to hand the replacement: it was APPENDED at the parent's end — below the rows
// after it — and, the row counting as "stable", never moved back. Inside a
// Fragment the new node also landed past the fragment's own empty-region
// anchor, which then stayed on the page as a stray comment.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { Fragment, h, Portal } from "../src/air/vdom.ts";
import type { ComponentFn } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";

Deno.test("a keyed row turning from a Portal into an element keeps its place in the list", async () => {
  const win = new Window();
  try {
    const doc = win.document as unknown as Document;
    _setDocument(doc);
    const dialog = doc.createElement("aside");
    doc.body.appendChild(dialog);
    const popped = signal<string | null>("a");
    const rows = ["a", "b", "c"];
    const App = () =>
      h(
        "div",
        null,
        h(
          "ul",
          null,
          rows.map((id) =>
            popped.value === id
              ? h(Portal, { target: dialog, key: id }, `editing ${id}`)
              : h("li", { key: id }, id)
          ),
        ),
        // A fragment whose ONLY child is the keyed portal, before a sibling.
        h(
          "section",
          null,
          h(
            Fragment,
            null,
            popped.value === "a"
              ? h(Portal, { target: dialog, key: "x" }, "x")
              : h("p", { key: "x" }, "x"),
          ),
          h("footer", null),
        ),
      );
    const host = doc.createElement("div");
    doc.body.appendChild(host);
    const handle = mount(host, App as ComponentFn);
    handle._flush();
    assertEquals(host.querySelector("ul")!.innerHTML, "<li>b</li><li>c</li>");
    popped.set(null);
    handle._flush();
    assertEquals(
      host.querySelector("ul")!.innerHTML,
      "<li>a</li><li>b</li><li>c</li>",
    );
    assertEquals(
      host.querySelector("section")!.innerHTML,
      "<p>x</p><footer></footer>",
    );
    assertEquals(dialog.textContent, "");
    _unmount(handle);
  } finally {
    await closeWindow(win);
  }
});
