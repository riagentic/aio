// The reconciler itself is in good shape (see renderer-differential.test.ts).
// Every defect a randomized hunt found was at a BOUNDARY — hydration, the
// JSX-name→attribute-name map, the namespace switch, the two spellings of
// `class`. Each of those is a "one fact with more than one home" shape, and
// each failed SILENTLY. This file pins all four.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { h, renderToString, setDevMode, type VNode } from "../src/air/vdom.ts";
import { _setDocument, hydrate, mount } from "../src/air/aio-renderer.ts";

const SVG_NS = "http://www.w3.org/2000/svg";
const HTML_NS = "http://www.w3.org/1999/xhtml";

function env() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  return { win, doc, cleanup: () => win.happyDOM.close() };
}

function host(doc: Document) {
  const el = doc.createElement("main");
  doc.body.appendChild(el);
  return el;
}

function devWarnings(fn: () => void): string[] {
  const out: string[] = [];
  const orig = console.warn;
  setDevMode(false);
  setDevMode(true);
  console.warn = (...a: unknown[]) => {
    const line = a.map(String).join(" ");
    if (line.startsWith("[aio-dev]")) out.push(line);
    else orig(...a);
  };
  try {
    fn();
  } finally {
    console.warn = orig;
    setDevMode(false);
  }
  return out;
}

// ── hydrate: an attribute the component does NOT describe ──────────────
//
// `_hydrateProps` re-applies the props the component HAS, so a divergence in
// one of them is repaired. The other half — an attribute present in the server
// markup and in no prop — was kept FOREVER: never rewritten, never warned
// about, and invisible to every later diff (which compares new props against
// old props, and it is in neither). A `disabled` in the markup left the button
// permanently dead; a `hidden` left it permanently invisible.
Deno.test("hydrate: a server-only attribute is removed, not kept forever", () => {
  const { doc, cleanup } = env();
  try {
    const App = () => h("button", { type: "button" }, "Save") as VNode;
    const h1 = host(doc);
    h1.innerHTML =
      `<button type="button" disabled="" hidden="" class="server">Save</button>`;
    const warns = devWarnings(() => hydrate(h1, App));

    const btn = h1.firstElementChild as HTMLButtonElement;
    assertEquals(btn.getAttribute("disabled"), null);
    assertEquals(btn.getAttribute("hidden"), null);
    assertEquals(btn.getAttribute("class"), null);

    // hydrate converges on exactly what mount produces.
    const h2 = host(doc);
    mount(h2, App);
    const strip = (s: string) => s.replace(/ data-component="[^"]*"/, "");
    assertEquals(strip(btn.outerHTML), strip(h2.innerHTML));

    // and it is LOUD about it in dev.
    assert(
      warns.some((w) => w.includes("disagrees with the component")),
      `expected a hydrate divergence warning, got ${JSON.stringify(warns)}`,
    );
  } finally {
    cleanup();
  }
});

Deno.test("hydrate: attributes the component DOES describe survive", () => {
  const { doc, cleanup } = env();
  try {
    const App = () =>
      h("input", {
        type: "checkbox",
        id: "a",
        "data-x": "1",
        "aria-label": "al",
        checked: true,
        value: "v",
        readOnly: true,
      }) as VNode;
    const h1 = host(doc);
    h1.innerHTML = renderToString(h(App, null));
    hydrate(h1, App);
    const el = h1.firstElementChild as HTMLInputElement;
    for (
      const a of ["type", "id", "data-x", "aria-label", "checked", "readonly"]
    ) {
      assert(el.hasAttribute(a), `${a} was dropped: ${el.outerHTML}`);
    }
  } finally {
    cleanup();
  }
});

// ── htmlFor → for ──────────────────────────────────────────────────────
//
// `htmlFor` is not a `_DOM_PROPS` entry, so it fell through to
// `setAttribute("htmlFor")` on the client and was emitted verbatim by SSR:
// `htmlfor=` and `htmlFor=`, two spellings of an attribute no browser reads.
// Every label/control association was silently dead — and aio's own a11y
// warning recommends the shape.
Deno.test("htmlFor renders as for= on both paths", () => {
  const { doc, cleanup } = env();
  try {
    const App = () => h("label", { htmlFor: "fld" }, "Name") as VNode;
    const ssr = renderToString(h(App, null));
    assert(ssr.includes(`for="fld"`), ssr);
    assert(!ssr.toLowerCase().includes("htmlfor"), ssr);

    const h1 = host(doc);
    mount(h1, App);
    const lbl = h1.firstElementChild!;
    assertEquals(lbl.getAttribute("for"), "fld");
    assertEquals(lbl.getAttribute("htmlfor"), null);
  } finally {
    cleanup();
  }
});

// ── <foreignObject> children are HTML again ────────────────────────────
//
// The namespace mode was STICKY: once inside <svg> it never fell back, so a
// <div> inside a <foreignObject> was built with createElementNS(SVG_NS, "div")
// — an element with no HTML box and no HTMLElement API. The one thing
// foreignObject exists for rendered nothing, in every real browser.
Deno.test("foreignObject children are created in the HTML namespace", () => {
  const { doc, cleanup } = env();
  try {
    const App = () =>
      h(
        "svg",
        { viewBox: "0 0 10 10" },
        h(
          "foreignObject",
          { width: 10, height: 10 },
          h("div", { id: "inner" }, "hi"),
        ),
      ) as VNode;
    const h1 = host(doc);
    mount(h1, App);
    const svg = h1.firstElementChild!;
    assertEquals(svg.namespaceURI, SVG_NS);
    const fo = svg.firstElementChild!;
    assertEquals(fo.namespaceURI, SVG_NS, "foreignObject itself stays SVG");
    assertEquals(fo.firstElementChild!.namespaceURI, HTML_NS);
  } finally {
    cleanup();
  }
});

Deno.test("plain SVG children still inherit the SVG namespace", () => {
  const { doc, cleanup } = env();
  try {
    const App = () => h("svg", {}, h("g", {}, h("circle", { r: 1 }))) as VNode;
    const h1 = host(doc);
    mount(h1, App);
    const circle = h1.firstElementChild!.firstElementChild!.firstElementChild!;
    assertEquals(circle.namespaceURI, SVG_NS);
  } finally {
    cleanup();
  }
});

// ── class + className are ONE fact ─────────────────────────────────────
//
// `_writeProp` is last-write-wins; the SSR writer appended BOTH — invalid HTML
// whose parser keeps the FIRST, so SSR and mount picked OPPOSITE classes for
// the same vnode, with nothing said about it.
Deno.test("class and className: SSR and mount agree, dev names the collision", () => {
  const { doc, cleanup } = env();
  try {
    for (
      const props of [
        { class: "A", className: "B" },
        { className: "B", class: "A" },
      ]
    ) {
      const App = () => h("div", { ...props }, "x") as VNode;
      const h1 = host(doc);
      const warns = devWarnings(() => mount(h1, App));
      // `data-component` is stamped by the CLIENT in explicit dev mode; SSR
      // never writes it (see renderer-rerender.ts afterSubtree).
      const mounted = (h1.firstElementChild as HTMLElement).outerHTML
        .replace(/ data-component="[^"]*"/, "");
      const ssr = renderToString(h(App, null));
      assertEquals(
        ssr,
        mounted,
        `SSR/mount disagree for ${JSON.stringify(props)}`,
      );
      assertEquals(
        (ssr.match(/class=/g) ?? []).length,
        1,
        `duplicate class attribute: ${ssr}`,
      );
      assert(
        warns.some((w) => w.includes("BOTH `class` and `className`")),
        `expected the dual-class warning, got ${JSON.stringify(warns)}`,
      );
    }
  } finally {
    cleanup();
  }
});
