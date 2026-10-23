// A `<Portal>` is not in the server's markup (renderToString skips it), so its
// content's `useId()`s were never handed out by the server — but hydration drew
// them from the server's sequence anyway. A portal ahead of any other id in
// tree order took the page's `:r0:`, every later id moved up one (`:r1:` on a
// node the server wrote as `:r0:`), and dev blamed correct code for "server
// markup that disagrees … (Date/random/window in render)". Found by the
// SSR/hydrate/mount differential once portals joined its alphabet.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import {
  type ComponentFn,
  ErrorBoundary,
  h,
  Portal,
  renderToString,
} from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  hydrate,
  useId,
} from "../src/air/aio-renderer.ts";

const Boom = (() => {
  throw new Error("boom");
}) as unknown as ComponentFn;
const Id = (() => {
  const id = useId();
  return h("var", { title: id }, id);
}) as unknown as ComponentFn;

Deno.test("hydrate: a portal's useId() does not take the server's ids", async () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const said: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void said.push(a.join(" "));
  const g = globalThis as Record<string, unknown>;
  const dev = g.__aioDev;
  g.__aioDev = true;
  try {
    const target = doc.createElement("aside");
    doc.body.appendChild(target);
    let t: Element | null = null; // the server has no target
    const App = (() =>
      h(
        "div",
        null,
        h(Portal, { target: t }, h(Id, null)),
        h(Id, null),
      )) as unknown as ComponentFn;
    const ssr = renderToString(h(App, null));
    assertEquals(ssr, `<div><var title=":r0:">:r0:</var></div>`);
    const host = doc.createElement("main");
    doc.body.appendChild(host);
    host.innerHTML = ssr;
    t = target;
    const hh = hydrate(host, App);
    assertEquals(host.innerHTML, ssr, "the server's ids stay as written");
    const inPortal = target.querySelector("var")!.getAttribute("title")!;
    assertEquals(/^:rc\d+:$/.test(inPortal), true, inPortal);
    assertEquals(said.filter((s) => s.includes("hydrate()")), []);
    _unmount(hh);
  } finally {
    console.warn = warn;
    g.__aioDev = dev;
    await closeWindow(win);
  }
});

// The same portal behind an ErrorBoundary whose SERVER render fell back: its
// children are hydrated as an attempt that misses on the fallback's markup and
// BUILDS the rest (`createDom`) — the portal included, on the same sequence.
Deno.test("hydrate: a portal in a fallen-back boundary does not take the server's ids", async () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const err = console.error;
  console.error = () => {}; // the caught render error is the input here
  try {
    const target = doc.createElement("aside");
    doc.body.appendChild(target);
    let t: Element | null = null;
    const App = (() =>
      h(
        "div",
        null,
        h(
          ErrorBoundary,
          { fallback: () => h("b", null, "fb") },
          h("span", null, "s"),
          h(Portal, { target: t }, h(Id, null)),
          h(Boom, null),
        ),
        h(Id, null),
      )) as unknown as ComponentFn;
    const ssr = renderToString(h(App, null));
    assertEquals(ssr, `<div><b>fb</b><var title=":r0:">:r0:</var></div>`);
    const host = doc.createElement("main");
    doc.body.appendChild(host);
    host.innerHTML = ssr;
    t = target;
    const hh = hydrate(host, App);
    assertEquals(host.innerHTML, ssr, "the server's ids stay as written");
    _unmount(hh);
  } finally {
    console.error = err;
    await closeWindow(win);
  }
});
