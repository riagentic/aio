// `useHead()` must write to the document the app is MOUNTED in.
//
// It read `globalThis.document`, which every other hook in this renderer
// deliberately does not: `onGlobalKey` and `onWindowEvent` resolve the
// document from the mounted root, and their comments name Electron child
// windows and `<webview>` as the reason.
//
// Two costs. In a multi-window Electron app it retitled the WRONG window —
// measured, the app mounted in window B and `useHead({ title: "Invoice #42" })`
// set window A's title and put the meta tags in A's head. And under the
// supported `testUI(App, { document })` path there is no ambient global at
// all, so the hook RAN, returned normally, wrote nothing and warned nothing: a
// silent no-op in a framework whose first rule is "fail loud, never silent",
// and a `useHead` test written that way passed while asserting nothing.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { _resetHead, useHead } from "../src/air/head.ts";

Deno.test("useHead: writes to the mounted window, not the ambient one", async () => {
  _resetHead();
  const winA = new Window({ url: "http://localhost/" });
  const winB = new Window({ url: "http://localhost/" });
  // deno-lint-ignore no-explicit-any
  const docA = winA.document as any;
  // deno-lint-ignore no-explicit-any
  const docB = winB.document as any;
  docA.title = "the other window";
  docB.title = "the app's window";

  // The ambient global is window A; the app mounts into window B.
  const hadDoc = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    get: () => docA,
    configurable: true,
  });
  _setDocument(docB);
  const root = docB.createElement("div");
  docB.body.appendChild(root);

  const App = () => {
    useHead({
      title: "Invoice #42",
      meta: [{ name: "description", content: "an invoice" }],
    });
    return h("div", null, ["x"]);
  };

  const handle = mount(root, App as never);
  try {
    assertEquals(
      docB.title,
      "Invoice #42",
      "the title belongs to the window the app is mounted in",
    );
    assertEquals(
      docA.title,
      "the other window",
      "…and the OTHER window must be untouched — retitling it is what a " +
        "multi-window Electron app saw",
    );
    assertEquals(
      docB.head.querySelectorAll("[data-aio-head]").length,
      1,
      "the meta tag lands in the app's head",
    );
    assertEquals(
      docA.head.querySelectorAll("[data-aio-head]").length,
      0,
      "and not in the other one",
    );
  } finally {
    _unmount(handle);
    _setDocument(null as never);
    if (hadDoc) Object.defineProperty(globalThis, "document", hadDoc);
    else delete (globalThis as Record<string, unknown>).document;
    _resetHead();
    await closeWindow(winA);
    await closeWindow(winB);
  }
});

Deno.test("useHead: works with a BYO document and no ambient global at all", async () => {
  // The `testUI(App, { document })` shape — the one that silently did nothing.
  _resetHead();
  const win = new Window({ url: "http://localhost/" });
  // deno-lint-ignore no-explicit-any
  const doc = win.document as any;
  doc.title = "untouched";
  const hadDoc = Object.getOwnPropertyDescriptor(globalThis, "document");
  delete (globalThis as Record<string, unknown>).document;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);

  const App = () => {
    useHead({ title: "My Page" });
    return h("div", null, ["x"]);
  };
  const handle = mount(root, App as never);
  try {
    assertEquals(
      doc.title,
      "My Page",
      "a hook that runs, returns normally and writes nothing is the shape " +
        "this framework refuses everywhere else",
    );
  } finally {
    _unmount(handle);
    _setDocument(null as never);
    if (hadDoc) Object.defineProperty(globalThis, "document", hadDoc);
    _resetHead();
    await closeWindow(win);
  }
});
