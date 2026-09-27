// SSR must refuse a tag name the DOM refuses — the same rule prop-write.ts
// applies to attribute NAMES ("the server must not be the permissive one").
// `renderToString`/`renderToStream` pasted `vnode.tag` into `<${tag}` raw, so
// a tag computed from content (`h(`h${level}`)`, a CMS-chosen element) was
// script injection on the server while `createElement` threw on the client.
// `_assertTagName` (prop-write.ts) is now called by all three SSR writers AND
// `createDom`, so both sides fail with the same aio error naming the tag — and
// every real tag shape (custom elements, SVG camelCase) still renders.
import { assert, assertStringIncludes, assertThrows } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h, renderToString } from "../src/air/vdom.ts";
import { renderToStream } from "../src/air/ssr-stream.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";

const EVIL = "img src=x onerror=alert(1)";

// Baseline (not asserted here — happy-dom is lenient): every real browser's
// document.createElement(EVIL) throws InvalidCharacterError, so the CLIENT
// never builds this element; only the server wrote it, as live markup.

Deno.test("renderToString refuses a tag name the DOM refuses (no raw markup injection)", () => {
  // A heading level from content: h(`h${level}`) with level = "1 onmouseover=…"
  let html = "";
  try {
    html = renderToString(h(EVIL, null, "x"));
  } catch (e) {
    assertStringIncludes(String(e), JSON.stringify(EVIL));
    return; // refused — correct
  }
  throw new Error(`renderToString emitted raw markup: ${html}`);
});

Deno.test("renderToStream refuses a tag name the DOM refuses", async () => {
  let html = "";
  try {
    // aio-ok: the catch is the assertion; finishing the loop is the failure
    for await (const chunk of renderToStream(h(EVIL, null, "x"))) html += chunk;
  } catch (e) {
    assertStringIncludes(String(e), JSON.stringify(EVIL));
    return;
  }
  throw new Error(`renderToStream emitted raw markup: ${html}`);
});

Deno.test("renderToStream refuses a bad tag nested below the root (element path)", async () => {
  let html = "";
  try {
    const tree = h("div", null, h("section", null, h("h1 onclick=x", null)));
    // aio-ok: the catch is the assertion; finishing the loop is the failure
    for await (const chunk of renderToStream(tree)) html += chunk;
  } catch (e) {
    assertStringIncludes(String(e), "not a legal element name");
    return;
  }
  throw new Error(`renderToStream emitted raw markup: ${html}`);
});

Deno.test("mount refuses the same tag with the same aio error (client == server)", async () => {
  const win = new Window({ url: "http://localhost/" });
  // deno-lint-ignore no-explicit-any
  const doc = win.document as any;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  try {
    let handle: ReturnType<typeof mount> | undefined;
    const err = assertThrows(() => {
      handle = mount(root, (() => h(EVIL, null, "x")) as never);
    });
    if (handle) _unmount(handle);
    assertStringIncludes(String(err), "not a legal element name");
    assert(!root.innerHTML.includes("onerror"), root.innerHTML);
  } finally {
    _setDocument(null as never);
    await closeWindow(win);
  }
});

Deno.test("every real tag shape still renders: custom elements, SVG camelCase, prefixed", () => {
  const html = renderToString(
    h("div", null, [
      h("my-el", null, "a"),
      h("x-foo.bar_baz", null),
      h("svg", null, [
        h("defs", null, h("linearGradient", { id: "g" })),
        h("foreignObject", null, h("div", null, "b")),
        h("clipPath", null),
      ]),
      h("svg:rect", null),
    ]),
  );
  for (
    const t of [
      "<my-el",
      "<x-foo.bar_baz",
      "<linearGradient",
      "<foreignObject",
      "<clipPath",
      "<svg:rect",
    ]
  ) assertStringIncludes(html, t);
});
