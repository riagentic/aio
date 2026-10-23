// React's camelCase spellings of the namespaced SVG attributes — `xlinkHref`,
// `xmlLang`, `xmlSpace`, … — become the namespaced attribute on every render
// path, exactly like their `xlink:href` spelling.
//
// They type-check on any SVG element and were written VERBATIM: an attribute
// literally named `xlinkHref`, which no SVG consumer reads, so the classic
// sprite icon `<use xlinkHref="#icon-x"/>` (the spelling React code has used
// for a decade) rendered nothing, silently, on mount, SSR and update alike.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { _diff, _render, h, renderToString } from "../src/air/vdom.ts";
import { _hydrateNode } from "../src/air/renderer-hydrate.ts";

const XLINK = "http://www.w3.org/1999/xlink";
const XML = "http://www.w3.org/XML/1998/namespace";

const tree = (href: string | undefined) =>
  h(
    "svg",
    null,
    h("use", { xlinkHref: href, xlinkTitle: href && "t" }),
    h("text", { xmlLang: "en", xmlSpace: "preserve" }, "x"),
  );

Deno.test("xlinkHref / xmlLang land in their namespaces on mount, update and removal", async () => {
  const win = new Window({ url: "https://localhost" });
  try {
    const doc = win.document as unknown as Document;
    const root = doc.createElement("div");
    const ctx = { doc };
    const v1 = tree("#a");
    _render(root, v1, null, ctx as never);
    const use = root.querySelector("use")!;
    const text = root.querySelector("text")!;
    assertEquals(use.getAttributeNS(XLINK, "href"), "#a");
    assertEquals(use.getAttributeNS(XLINK, "title"), "t");
    assertEquals(use.hasAttribute("xlinkHref"), false);
    assertEquals(text.getAttributeNS(XML, "lang"), "en");
    assertEquals(text.getAttributeNS(XML, "space"), "preserve");

    const v2 = tree("#b");
    _diff(root, v2, v1, ctx as never, false);
    assertEquals(use.getAttributeNS(XLINK, "href"), "#b");

    const v3 = tree(undefined);
    _diff(root, v3, v2, ctx as never, false);
    assertEquals(use.getAttributeNS(XLINK, "href"), null);
    assertEquals(use.getAttributeNS(XLINK, "title"), null);
    assertEquals(use.attributes.length, 0);
  } finally {
    await closeWindow(win);
  }
});

Deno.test("SSR writes xlinkHref / xmlLang as xlink:href / xml:lang", () => {
  const html = renderToString(tree("#a"));
  assertEquals(
    html,
    '<svg><use xlink:href="#a" xlink:title="t"></use>' +
      '<text xml:lang="en" xml:space="preserve">x</text></svg>',
  );
});

Deno.test("hydrating server markup keeps xlinkHref in its namespace and follows updates", async () => {
  const win = new Window({ url: "https://localhost" });
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(" "));
  try {
    const doc = win.document as unknown as Document;
    const host = doc.createElement("div");
    host.innerHTML = renderToString(tree("#a"));
    const ctx = { doc };
    const v1 = tree("#a");
    assertEquals(_hydrateNode(host, v1, ctx as never, false, 0) >= 0, true);
    const use = host.querySelector("use")!;
    assertEquals(use.getAttributeNS(XLINK, "href"), "#a");
    const v2 = tree("#b");
    _diff(host, v2, v1, ctx as never, false);
    assertEquals(use.getAttributeNS(XLINK, "href"), "#b");
    assertEquals(use.attributes.length, 2);
    assertEquals(warns, []);
  } finally {
    console.warn = orig;
    await closeWindow(win);
  }
});
