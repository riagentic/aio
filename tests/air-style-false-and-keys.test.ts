// Style declarations: a boolean value is NO declaration, and three key shapes
// that the blanket camel→kebab + unitless list got wrong.
//
// `{ display: hidden && "none" }` stringified `false` to "false", which
// `setProperty` ignores — so once `hidden` turned false the OLD `display:none`
// stayed on the element forever, and SSR shipped `display:false`. Separately:
// `--rowGap` was kebabed to `--row-gap` (a different, case-sensitive custom
// property), `msTransform` became `ms-transform` (no leading dash), and
// `WebkitLineClamp: 2` got `2px`. Every assertion compares an incremental
// render, a fresh mount and SSR — the three must agree.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h } from "../src/air/vdom-create.ts";
import { renderToString } from "../src/air/vdom-ssr.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";
import { camelToKebab, styleValue } from "../src/air/ssr-utils.ts";

function env() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { doc, root, done: () => closeWindow(win) };
}

Deno.test("style: false/true removes the declaration on re-render, like null", async () => {
  const { doc, root, done } = env();
  try {
    for (const off of [false, true, null, undefined]) {
      const s = signal<Record<string, unknown>>({
        display: "none",
        color: "red",
      });
      const handle = mount(root, () => h("div", { style: s.value }, "x"));
      s.set({ display: off, color: "red" });
      handle._flush();
      const el = root.firstElementChild as HTMLElement;
      assertEquals(
        el.style.getPropertyValue("display"),
        "",
        `display=${off} removes it`,
      );
      assertEquals(el.style.getPropertyValue("color"), "red");
      const fresh = doc.createElement("div");
      mount(
        fresh,
        () => h("div", { style: { display: off, color: "red" } }, "x"),
      );
      assertEquals(
        root.innerHTML,
        fresh.innerHTML,
        `display=${off}: incremental == fresh`,
      );
      _unmount(handle);
      root.innerHTML = "";
    }
  } finally {
    await done();
  }
});

Deno.test("style: SSR omits a boolean declaration instead of writing `display:false`", () => {
  assertEquals(
    renderToString(h("div", { style: { display: false, color: "red" } }, "x")),
    '<div style="color:red">x</div>',
  );
  assertEquals(
    renderToString(h("div", { style: { display: true } }, "x")),
    "<div>x</div>",
  );
  // A signal that resolves to null is no declaration either.
  assertEquals(
    renderToString(
      h("div", { style: { display: signal<string | null>(null) } }, "x"),
    ),
    "<div>x</div>",
  );
});

Deno.test("style keys: custom property verbatim, ms- prefix dashed, prefixed unitless", async () => {
  assertEquals(camelToKebab("--rowGap"), "--rowGap");
  assertEquals(camelToKebab("msTransform"), "-ms-transform");
  assertEquals(camelToKebab("WebkitLineClamp"), "-webkit-line-clamp");
  assertEquals(camelToKebab("backgroundColor"), "background-color");
  assertEquals(styleValue("WebkitLineClamp", 2), "2");
  assertEquals(styleValue("msFlexGrow", 1), "1");
  assertEquals(styleValue("aspectRatio", 2), "2");
  assertEquals(styleValue("--cols", 3), "3");
  assertEquals(styleValue("width", 3), "3px");

  const style = { "--rowGap": "4px", msTransform: "none", WebkitLineClamp: 2 };
  assertEquals(
    renderToString(h("div", { style }, "x")),
    '<div style="--rowGap:4px;-ms-transform:none;-webkit-line-clamp:2">x</div>',
  );
  const { root, done } = env();
  try {
    mount(root, () => h("div", { style }, "x"));
    const el = root.firstElementChild as HTMLElement;
    assertEquals(el.style.getPropertyValue("--rowGap"), "4px");
    assertEquals(el.style.getPropertyValue("--row-gap"), "");
  } finally {
    await done();
  }
});
