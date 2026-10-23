// Two portals into one target (a modal and a toast into `document.body`). The
// first sits in an `<ErrorBoundary>` and its content throws part way through
// its first build: nothing from the thrower on reached the target, but the
// teardown of the discarded portal walked its never-built children by
// position — and those positions were the SECOND portal's nodes. A
// never-built bare text removed the toast's `<p>`, with a dev line calling it
// an aio bug. Found by the SSR/hydrate/mount differential.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { type ComponentFn, ErrorBoundary, h, Portal } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";

const Boom = (() => {
  throw new Error("boom");
}) as unknown as ComponentFn;

Deno.test("a discarded portal does not take a sibling portal's nodes", async () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const said: string[] = [];
  const err = console.error, warn = console.warn;
  console.error = () => {}; // the caught render error is the input here
  console.warn = (...a: unknown[]) => void said.push(a.join(" "));
  try {
    const target = doc.createElement("aside");
    doc.body.appendChild(target);
    const App = (() =>
      h(
        "div",
        null,
        h(
          ErrorBoundary,
          { fallback: () => null },
          h(
            Portal,
            { target },
            h("b", null, "b"),
            h("span", null, h(Boom, null)),
            "t",
          ),
        ),
        h(Portal, { target }, h("p", null, "keep"), "k2"),
      )) as unknown as ComponentFn;
    const host = doc.createElement("main");
    doc.body.appendChild(host);
    const m = mount(host, App);
    assertEquals(target.innerHTML, "<!----><p>keep</p>k2");
    assertEquals(
      said.filter((s) => s.includes("without its DOM position")),
      [],
    );
    _unmount(m);
    assertEquals(target.innerHTML, "");
  } finally {
    console.error = err;
    console.warn = warn;
    await closeWindow(win);
  }
});
