import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { Fragment, h, type VNode } from "../src/vdom.ts";
import { _diff, _render } from "../src/vdom.ts";

// happy-dom timers drained via win.happyDOM.close() — sanitizers re-enabled

function createDOM() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  return { document: doc, ctx: { doc }, cleanup: () => win.happyDOM.close() };
}

Deno.test("h: marks fully-static element VNodes as _static", () => {
  const vn = h("div", { className: "box" }, "hello");
  assertEquals(vn._static, true);
});

Deno.test("h: does NOT mark VNodes with function props as _static", () => {
  const vn = h("div", { onClick: () => {} }, "hello");
  assertEquals(vn._static, undefined);
});

Deno.test("h: does NOT mark VNodes with non-static children as _static", () => {
  const Inner = () => h("span", null, "x");
  const vn = h("div", null, h(Inner, null));
  assertEquals(vn._static, undefined);
});

Deno.test("h: marks nested static elements as _static", () => {
  const vn = h("div", null, h("span", { className: "a" }, "text"));
  assertEquals(vn._static, true);
  assertEquals((vn.children[0] as VNode)._static, true);
});

Deno.test("h: does NOT mark component VNodes as _static", () => {
  const Comp = () => h("div", null);
  const vn = h(Comp, null);
  assertEquals(vn._static, undefined);
});

Deno.test("h: does NOT mark Fragment as _static", () => {
  const vn = h(Fragment, null, h("span", null, "a"));
  assertEquals(vn._static, undefined);
});

Deno.test("h: does NOT mark VNode with ref as _static", () => {
  const vn = h("div", { ref: { current: null } }, "text");
  assertEquals(vn._static, undefined);
});

Deno.test("h: does NOT mark VNode with key as _static", () => {
  const vn = h("li", { key: "a" }, "item");
  assertEquals(vn._static, undefined);
});

Deno.test({
  name: "diff: skips static VNodes — reuses DOM",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    const old = h("div", { className: "box" }, "hello");
    _render(root, old, null, ctx);
    const origDom = old._dom;

    const next = h("div", { className: "box" }, "hello");
    _diff(root, next, old, ctx);

    assertEquals(next._dom, origDom);
    assertEquals(root.innerHTML, '<div class="box">hello</div>');
    await cleanup();
  },
});

Deno.test({
  name: "diff: does NOT skip when static VNode tags differ",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    const old = h("div", null, "hello");
    _render(root, old, null, ctx);

    const next = h("span", null, "hello");
    _diff(root, next, old, ctx);

    assertEquals(root.innerHTML, "<span>hello</span>");
    await cleanup();
  },
});
