// Inside <textarea>/<title>/<script>/<style> the HTML parser reads content as
// TEXT, so the `<!---->` SSR holds a null slot or an empty region with is not a
// comment there: `<textarea>{null}</textarea>` opened showing `<!---->`, and
// hydrating it met a text node where it wanted a comment — a mismatch that
// threw the whole server page away. The server writes no marker there; the
// hydrator makes the slot itself.
import { assertEquals, assertStrictEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { Fragment, h, renderToString } from "../src/air/vdom.ts";
import type { VNode } from "../src/air/vdom.ts";
import { renderToStream } from "../src/air/ssr-stream.ts";
import { _setDocument, _unmount, setDevMode } from "../src/air/aio-renderer.ts";
import { hydrate } from "../src/air/renderer-hydrate.ts";
import { signal } from "../src/state/signal.ts";

async function streamed(v: VNode): Promise<string> {
  let s = "";
  for await (const c of renderToStream(v)) s += c;
  return s;
}

Deno.test("SSR: no slot marker inside a text-content element; elsewhere it stays", async () => {
  const Nothing = () => null;
  const cases: [VNode, string][] = [
    [h("textarea", null, null), "<textarea></textarea>"],
    [h("textarea", null, "a", false, "b"), "<textarea>ab</textarea>"],
    [h("textarea", null, h(Fragment, null)), "<textarea></textarea>"],
    [h("title", null, "t", null), "<title>t</title>"],
    [h("title", null, h(Nothing, null)), "<title></title>"],
    [h("style", null, null), "<style></style>"],
    [h("script", null, "x()", null), "<script>x()</script>"],
    [h("p", null, null), "<p><!----></p>"],
  ];
  for (const [v, want] of cases) {
    assertEquals(renderToString(v), want);
    assertEquals(await streamed(v), want);
  }
  // Raw text that happens to spell a marker is the app's text — kept.
  assertEquals(
    renderToString(h("script", null, "/*<!---->*/")),
    "<script>/*<!---->*/</script>",
  );
});

Deno.test("hydrate: a null slot inside a browser-parsed <textarea> is made, not a mismatch", async () => {
  const win = new Window({ url: "http://localhost/" });
  const doc = win.document as unknown as Document;
  _setDocument(doc as never);
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  // What a browser builds from `<textarea>ab</textarea>`: ONE text node.
  const ta = doc.createElement("textarea");
  ta.setAttribute("aria-label", "a");
  ta.appendChild(doc.createTextNode("ab"));
  host.appendChild(ta);
  const empty = doc.createElement("textarea");
  empty.setAttribute("aria-label", "b");
  host.appendChild(empty);
  const show = signal(false);
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(" "));
  setDevMode(true);
  const App = () =>
    h(
      Fragment,
      null,
      h("textarea", { "aria-label": "a" }, "a", show.value && "x", "b"),
      h("textarea", { "aria-label": "b" }, null),
    );
  const hh = hydrate(host, App);
  hh._flush();
  try {
    assertEquals(warns.filter((w) => w.includes("hydrate")), []);
    assertStrictEquals(host.firstChild, ta, "the server's textarea kept");
    assertEquals(ta.textContent, "ab");
    assertStrictEquals(host.lastChild, empty);
    assertEquals(empty.textContent, "");
    show.set(true);
    hh._flush();
    assertEquals(ta.textContent, "axb");
  } finally {
    console.warn = origWarn;
    setDevMode(false);
    _unmount(hh);
    await closeWindow(win);
  }
});

Deno.test("hydrate: an empty region inside a <textarea> is made there too, and the text after it is kept", async () => {
  // `<textarea>a{<></>}b</textarea>`: the server wrote "ab" and no anchor.
  // The region's anchor dropped the split-off "b" as stale server text, so
  // "b" missed and the whole server page was thrown away.
  const items = signal<string[]>([]);
  const App = () =>
    h(
      "textarea",
      { "aria-label": "t" },
      "a",
      h(Fragment, null, ...items.value),
      "b",
    );
  const win = new Window({ url: "http://localhost/" });
  const doc = win.document as unknown as Document;
  _setDocument(doc as never);
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  host.innerHTML = renderToString(h(App, null));
  const ta = host.firstChild;
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(" "));
  setDevMode(true);
  const hh = hydrate(host, App);
  hh._flush();
  try {
    assertEquals(warns.filter((w) => w.includes("hydrate")), []);
    assertStrictEquals(host.firstChild, ta, "the server's textarea kept");
    assertEquals(ta!.textContent, "ab");
    items.set(["x", "y"]);
    hh._flush();
    assertEquals(ta!.textContent, "axyb");
  } finally {
    console.warn = origWarn;
    setDevMode(false);
    _unmount(hh);
    await closeWindow(win);
  }
});
