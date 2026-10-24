// A hydrated TEXT that disagrees with the component is said, like an
// attribute that does.
//
// The canonical hydration mismatch — `new Date().toLocaleTimeString()`, a
// random id, a `window`-dependent string rendered on both sides — was repaired
// in silence, while the same divergence on an attribute warned ("Server and
// client rendered different props"). So the most common SSR bug there is had
// no voice at all. What the HTML parser itself rewrites (CRLF → LF) is not a
// divergence and stays quiet; so does the parser's merge of adjacent texts.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import {
  type ComponentFn,
  h,
  renderToString,
  type VChild,
} from "../src/air/vdom.ts";
import { _setDocument, _unmount, hydrate } from "../src/air/aio-renderer.ts";
import { setDevMode } from "../src/air/vdom.ts";

async function hydrateWarns(
  server: () => unknown,
  client: () => unknown,
): Promise<{ warns: string[]; html: string }> {
  const win = new Window();
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const g = globalThis as Record<string, unknown>;
  const dev = g.__aioDev;
  const warn = console.warn;
  const warns: string[] = [];
  try {
    g.__aioDev = true;
    setDevMode(false); // re-arm the once-per-id dedup
    setDevMode("auto");
    let side = server;
    const App = (() => side()) as unknown as ComponentFn;
    const host = doc.createElement("div");
    doc.body.appendChild(host);
    host.innerHTML = renderToString(h(App, null));
    side = client;
    console.warn = (...a: unknown[]) =>
      void warns.push(a.map(String).join(" "));
    const m = hydrate(host, App);
    console.warn = warn;
    const html = host.innerHTML;
    _unmount(m);
    return { warns, html };
  } finally {
    console.warn = warn;
    g.__aioDev = dev;
    setDevMode("auto");
    await closeWindow(win);
  }
}

Deno.test("hydrate: differing text is repaired AND said in dev", async () => {
  const { warns, html } = await hydrateWarns(
    () => h("p", null, "at 12:01"),
    () => h("p", null, "at 12:02"),
  );
  assertEquals(html, "<p>at 12:02</p>");
  assertEquals(warns.length, 1);
  assertEquals(warns[0]!.includes("found text in <p>"), true, warns[0]);
  assertEquals(warns[0]!.includes('"at 12:01"'), true, "names the server text");
});

Deno.test("hydrate: server text the client no longer has is said too", async () => {
  const { warns, html } = await hydrateWarns(
    () => h("p", null, "a", "b", h("i", null, "x")),
    () => h("p", null, "a", h("i", null, "x")),
  );
  assertEquals(html, "<p>a<i>x</i></p>");
  assertEquals(warns.filter((w) => w.includes("found text")).length, 1);
});

Deno.test("hydrate: what the parser rewrites, and merged texts, are not divergences", async () => {
  for (
    const kids of [["a\r\nb"], ["x", "y"], ["x", 1, "z"]] as VChild[][]
  ) {
    const same = () => h("p", null, ...kids);
    const { warns } = await hydrateWarns(same, same);
    assertEquals(warns, [], JSON.stringify(kids));
  }
});

Deno.test("hydrate: a CRLF the browser's parser turned into LF is not a divergence", async () => {
  // happy-dom keeps the CR; a browser's parser does not — so the markup is
  // put in the state a browser leaves it in.
  const win = new Window();
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const g = globalThis as Record<string, unknown>;
  const dev = g.__aioDev;
  const warn = console.warn;
  const warns: string[] = [];
  try {
    g.__aioDev = true;
    setDevMode(false);
    setDevMode("auto");
    const App = (() => h("p", null, "a\r\nb\rc")) as unknown as ComponentFn;
    const host = doc.createElement("div");
    doc.body.appendChild(host);
    host.innerHTML = renderToString(h(App, null));
    (host.firstChild!.firstChild as Text).data = "a\nb\nc";
    console.warn = (...a: unknown[]) =>
      void warns.push(a.map(String).join(" "));
    const m = hydrate(host, App);
    console.warn = warn;
    assertEquals(warns, []);
    _unmount(m);
  } finally {
    console.warn = warn;
    g.__aioDev = dev;
    setDevMode("auto");
    await closeWindow(win);
  }
});
