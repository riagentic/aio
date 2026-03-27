import { assertEquals, assertExists } from "@std/assert";
import { Window } from "happy-dom";
import { Fragment, h, type VNode } from "../src/vdom.ts";
import { _diff, _render } from "../src/vdom.ts";

// happy-dom creates internal timers, disable Deno's leak detection for DOM tests
const S = { sanitizeOps: false, sanitizeResources: false } as const;

function createDOM(): {
  document: Document;
  ctx: { doc: Document };
  cleanup: () => void;
} {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  return { document: doc, ctx: { doc }, cleanup: () => win.close() };
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

Deno.test("h: filters null/undefined/boolean children", () => {
  const vn = h("div", null, null, undefined, false, "text", 0);
  assertEquals(vn.children.length, 2);
});

Deno.test({
  name: "render: creates text node",
  ...S,
  fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    _render(root, h("span", null, "hello"), null, ctx);
    assertEquals(root.innerHTML, "<span>hello</span>");
    cleanup();
  },
});

Deno.test({
  name: "render: sets attributes",
  ...S,
  fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    _render(root, h("input", { type: "text", value: "abc" }), null, ctx);
    const input = root.firstChild as HTMLInputElement;
    assertEquals(input.getAttribute("type"), "text");
    cleanup();
  },
});

Deno.test({
  name: "render: applies style object",
  ...S,
  fn() {
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
    cleanup();
  },
});

Deno.test({
  name: "render: event handlers",
  ...S,
  fn() {
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
    cleanup();
  },
});

Deno.test({
  name: "render: nested elements",
  ...S,
  fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    _render(
      root,
      h("ul", null, h("li", null, "one"), h("li", null, "two")),
      null,
      ctx,
    );
    assertEquals(root.querySelectorAll("li").length, 2);
    cleanup();
  },
});

Deno.test({
  name: "render: fragment renders children without wrapper",
  ...S,
  fn() {
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
    cleanup();
  },
});

Deno.test({
  name: "render: className prop maps to class attribute",
  ...S,
  fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    _render(root, h("div", { className: "foo bar" }), null, ctx);
    assertEquals(
      (root.firstChild as HTMLElement).getAttribute("class"),
      "foo bar",
    );
    cleanup();
  },
});

Deno.test({
  name: "diff: updates text content",
  ...S,
  fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    const old = h("span", null, "old");
    _render(root, old, null, ctx);
    const next = h("span", null, "new");
    _diff(root, next, old, ctx);
    assertEquals(root.innerHTML, "<span>new</span>");
    cleanup();
  },
});

Deno.test({
  name: "diff: updates attributes",
  ...S,
  fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    const old = h("div", { id: "a", title: "old" });
    _render(root, old, null, ctx);
    const next = h("div", { id: "b" });
    _diff(root, next, old, ctx);
    const el = root.firstChild as HTMLElement;
    assertEquals(el.getAttribute("id"), "b");
    assertEquals(el.getAttribute("title"), null);
    cleanup();
  },
});

Deno.test({
  name: "diff: replaces element when tag changes",
  ...S,
  fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    const old = h("span", null, "text");
    _render(root, old, null, ctx);
    const next = h("div", null, "text");
    _diff(root, next, old, ctx);
    assertEquals((root.firstChild as HTMLElement).tagName, "DIV");
    cleanup();
  },
});

Deno.test({
  name: "diff: adds new children",
  ...S,
  fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    const old = h("ul", null, h("li", null, "a"));
    _render(root, old, null, ctx);
    const next = h("ul", null, h("li", null, "a"), h("li", null, "b"));
    _diff(root, next, old, ctx);
    assertEquals(root.querySelectorAll("li").length, 2);
    cleanup();
  },
});

Deno.test({
  name: "diff: removes extra children",
  ...S,
  fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    const old = h("ul", null, h("li", null, "a"), h("li", null, "b"));
    _render(root, old, null, ctx);
    const next = h("ul", null, h("li", null, "a"));
    _diff(root, next, old, ctx);
    assertEquals(root.querySelectorAll("li").length, 1);
    cleanup();
  },
});

Deno.test({
  name: "diff: keyed reorder preserves DOM nodes",
  ...S,
  fn() {
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
    cleanup();
  },
});

Deno.test({
  name: "render: SVG elements use correct namespace",
  ...S,
  fn() {
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
    cleanup();
  },
});

Deno.test({
  name: "render: function component",
  ...S,
  fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    const Greeting = (props: { name: string }) =>
      h("span", null, `Hi ${props.name}`);
    _render(root, h(Greeting, { name: "World" }), null, ctx);
    assertEquals(root.innerHTML, "<span>Hi World</span>");
    cleanup();
  },
});

Deno.test({
  name: "render: nested components",
  ...S,
  fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    const Inner = () => h("b", null, "bold");
    const Outer = () => h("div", null, h(Inner, null));
    _render(root, h(Outer, null), null, ctx);
    assertEquals(root.innerHTML, "<div><b>bold</b></div>");
    cleanup();
  },
});
