import { assertEquals, assertExists } from "@std/assert";
import { Window } from "happy-dom";
import { Fragment, h, type VNode } from "../src/air/vdom.ts";
import { _diff, _render } from "../src/air/vdom.ts";

// happy-dom timers drained via win.happyDOM.close() — sanitizers re-enabled

function createDOM(): {
  document: Document;
  ctx: { doc: Document };
  cleanup: () => void;
} {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  return { document: doc, ctx: { doc }, cleanup: () => win.happyDOM.close() };
}

Deno.test("h: creates element vnode", () => {
  const vn = h("div", { id: "test" }, "hello");
  assertEquals(vn.tag, "div");
  assertEquals(vn.props.id, "test");
  assertEquals(vn.children, ["hello"]);
});

Deno.test("h: extracts key from props", () => {
  const vn = h("li", { key: "abc" }, "item");
  assertEquals(vn.key, "abc");
});

Deno.test("h: component vnode", () => {
  const Comp = (props: { x: number }) => h("span", null, String(props.x));
  const vn = h(Comp, { x: 42 });
  assertEquals(typeof vn.tag, "function");
  assertEquals(vn.props.x, 42);
});

Deno.test("h: fragment", () => {
  const vn = h(Fragment, null, h("a", null), h("b", null));
  assertEquals(vn.tag, Fragment);
  assertEquals(vn.children.length, 2);
});

Deno.test("h: flattens nested children arrays", () => {
  const vn = h("div", null, [h("a", null), h("b", null)], h("c", null));
  assertEquals(vn.children.length, 3);
});

Deno.test("h: preserves null/undefined/boolean as placeholders (AIO-107)", () => {
  const vn = h("div", null, null, undefined, false, "text", 0);
  // 3 null placeholders + "text" + 0 = 5 children
  assertEquals(vn.children.length, 5);
  // Placeholders are VNodes with _Null tag
  assertEquals(typeof vn.children[0], "object");
  assertEquals(vn.children[3], "text");
  assertEquals(vn.children[4], 0);
});

Deno.test({
  name: "render: creates text node",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    _render(root, h("span", null, "hello"), null, ctx);
    assertEquals(root.innerHTML, "<span>hello</span>");
    await cleanup();
  },
});

Deno.test({
  name: "render: sets attributes",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    _render(root, h("input", { type: "text", value: "abc" }), null, ctx);
    const input = root.firstChild as HTMLInputElement;
    assertEquals(input.getAttribute("type"), "text");
    await cleanup();
  },
});

Deno.test({
  name: "render: applies style object",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    _render(
      root,
      h("div", { style: { color: "red", fontSize: "12px" } }),
      null,
      ctx,
    );
    const el = root.firstChild as HTMLElement;
    assertEquals(el.style.color, "red");
    assertEquals(el.style.fontSize, "12px");
    await cleanup();
  },
});

Deno.test({
  name: "render: event handlers",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    let clicked = false;
    _render(
      root,
      h("button", {
        onClick: () => {
          clicked = true;
        },
      }, "click"),
      null,
      ctx,
    );
    const btn = root.firstChild as HTMLElement;
    btn.click();
    assertEquals(clicked, true);
    await cleanup();
  },
});

Deno.test({
  name: "render: nested elements",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    _render(
      root,
      h("ul", null, h("li", null, "one"), h("li", null, "two")),
      null,
      ctx,
    );
    assertEquals(root.querySelectorAll("li").length, 2);
    await cleanup();
  },
});

Deno.test({
  name: "render: fragment renders children without wrapper",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    _render(
      root,
      h(Fragment, null, h("a", null, "1"), h("b", null, "2")),
      null,
      ctx,
    );
    assertEquals(root.childNodes.length, 2);
    assertEquals((root.firstChild as HTMLElement).tagName, "A");
    await cleanup();
  },
});

Deno.test({
  name: "render: className prop maps to class attribute",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    _render(root, h("div", { className: "foo bar" }), null, ctx);
    assertEquals(
      (root.firstChild as HTMLElement).getAttribute("class"),
      "foo bar",
    );
    await cleanup();
  },
});

Deno.test({
  name: "diff: updates text content",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    const old = h("span", null, "old");
    _render(root, old, null, ctx);
    const next = h("span", null, "new");
    _diff(root, next, old, ctx);
    assertEquals(root.innerHTML, "<span>new</span>");
    await cleanup();
  },
});

Deno.test({
  name: "diff: updates attributes",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    const old = h("div", { id: "a", title: "old" });
    _render(root, old, null, ctx);
    const next = h("div", { id: "b" });
    _diff(root, next, old, ctx);
    const el = root.firstChild as HTMLElement;
    assertEquals(el.getAttribute("id"), "b");
    assertEquals(el.getAttribute("title"), null);
    await cleanup();
  },
});

Deno.test({
  name: "diff: replaces element when tag changes",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    const old = h("span", null, "text");
    _render(root, old, null, ctx);
    const next = h("div", null, "text");
    _diff(root, next, old, ctx);
    assertEquals((root.firstChild as HTMLElement).tagName, "DIV");
    await cleanup();
  },
});

Deno.test({
  name: "diff: adds new children",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    const old = h("ul", null, h("li", null, "a"));
    _render(root, old, null, ctx);
    const next = h("ul", null, h("li", null, "a"), h("li", null, "b"));
    _diff(root, next, old, ctx);
    assertEquals(root.querySelectorAll("li").length, 2);
    await cleanup();
  },
});

Deno.test({
  name: "diff: removes extra children",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    const old = h("ul", null, h("li", null, "a"), h("li", null, "b"));
    _render(root, old, null, ctx);
    const next = h("ul", null, h("li", null, "a"));
    _diff(root, next, old, ctx);
    assertEquals(root.querySelectorAll("li").length, 1);
    await cleanup();
  },
});

Deno.test({
  name: "diff: keyed reorder preserves DOM nodes",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    const old = h(
      "ul",
      null,
      h("li", { key: "a" }, "A"),
      h("li", { key: "b" }, "B"),
      h("li", { key: "c" }, "C"),
    );
    _render(root, old, null, ctx);
    const ul = root.firstChild as HTMLElement;
    const origB = ul.children[1];
    const next = h(
      "ul",
      null,
      h("li", { key: "c" }, "C"),
      h("li", { key: "a" }, "A"),
      h("li", { key: "b" }, "B"),
    );
    _diff(root, next, old, ctx);
    assertEquals(ul.children[2], origB);
    assertEquals(ul.children[0]!.textContent, "C");
    await cleanup();
  },
});

Deno.test({
  name: "render: SVG elements use correct namespace",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    _render(
      root,
      h(
        "svg",
        { viewBox: "0 0 100 100" },
        h("circle", { cx: "50", cy: "50", r: "40" }),
      ),
      null,
      ctx,
    );
    const svg = root.firstChild as SVGElement;
    assertEquals(svg.tagName, "svg");
    assertEquals(svg.namespaceURI, "http://www.w3.org/2000/svg");
    await cleanup();
  },
});

Deno.test({
  name: "render: function component",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    const Greeting = (props: { name: string }) =>
      h("span", null, `Hi ${props.name}`);
    _render(root, h(Greeting, { name: "World" }), null, ctx);
    assertEquals(root.innerHTML, "<span>Hi World</span>");
    await cleanup();
  },
});

Deno.test({
  name: "render: nested components",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    const Inner = () => h("b", null, "bold");
    const Outer = () => h("div", null, h(Inner, null));
    _render(root, h(Outer, null), null, ctx);
    assertEquals(root.innerHTML, "<div><b>bold</b></div>");
    await cleanup();
  },
});

// --- AIO-114 regression tests ---

Deno.test({
  name:
    "diff: mixed keyed + non-keyed children — no DOM leak on re-render (AIO-114)",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");

    // Initial: keyed list + non-keyed button
    const old = h(
      "div",
      null,
      h("span", { key: "a" }, "A"),
      h("span", { key: "b" }, "B"),
      h("button", null, "Toggle"),
    );
    _render(root, old, null, ctx);
    const container = root.firstChild as HTMLElement;
    assertEquals(container.childNodes.length, 3, "initial: 3 children");

    // Re-render with same structure — non-keyed button must be patched, not duplicated
    const next = h(
      "div",
      null,
      h("span", { key: "a" }, "A"),
      h("span", { key: "b" }, "B"),
      h("button", null, "Toggle"),
    );
    _diff(root, next, old, ctx);
    assertEquals(
      container.childNodes.length,
      3,
      "after re-render: still 3 children (no leak)",
    );

    // Third render — verify no accumulation
    const next2 = h(
      "div",
      null,
      h("span", { key: "a" }, "A"),
      h("span", { key: "b" }, "B"),
      h("button", null, "Toggle"),
    );
    _diff(root, next2, next, ctx);
    assertEquals(
      container.childNodes.length,
      3,
      "after 3rd render: still 3 children",
    );
    await cleanup();
  },
});

Deno.test({
  name:
    "diff: mixed keyed + conditional non-keyed — removed conditionals don't leak (AIO-114)",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");

    // Initial: keyed list + conditional badge + button
    const old = h(
      "div",
      null,
      h("span", { key: "a" }, "A"),
      h("span", null, "BADGE"),
      h("button", null, "Click"),
    );
    _render(root, old, null, ctx);
    const container = root.firstChild as HTMLElement;
    assertEquals(container.childNodes.length, 3);

    // Re-render: badge removed (conditional false)
    const next = h(
      "div",
      null,
      h("span", { key: "a" }, "A"),
      h("button", null, "Click"),
    );
    _diff(root, next, old, ctx);
    // Should have 2 children: keyed span + button. Old badge removed.
    assertEquals(
      container.childNodes.length,
      2,
      "badge removed, no orphan DOM",
    );
    await cleanup();
  },
});

Deno.test({
  name:
    "diff: mixed keyed + non-keyed — keyed reorder preserves non-keyed identity (AIO-114)",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");

    const old = h(
      "ul",
      null,
      h("li", { key: "x" }, "X"),
      h("li", { key: "y" }, "Y"),
      h("li", null, "footer"),
    );
    _render(root, old, null, ctx);
    const ul = root.firstChild as HTMLElement;
    const footerBefore = ul.children[2];

    // Reorder keyed, non-keyed stays
    const next = h(
      "ul",
      null,
      h("li", { key: "y" }, "Y"),
      h("li", { key: "x" }, "X"),
      h("li", null, "footer"),
    );
    _diff(root, next, old, ctx);
    assertEquals(ul.children.length, 3, "still 3 children after reorder");
    assertEquals(ul.children[0]!.textContent, "Y");
    assertEquals(ul.children[1]!.textContent, "X");
    assertEquals(ul.children[2]!.textContent, "footer");
    // Non-keyed element should preserve DOM identity (patched in place)
    assertEquals(
      ul.children[2],
      footerBefore,
      "non-keyed DOM identity preserved",
    );
    await cleanup();
  },
});

Deno.test({
  name:
    "diff: keyed Fragment siblings don't corrupt non-keyed cursor walk (AIO-114)",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");

    // Keyed Fragment expands to multiple DOM nodes, followed by non-keyed element
    const old = h(
      "div",
      null,
      h(Fragment, { key: "frag" }, h("span", null, "A"), h("span", null, "B")),
      h("button", null, "Action"),
    );
    _render(root, old, null, ctx);
    const container = root.firstChild as HTMLElement;
    // Fragment(2 spans) + button = 3 DOM nodes
    assertEquals(container.childNodes.length, 3, "initial: 3 DOM nodes");

    // Re-render same structure — button must not leak
    const next = h(
      "div",
      null,
      h(Fragment, { key: "frag" }, h("span", null, "A"), h("span", null, "B")),
      h("button", null, "Action"),
    );
    _diff(root, next, old, ctx);
    assertEquals(
      container.childNodes.length,
      3,
      "after re-render: still 3 DOM nodes",
    );

    // Third render to confirm no accumulation
    const next2 = h(
      "div",
      null,
      h(Fragment, { key: "frag" }, h("span", null, "A"), h("span", null, "B")),
      h("button", null, "Action"),
    );
    _diff(root, next2, next, ctx);
    assertEquals(
      container.childNodes.length,
      3,
      "after 3rd render: still 3 DOM nodes",
    );
    await cleanup();
  },
});

Deno.test({
  name: "diff: non-keyed count shrinks and grows correctly (AIO-114)",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");

    // 3 non-keyed + 1 keyed
    const v1 = h(
      "div",
      null,
      h("span", { key: "k" }, "keyed"),
      h("em", null, "a"),
      h("em", null, "b"),
      h("em", null, "c"),
    );
    _render(root, v1, null, ctx);
    const container = root.firstChild as HTMLElement;
    assertEquals(container.childNodes.length, 4);

    // Shrink to 1 non-keyed
    const v2 = h(
      "div",
      null,
      h("span", { key: "k" }, "keyed"),
      h("em", null, "only"),
    );
    _diff(root, v2, v1, ctx);
    assertEquals(container.childNodes.length, 2, "shrink: 2 DOM nodes");

    // Grow to 4 non-keyed
    const v3 = h(
      "div",
      null,
      h("span", { key: "k" }, "keyed"),
      h("em", null, "w"),
      h("em", null, "x"),
      h("em", null, "y"),
      h("em", null, "z"),
    );
    _diff(root, v3, v2, ctx);
    assertEquals(container.childNodes.length, 5, "grow: 5 DOM nodes");
    await cleanup();
  },
});

// ── AIO-116: text node nodeType validation in diffUnkeyed/diffKeyed ────

Deno.test({
  name:
    "AIO-116: diffUnkeyed must not set textContent on element nodes when cursor desyncs",
  async fn() {
    const { document: doc, ctx, cleanup } = createDOM();
    const root = doc.createElement("div");
    doc.body.appendChild(root);

    // Initial render: parent with text child + element child
    const v1 = h("div", null, "hello", h("span", null, "world"));
    _render(root, v1, null, ctx);
    const container = root.firstChild as HTMLElement;

    // Externally mutate DOM: replace text node with an element
    // Simulates cursor desync (Fragment shift, external mutation, etc.)
    const textNode = container.childNodes[0]!;
    const injected = doc.createElement("b");
    injected.innerHTML = "<em>keep</em><strong>this</strong>";
    container.replaceChild(injected, textNode);
    // DOM: [<b><em>keep</em><strong>this</strong></b>, <span>world</span>]
    assertEquals(container.childNodes[0]!.nodeName, "B");
    assertEquals(
      (container.childNodes[0] as HTMLElement).childNodes.length,
      2,
      "<b> has 2 children before diff",
    );

    // Re-render: old vnode says "hello" (text), new says "updated" (text)
    // BUG: cursor points to <b>, code sets <b>.textContent = "updated"
    //       which DESTROYS <b>'s children (<em> and <strong>)
    const v2 = h("div", null, "updated", h("span", null, "world"));
    _diff(root, v2, v1, ctx);

    // After fix: the <b> element's children should NOT be destroyed.
    // The diff should either skip the element or create a fresh text node.
    // Check that no element node had its children wiped:
    let elementCorrupted = false;
    for (let i = 0; i < container.childNodes.length; i++) {
      const node = container.childNodes[i]!;
      if (node.nodeType === 1 && node.nodeName === "B") {
        // If <b> survived, it should still have its original 2 children
        if ((node as HTMLElement).childNodes.length < 2) {
          elementCorrupted = true;
        }
      }
    }
    assertEquals(
      elementCorrupted,
      false,
      "element node children should not be destroyed by textContent assignment on wrong nodeType",
    );

    await cleanup();
  },
});
