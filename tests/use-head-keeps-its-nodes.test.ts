// `useHead` leaves a tag that is already right where it is — the SAME node.
//
// Every apply removed every `data-aio-head` tag and appended fresh copies, and
// the owner's body-level cleanup ran it before EVERY re-render too. So any
// re-render of a component that calls `useHead` (a keystroke into its own
// `useLocal`, a cell patch it reads) removed and re-inserted each head tag —
// a `<link rel="stylesheet">` drops its styles until the re-inserted copy
// loads (a flash of unstyled page), an icon link re-fetches — and hydrate
// replaced the server's own tags the same way on first load.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { type ComponentFn, h, renderToString } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  hydrate,
  mount,
} from "../src/air/aio-renderer.ts";
import { _resetHead, collectHead, useHead } from "../src/air/head.ts";
import { signal } from "../src/state/signal.ts";

const HEAD = {
  title: "T",
  link: [{ rel: "stylesheet", href: "/fonts.css" }],
  meta: [{ name: "description", content: "d" }],
};

async function withDoc(body: (doc: Document, win: Window) => Promise<void>) {
  _resetHead();
  // No fetch of the fixture's stylesheet: nothing serves `localhost/fonts.css`,
  // and where the refusal is not instant (Windows) the connect attempt
  // outlives the test. Node identity is what is under test, not the load.
  const win = new Window({
    url: "http://localhost/",
    settings: { disableCSSFileLoading: true },
  });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  try {
    await body(doc, win);
  } finally {
    _setDocument(null as never);
    _resetHead();
    await closeWindow(win);
  }
}

Deno.test("useHead: a re-render leaves the head's nodes alone", async () => {
  await withDoc(async (doc, win) => {
    const n = signal(0);
    const App = () => {
      useHead(HEAD);
      return h("p", null, String(n.value));
    };
    const root = doc.createElement("div");
    doc.body.appendChild(root);
    const handle = mount(root, App as ComponentFn);
    const link = doc.head.querySelector("link");
    assert(link);
    const muts: unknown[] = [];
    // deno-lint-ignore no-explicit-any
    const mo = new (win as any).MutationObserver((m: unknown[]) =>
      muts.push(...m)
    );
    mo.observe(doc.head, { childList: true, subtree: true });
    n.set(1);
    await new Promise((r) => setTimeout(r, 10));
    assertEquals(root.textContent, "1", "the component did re-render");
    assert(doc.head.querySelector("link") === link, "same stylesheet node");
    assertEquals(muts.length, 0, "nothing in <head> was removed or re-added");
    mo.disconnect();
    _unmount(handle);
    assertEquals(doc.head.querySelectorAll("[data-aio-head]").length, 0);
  });
});

Deno.test("useHead: hydrate adopts the server's head tags", async () => {
  await withDoc(async (doc) => {
    const App = () => {
      useHead(HEAD);
      return h("p", null, "x");
    };
    const body = renderToString(h(App as ComponentFn, null));
    doc.head.innerHTML = collectHead();
    const link = doc.head.querySelector("link");
    assert(link);
    const root = doc.createElement("div");
    root.innerHTML = body;
    doc.body.appendChild(root);
    const handle = hydrate(root, App as ComponentFn);
    assert(doc.head.querySelector("link") === link, "the server's node stays");
    assertEquals(doc.head.querySelectorAll("[data-aio-head]").length, 2);
    _unmount(handle);
  });
});

Deno.test("useHead: a render that stops calling it releases its tags", async () => {
  // An early `return <NotFound/>` before the useHead call: the page's title
  // and meta described a page that is no longer shown, so they go.
  await withDoc(async (doc) => {
    doc.title = "base";
    const missing = signal(false);
    const App = () => {
      if (missing.value) return h("p", null, "404");
      useHead(HEAD);
      return h("p", null, "page");
    };
    const root = doc.createElement("div");
    doc.body.appendChild(root);
    const handle = mount(root, App as ComponentFn);
    assertEquals(doc.title, "T");
    missing.set(true);
    await new Promise((r) => setTimeout(r, 10));
    assertEquals(root.textContent, "404");
    assertEquals(doc.title, "base", "the stale title is gone");
    assertEquals(doc.head.querySelectorAll("[data-aio-head]").length, 0);
    missing.set(false);
    await new Promise((r) => setTimeout(r, 10));
    assertEquals(doc.title, "T", "and comes back with the page");
    assertEquals(doc.head.querySelectorAll("[data-aio-head]").length, 2);
    _unmount(handle);
    assertEquals(doc.title, "base");
  });
});
