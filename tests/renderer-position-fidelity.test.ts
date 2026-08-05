// The reconciler must identify a child by its POSITION, never by its content.
//
// A bare string/number child is a primitive: it cannot carry a `_dom`, so for
// years the diff recovered by scanning `parent.childNodes` for a text node with
// equal content. That scan matches the FIRST equal-valued node — frequently one
// the same diff pass had just inserted — so any sibling list holding two equal
// strings (`{" "}` separators, repeated labels, equal numbers, a component that
// renders the same word as its neighbour) could silently render the wrong
// order, drop a removal, or patch a sibling's text. Nothing threw; the DOM
// simply stopped being the DOM the model described.
//
// Each case below is a shape that produced WRONG DOM with NO warning, reduced
// to its smallest form. The class as a whole is held down by
// `tests/renderer-differential.test.ts`; these pin the individual defects so a
// regression names itself instead of arriving as a fuzz seed.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { signal } from "../src/state/signal.ts";
import { Fragment, h, renderToString } from "../src/air/vdom.ts";
import { _diff, _render } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  mount,
  setDevMode,
} from "../src/air/aio-renderer.ts";
import { _hydrateNode } from "../src/air/renderer-hydrate.ts";
import { renderToStream } from "../src/air/ssr-stream.ts";

function env() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const host = doc.createElement("main");
  doc.body.appendChild(host);
  return { doc, ctx: { doc }, host, cleanup: () => win.happyDOM.close() };
}

// ── position, not content ────────────────────────────────────────────────

Deno.test("text and element siblings swap places (equal text on both sides)", () => {
  const { doc, ctx, host, cleanup } = env();
  try {
    const a = h(Fragment, null, h("div", null), "a");
    const b = h(Fragment, null, "a", h("div", null));
    _render(host, a, null, ctx);
    assertEquals(host.innerHTML, "<div></div>a");
    _diff(host, b, a, ctx);
    // The old content scan found the "a" it had just inserted, patched THAT,
    // and left the DOM byte-identical while the model had changed.
    assertEquals(host.innerHTML, "a<div></div>");
    void doc;
  } finally {
    cleanup();
  }
});

Deno.test("two identical text siblings keep their slots around an element", () => {
  const { ctx, host, cleanup } = env();
  try {
    const a = h(Fragment, null, "a", h("i", null), "a");
    const b = h(Fragment, null, "a", "a", h("i", null));
    _render(host, a, null, ctx);
    assertEquals(host.innerHTML, "a<i></i>a");
    _diff(host, b, a, ctx);
    assertEquals(host.innerHTML, "aa<i></i>");
  } finally {
    cleanup();
  }
});

Deno.test("a component rendering bare text patches ITS node, not a sibling's", () => {
  const { ctx, host, cleanup } = env();
  try {
    const C = (p: { v: string }) => p.v;
    const a = h("div", null, "x", h(C as never, { v: "x" }));
    const b = h("div", null, "x", h(C as never, { v: "y" }));
    _render(host, a, null, ctx);
    assertEquals(host.innerHTML, "<div>xx</div>");
    _diff(host, b, a, ctx);
    // Was "<div>yx</div>": the component wrote into the sibling's text node.
    assertEquals(host.innerHTML, "<div>xy</div>");
  } finally {
    cleanup();
  }
});

Deno.test("a signal re-render of a text-only component finds its own node", async () => {
  const { doc, host, cleanup } = env();
  _setDocument(doc);
  const v = signal("x");
  const C = () => v.value;
  const App = () => h("div", null, "x", h(C as never, null));
  const handle = mount(host, App);
  try {
    assertEquals(host.innerHTML, "<div>xx</div>");
    v.set("y");
    handle._flush();
    // The per-component re-render path (renderer-rerender) recomputed the
    // component's `_dom` from its output — impossible for a bare string — so
    // it lost the handle and fell back to the sibling-matching scan.
    assertEquals(host.innerHTML, "<div>xy</div>");
  } finally {
    _unmount(handle);
    await cleanup();
  }
});

// ── removal ──────────────────────────────────────────────────────────────

Deno.test("a Fragment's bare-text child is removed with the Fragment", () => {
  const { ctx, host, cleanup } = env();
  try {
    const a = h("div", null, h(Fragment, null, "aaa"));
    const b = h("div", null, h("i", null, "I"));
    _render(host, a, null, ctx);
    assertEquals(host.innerHTML, "<div>aaa</div>");
    _diff(host, b, a, ctx);
    // `removeDom` ended at `getDom(vnode)`, which is null for a primitive, so
    // the removal was a NO-OP and the text accumulated on every toggle.
    assertEquals(host.innerHTML, "<div><i>I</i></div>");
  } finally {
    cleanup();
  }
});

Deno.test("a component's bare text is replaced, not left behind", () => {
  const { ctx, host, cleanup } = env();
  try {
    const C = (p: { v: string }) => p.v;
    const a = h("div", null, h(C as never, { v: "hello" }));
    const b = h("div", null, h(Fragment, null));
    _render(host, a, null, ctx);
    assertEquals(host.innerHTML, "<div>hello</div>");
    _diff(host, b, a, ctx);
    assertEquals(host.innerHTML, "<div><!----></div>");
  } finally {
    cleanup();
  }
});

// ── anchors: a container must hold its slot ──────────────────────────────

Deno.test("a Fragment that empties keeps an anchor IN the document", () => {
  const { ctx, host, cleanup } = env();
  try {
    const a = h("div", null, h(Fragment, null, null));
    const b = h("div", null, h(Fragment, null));
    _render(host, a, null, ctx);
    assertEquals(host.innerHTML, "<div><!----></div>");
    _diff(host, b, a, ctx);
    // The child diff had just removed that comment (it was the `_Null`
    // placeholder's node); adopting it anyway left the fragment anchored to a
    // DETACHED node, so it had no position at all.
    assertEquals(host.innerHTML, "<div><!----></div>");
  } finally {
    cleanup();
  }
});

Deno.test("an empty Fragment's anchor sits in the Fragment's slot, not at the end", () => {
  const { ctx, host, cleanup } = env();
  try {
    const a = h("div", null, h(Fragment, null, h("b", null)), h("p", null));
    const b = h("div", null, h(Fragment, null), h("p", null));
    _render(host, a, null, ctx);
    assertEquals(host.innerHTML, "<div><b></b><p></p></div>");
    _diff(host, b, a, ctx);
    assertEquals(host.innerHTML, "<div><!----><p></p></div>");
    // …and refilling grows back ABOVE <p>, where the fragment lives.
    const c = h("div", null, h(Fragment, null, h("b", null)), h("p", null));
    _diff(host, c, b, ctx);
    assertEquals(host.innerHTML, "<div><b></b><p></p></div>");
  } finally {
    cleanup();
  }
});

Deno.test("a nested Fragment gives its parent a LIVE first node", () => {
  const { ctx, host, cleanup } = env();
  try {
    const outer = h(Fragment, null, h(Fragment, null, h("b", null, "B")));
    _render(host, outer, null, ctx);
    // `createDom` returns a DocumentFragment for a Fragment child; recording
    // that carrier as the parent's `_dom` left it pointing at a node that
    // insertion had emptied and detached — every later diff then decided the
    // region started at `parent.firstChild` and clobbered earlier siblings.
    const dom = outer._dom as Node | undefined;
    assert(dom && dom.parentNode === host, "fragment _dom must be a live node");
    assertEquals((dom as Element).nodeName, "B");
  } finally {
    cleanup();
  }
});

Deno.test("a `_Null` placeholder survives its container gaining a keyed sibling", () => {
  const { ctx, host, cleanup } = env();
  try {
    const a = h(Fragment, null, null, "1");
    const b = h(Fragment, null, h("div", { key: "k" }), null, "1");
    _render(host, a, null, ctx);
    assertEquals(host.innerHTML, "<!---->1");
    _diff(host, b, a, ctx);
    // A comment node is not proof of an empty-container anchor: this one is a
    // real `null` child. Removing it deleted a child of the model.
    assertEquals(host.innerHTML, "<div></div><!---->1");
  } finally {
    cleanup();
  }
});

Deno.test("a keyed Fragment moves its bare text along with its elements", () => {
  const { ctx, host, cleanup } = env();
  try {
    const frag = (k: string) => h(Fragment, { key: k }, "t", h("b", null));
    const a = h("div", null, frag("f1"), h("i", { key: "i1" }));
    const b = h("div", null, h("i", { key: "i1" }), frag("f1"));
    _render(host, a, null, ctx);
    assertEquals(host.innerHTML, "<div>t<b></b><i></i></div>");
    _diff(host, b, a, ctx);
    // The move walked the fragment's children via `getDom`, which cannot see
    // bare text — the "t" was stranded where the fragment used to be.
    assertEquals(host.innerHTML, "<div><i></i>t<b></b></div>");
  } finally {
    cleanup();
  }
});

// ── SSR / hydrate parity ─────────────────────────────────────────────────

Deno.test("SSR emits an anchor for an empty Fragment, exactly like mount", () => {
  const { ctx, host, cleanup } = env();
  try {
    _render(host, h(Fragment, null), null, ctx);
    assertEquals(renderToString(h(Fragment, null)), host.innerHTML);
    assertEquals(host.innerHTML, "<!---->");
  } finally {
    cleanup();
  }
});

Deno.test("renderToStream emits the same empty-Fragment anchor as renderToString", async () => {
  const chunks: string[] = [];
  for await (
    const c of renderToStream(h("div", null, h(Fragment, null), h("p", null)))
  ) chunks.push(c);
  // Two SSR entry points that disagree are two different documents to hydrate.
  assertEquals(
    chunks.join(""),
    renderToString(h("div", null, h(Fragment, null), h("p", null))),
  );
  assertEquals(chunks.join(""), "<div><!----><p></p></div>");
});

Deno.test("a hydrated empty list fills BELOW its header (SSR ≡ mount)", () => {
  const { ctx, host, cleanup } = env();
  try {
    const view = (rows: string[]) =>
      h(
        "div",
        null,
        h("h1", null, "Header"),
        h(Fragment, null, ...rows.map((r) => h("p", null, r))),
      );
    const empty = view([]);
    host.innerHTML = renderToString(empty);
    const consumed = _hydrateNode(host, empty, ctx, false, 0);
    assert(consumed >= 0, "SSR output must hydrate without a mismatch");

    const filled = view(["r1", "r2"]);
    _diff(host, filled, empty, ctx);
    // Without an anchor the hydrated Fragment had no `_dom`, so its region was
    // taken to start at the parent's FIRST child — the rows landed above the
    // header. `mount` was correct; only the SSR path was wrong, which is
    // exactly the blind spot `testUI` cannot see.
    assertEquals(
      host.innerHTML,
      "<div><h1>Header</h1><p>r1</p><p>r2</p></div>",
    );
  } finally {
    cleanup();
  }
});

// ── the tripwire itself ──────────────────────────────────────────────────

Deno.test("dev tripwire fires on an ORDER defect at a correct node count", () => {
  const { ctx, host, cleanup } = env();
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => {
    warnings.push(a.map(String).join(" "));
  };
  setDevMode(true);
  try {
    const a = h("div", null, "a", h("b", null));
    _render(host, a, null, ctx);
    const el = host.firstChild as Element;
    // Simulate a reconciler desync: same nodes, same COUNT, wrong ORDER. The
    // old invariant only compared counts, so it stayed silent for exactly this
    // — which is every defect in this file but one.
    el.insertBefore(el.childNodes[1]!, el.childNodes[0]!);
    const b = h("div", null, "z", h("b", null));
    _diff(host, b, a, ctx);
    assert(
      warnings.some((w) => w.includes("desync")),
      `expected a child-desync warning, got: ${warnings.join(" | ") || "none"}`,
    );
  } finally {
    setDevMode(false);
    console.warn = origWarn;
    cleanup();
  }
});
