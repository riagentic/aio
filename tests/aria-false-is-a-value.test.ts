// `aria-expanded={false}` must render `aria-expanded="false"`, not nothing.
//
// The renderers treated `false` as "this attribute is absent" for EVERY
// attribute. That is right for a real boolean attribute (`disabled`,
// `checked`), which is handled by name elsewhere — and it is the OPPOSITE of
// what the author wrote for `aria-*` and the enumerated attributes, where
// "false" is a string VALUE:
//
//   aria-pressed absent   → "not a toggle button at all"
//   aria-expanded absent  → "not expandable"
//   draggable absent      → the element's default, not "off"
//
// So an `aria-expanded={open}` menu announced itself correctly when open and
// became a plain button when closed. Measured across both renderers:
// aria-expanded/hidden/checked/selected/pressed/invalid/disabled, draggable,
// spellCheck and contentEditable were all dropped.
//
// aio's own kit had been working around it by hand — `src/ui/controls.ts`
// writes `? "true" : "false"` strings — and aio's own app manager had the bug:
// `aria-checked={showAll.value === v}` (amui/src/App.tsx) rendered nothing
// whenever it was false, so two of the three radio options told a screen
// reader they were not radio options.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h, renderToString } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";

const STRING_FALSE: [string, string][] = [
  ["button", "aria-expanded"],
  ["div", "aria-hidden"],
  ["div", "aria-checked"],
  ["div", "aria-selected"],
  ["button", "aria-pressed"],
  ["input", "aria-invalid"],
  ["button", "aria-disabled"],
  ["img", "draggable"],
  ["div", "spellCheck"],
  ["div", "contentEditable"],
];

Deno.test("SSR: `false` is a VALUE for aria and the enumerated attributes", () => {
  for (const [tag, attr] of STRING_FALSE) {
    const html = renderToString(h(tag, { [attr]: false }) as never);
    assert(
      /="false"/.test(html),
      `<${tag} ${attr}={false}> must render the attribute: ${html}`,
    );
  }
});

Deno.test("SSR: a real boolean attribute is still absent when false", () => {
  // The other direction — a rule that kept every `false` would put
  // `disabled="false"` on the page, which a browser reads as DISABLED.
  for (const attr of ["disabled", "checked", "readOnly", "required"]) {
    const html = renderToString(h("input", { [attr]: false }) as never);
    assertEquals(
      /false/.test(html),
      false,
      `<input ${attr}={false}> must emit nothing: ${html}`,
    );
  }
});

Deno.test("client: an aria toggle keeps saying `false` when it closes", async () => {
  const win = new Window({ url: "http://localhost/" });
  // deno-lint-ignore no-explicit-any
  const doc = win.document as any;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  const open = signal(true);
  const App = () =>
    h("button", { "aria-expanded": open.value, "aria-controls": "panel" }, [
      "Menu",
    ]);
  const handle = mount(root, App as never);
  try {
    const btn = () => root.querySelector("button") as HTMLElement;
    assertEquals(btn().getAttribute("aria-expanded"), "true");

    open.set(false);
    handle._flush();
    assertEquals(
      btn().getAttribute("aria-expanded"),
      "false",
      "a closed menu is still a menu — dropping the attribute says it was " +
        "never expandable",
    );

    open.set(true);
    handle._flush();
    assertEquals(btn().getAttribute("aria-expanded"), "true");
    // …and the neighbouring attribute was never disturbed.
    assertEquals(btn().getAttribute("aria-controls"), "panel");
  } finally {
    _unmount(handle);
    _setDocument(null as never);
    await closeWindow(win);
  }
});

// Server and client must agree, or hydration swaps the accessibility tree out
// from under the first paint.
Deno.test("SSR and client render the same attribute for a false aria value", async () => {
  const win = new Window({ url: "http://localhost/" });
  // deno-lint-ignore no-explicit-any
  const doc = win.document as any;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  try {
    for (const [tag, attr] of STRING_FALSE) {
      const ssr = renderToString(h(tag, { [attr]: false }) as never);
      const handle = mount(root, (() => h(tag, { [attr]: false })) as never);
      const el = root.firstElementChild as HTMLElement;
      const clientValue = el.getAttribute(attr.toLowerCase());
      assertEquals(
        clientValue,
        "false",
        `client dropped ${attr} on <${tag}>`,
      );
      assertStringIncludes(ssr, '="false"');
      _unmount(handle);
      root.innerHTML = "";
    }
  } finally {
    _setDocument(null as never);
    await closeWindow(win);
  }
});
