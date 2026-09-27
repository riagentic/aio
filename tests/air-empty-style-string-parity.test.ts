// prop-write.ts (AIO-170) removes the `style` ATTRIBUTE for a null/false style
// "rather than blanking cssText: `cssText = ""` MATERIALIZES an empty
// `style=""` on an element that never had one … where SSR (which emits
// nothing …) built a bare `<div>`. Same vnode, two documents, and hydration
// reported it as a server/client divergence."
//
// The STRING branch one line above still does `el.style.cssText = v`, so the
// ordinary `style={active ? "color:red" : ""}` hits exactly that: SSR emits no
// attribute for "" (`if (v)` in `_renderPropsHtml`), mount/hydrate build
// `style=""`, and hydrate fires its divergence warning on correct code.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h, renderToString } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  hydrate,
  mount,
  setDevMode,
} from "../src/air/aio-renderer.ts";

const App = () => h("p", { style: "" }, "x");

Deno.test('style="": renderToString and mount build the same document', async () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  try {
    const host = doc.createElement("main");
    doc.body.appendChild(host);
    const handle = mount(host, App);
    const mounted = host.innerHTML;
    _unmount(handle);
    assertEquals(renderToString(h(App, null)), "<p>x</p>");
    assertEquals(
      mounted,
      "<p>x</p>",
      "mount materialized an empty style attribute",
    );
  } finally {
    await closeWindow(win);
  }
});

Deno.test('style="": hydrate reports no server/client divergence for identical props', async () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  setDevMode(true);
  const warns: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(" "));
  try {
    const host = doc.createElement("main");
    doc.body.appendChild(host);
    host.innerHTML = renderToString(h(App, null));
    const handle = hydrate(host, App);
    _unmount(handle);
    assertEquals(
      warns.filter((w) => w.includes("hydrate()")),
      [],
      "the same vnode on both sides was reported as a divergence on `style`",
    );
  } finally {
    console.warn = warn;
    setDevMode("auto");
    await closeWindow(win);
  }
});
