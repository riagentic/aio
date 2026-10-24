// `<svg tabIndex={0}>` is focusable on the client, as it is from the server.
//
// SVG attribute names are case-sensitive: the client wrote
// `setAttribute("tabIndex", "0")`, an attribute nothing reads, so an SVG icon
// button was unreachable by keyboard after mount — while the server's
// `tabIndex="0"` is lowercased by the HTML parser and works. One spelling,
// `tabindex`, on every path.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h, renderToString } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";

Deno.test("svg tabIndex: written as `tabindex` on mount, on update and by SSR", async () => {
  const win = new Window();
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  try {
    const t = signal<number | undefined>(0);
    const App = () =>
      h("div", null, h("svg", { role: "button", tabIndex: t.value }));
    const host = doc.createElement("div");
    const m = mount(host, App);
    const svg = () => host.querySelector("svg")!;
    assertEquals(svg().getAttributeNames().sort(), ["role", "tabindex"]);
    assertEquals(svg().getAttribute("tabindex"), "0");
    t.set(-1);
    m._flush?.();
    assertEquals(svg().getAttribute("tabindex"), "-1");
    t.set(undefined);
    m._flush?.();
    assertEquals(svg().getAttributeNames(), ["role"], "removed by its name");
    _unmount(m);
    assertEquals(
      renderToString(h("svg", { tabIndex: 0 })),
      '<svg tabindex="0"></svg>',
    );
  } finally {
    await closeWindow(win);
  }
});
