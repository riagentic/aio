// A `<Portal>` is skipped by SSR — its content may read `document`/`window`
// at render (fine since 1.0) and the server has no target. So a throw inside
// portal content first happens on the CLIENT, during hydration. It must be
// that boundary's alone: the nearest ErrorBoundary shows its fallback in its
// own region, and the rest of the server page is adopted as written — never
// the whole page discarded.
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
import { renderToStream } from "../src/air/ssr-stream.ts";
import { _setDocument, _unmount, hydrate } from "../src/air/aio-renderer.ts";

const streamed = async (v: unknown): Promise<string> => {
  let out = "";
  // deno-lint-ignore no-explicit-any
  for await (const c of renderToStream(v as any)) out += c;
  return out;
};

Deno.test("SSR: portal content that reads document at render is skipped, as in 1.0.24", async () => {
  const g = globalThis as Record<string, unknown>;
  const had = "document" in g;
  const ReadsDom = (() =>
    h(
      "i",
      null,
      String((g.document as Document).body),
    )) as unknown as ComponentFn;
  const App = (() =>
    h(
      "div",
      null,
      h(Portal, { target: null }, h(ReadsDom, null)),
      "here",
    )) as unknown as ComponentFn;
  assertEquals(had, false, "this test needs a DOM-less SSR");
  assertEquals(renderToString(h(App, null)), `<div>here</div>`);
  assertEquals(await streamed(h(App, null)), `<div>here</div>`);
});

Deno.test("hydrate: a throw in portal content falls back in ITS boundary only", async () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const said: string[] = [];
  const warn = console.warn, err = console.error;
  console.warn = (...a: unknown[]) => void said.push(a.join(" "));
  console.error = () => {}; // the caught render error is the input here
  const g = globalThis as Record<string, unknown>;
  const dev = g.__aioDev;
  g.__aioDev = true;
  try {
    let client = false;
    const Boom = (() => {
      if (client) throw new Error("boom in portal");
      return h("i", null, "x");
    }) as unknown as ComponentFn;
    const target = doc.createElement("aside");
    doc.body.appendChild(target);
    let t: Element | null = null;
    const App = (() =>
      h(
        "div",
        null,
        h("p", { id: "kept" }, "outside"),
        h(
          ErrorBoundary,
          { fallback: () => h("b", null, "fb") },
          h("span", null, "content"),
          h(Portal, { target: t }, h(Boom, null)),
        ),
      )) as unknown as ComponentFn;
    const ssr = renderToString(h(App, null));
    assertEquals(
      ssr,
      `<div><p id="kept">outside</p><span>content</span></div>`,
    );
    const host = doc.createElement("main");
    doc.body.appendChild(host);
    host.innerHTML = ssr;
    const kept = host.querySelector("#kept");
    client = true;
    t = target;
    const hh = hydrate(host, App);
    assertEquals(
      host.innerHTML,
      `<div><p id="kept">outside</p><b>fb</b></div>`,
    );
    assertEquals(
      host.querySelector("#kept") === kept,
      true,
      "the page was rebuilt",
    );
    _unmount(hh);
  } finally {
    console.warn = warn;
    console.error = err;
    g.__aioDev = dev;
    await closeWindow(win);
  }
});
