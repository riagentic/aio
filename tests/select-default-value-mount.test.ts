// `<select defaultValue="b">` on the CLIENT.
//
// `HTMLSelectElement` has no `defaultValue` property, so the generic prop
// write put a dead `defaultvalue="b"` attribute on the select and the FIRST
// option stayed chosen — while both SSR writers mark `<option selected>` for
// it. A mounted page (every aio app's first paint) and a server-rendered one
// showed different choices, and the dev "typed-kept" hint names `defaultValue`
// as the fix. It is the starting choice: written once, not re-asserted.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { type ComponentFn, h, renderToString } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  hydrate,
  mount,
} from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";

const opts = (...vs: string[]) =>
  vs.map((v) => h("option", { value: v }, v.toUpperCase()));

async function withDoc(body: (doc: Document) => void | Promise<void>) {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  try {
    await body(doc);
  } finally {
    await closeWindow(win);
  }
}

const picked = (s: HTMLSelectElement) =>
  Array.from(s.options).filter((o) => o.selected).map((o) => o.value);

Deno.test("mount: <select defaultValue> starts on that option, as SSR does", () =>
  withDoc((doc) => {
    const App = (() =>
      h(
        "select",
        { defaultValue: "b", "aria-label": "x" },
        ...opts("a", "b", "c"),
      )) as unknown as ComponentFn;
    const host = doc.createElement("main");
    doc.body.append(host);
    const m = mount(host, App);
    const sel = host.querySelector("select")!;
    assertEquals(picked(sel), ["b"]);
    assertEquals(sel.hasAttribute("defaultvalue"), false, "no dead attribute");
    // Same document as the server's.
    const server = doc.createElement("main");
    server.innerHTML = renderToString(h(App, null));
    assertEquals(host.innerHTML, server.innerHTML);
    _unmount(m);
  }));

Deno.test("mount: <select multiple defaultValue={[…]}> starts on each", () =>
  withDoc((doc) => {
    const App = (() =>
      h(
        "select",
        { multiple: true, defaultValue: ["a", "c"], "aria-label": "x" },
        ...opts("a", "b", "c"),
      )) as unknown as ComponentFn;
    const host = doc.createElement("main");
    const m = mount(host, App);
    assertEquals(picked(host.querySelector("select")!), ["a", "c"]);
    _unmount(m);
  }));

Deno.test("defaultValue is the START: a re-render does not undo the user's pick", async () =>
  await withDoc(async (doc) => {
    const n = signal(0);
    const App = (() =>
      h(
        "div",
        null,
        h("span", null, String(n.value)),
        h(
          "select",
          { defaultValue: "b", "aria-label": "x" },
          ...opts("a", "b", "c"),
        ),
      )) as unknown as ComponentFn;
    const host = doc.createElement("main");
    doc.body.append(host);
    const m = mount(host, App);
    const sel = host.querySelector("select")!;
    sel.value = "c";
    n.set(1);
    await new Promise((r) => setTimeout(r, 0));
    assertEquals(host.querySelector("span")!.textContent, "1");
    assertEquals(sel.value, "c");
    _unmount(m);
  }));

Deno.test("hydrate: a server <select defaultValue> stays as the server chose", () =>
  withDoc((doc) => {
    const App = (() =>
      h(
        "select",
        { defaultValue: "c", "aria-label": "x" },
        ...opts("a", "b", "c"),
      )) as unknown as ComponentFn;
    const host = doc.createElement("main");
    doc.body.append(host);
    host.innerHTML = renderToString(h(App, null));
    const before = host.innerHTML;
    const m = hydrate(host, App);
    assertEquals(host.innerHTML, before);
    // (Read off the markup: happy-dom's parser selects the wrong option for
    // `<option selected>` markup, which no browser does.)
    const marked = Array.from(host.querySelectorAll("option[selected]"));
    assertEquals(marked.map((o) => o.getAttribute("value")), ["c"]);
    _unmount(m);
  }));
