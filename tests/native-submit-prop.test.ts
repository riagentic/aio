// `<form nativeSubmit>` opts out of the SPA submit interception.
//
// The delegated submit listener (vdom-events.ts) calls `preventDefault()` for
// every handled form unless the element carries `data-native-submit`, and its
// comment promised `<form nativeSubmit>` as the spelling. The prop was never
// mapped: it landed as a `nativesubmit` attribute nothing reads, and the form
// was intercepted anyway — silently. `attrNameOf` is the one table both the
// client patcher and SSR use, so the mapping lives there and both agree.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Window } from "happy-dom";
import { h, renderToString } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";

function createDOM() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { doc, root, cleanup: () => win.happyDOM.close() };
}

Deno.test({
  name: "<form nativeSubmit> is NOT intercepted; a plain <form> still is",
  async fn() {
    const { doc, root, cleanup } = createDOM();
    _setDocument(doc);
    const seen: Record<string, boolean | null> = {
      plain: null,
      prop: null,
      attr: null,
      off: null,
    };
    const on = (name: string) => (e: Event) => {
      seen[name] = e.defaultPrevented;
      e.preventDefault(); // stop happy-dom from navigating
    };
    const App = () =>
      h(
        "div",
        null,
        h("form", { id: "plain", onSubmit: on("plain") }),
        h("form", { id: "prop", nativeSubmit: true, onSubmit: on("prop") }),
        h("form", {
          id: "attr",
          "data-native-submit": "",
          onSubmit: on("attr"),
        }),
        h("form", { id: "off", nativeSubmit: false, onSubmit: on("off") }),
      );
    const handle = mount(root, App);
    for (const id of ["plain", "prop", "attr", "off"]) {
      const form = root.querySelector(`#${id}`)!;
      form.dispatchEvent(
        // deno-lint-ignore no-explicit-any
        new (doc.defaultView as any).Event("submit", {
          bubbles: true,
          cancelable: true,
        }),
      );
    }
    assertEquals(seen.plain, true, "a plain form is intercepted");
    assertEquals(
      seen.prop,
      false,
      "<form nativeSubmit> is left to the browser",
    );
    assertEquals(seen.attr, false, "data-native-submit keeps working");
    assertEquals(seen.off, true, "nativeSubmit={false} means intercepted");
    const prop = root.querySelector("#prop")!;
    assert(prop.hasAttribute("data-native-submit"), "the prop wrote the attr");
    assert(!prop.hasAttribute("nativesubmit"), "…and nothing else");
    assert(
      !root.querySelector("#off")!.hasAttribute("data-native-submit"),
      "false writes nothing",
    );
    _unmount(handle);
    await cleanup();
  },
});

Deno.test("SSR spells nativeSubmit the way the client does", () => {
  const html = renderToString(h("form", { nativeSubmit: true }));
  assertStringIncludes(html, "data-native-submit");
  assert(!html.includes("nativesubmit") && !html.includes("nativeSubmit"));
  const off = renderToString(h("form", { nativeSubmit: false }));
  assert(!off.includes("native"), `false emits nothing: ${off}`);
});
