// `<select value={…}>` on the server.
//
// A `<select>` has NO `value` content attribute — which option is chosen is
// said by `selected` on the option — so the prop writer correctly emitted
// nothing for it, and nothing put `selected` anywhere either. The server
// always shipped the FIRST option: a server-rendered language, currency or
// status picker showed the wrong choice until hydration, and a form submitted
// before hydration (or with JS off) posted it. The `<textarea value>` half of
// the same idea was already solved one line away in `_NO_ATTR_ON`.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/air/vdom-create.ts";
import { renderToString } from "../src/air/vdom-ssr.ts";
import { renderToStream } from "../src/air/ssr-stream.ts";

async function streamed(vnode: ReturnType<typeof h>): Promise<string> {
  let out = "";
  for await (const chunk of renderToStream(vnode)) out += chunk;
  return out;
}

const langs = (value: unknown, extra: Record<string, unknown> = {}) =>
  h(
    "select",
    { value, ...extra },
    h("option", { value: "en" }, "English"),
    h("option", { value: "fr" }, "French"),
    h("option", { value: "de" }, "German"),
  );

Deno.test("SSR: the option matching the select's value is the selected one", async () => {
  const out = renderToString(langs("fr"));
  assertStringIncludes(out, '<option value="fr" selected>French</option>');
  assertEquals(out.match(/selected/g)?.length, 1, "exactly one is selected");
  assertStringIncludes(
    await streamed(langs("fr")),
    '<option value="fr" selected>French</option>',
  );
});

Deno.test("SSR: defaultValue picks the option too", () => {
  const out = renderToString(
    h(
      "select",
      { defaultValue: "de" },
      h("option", { value: "en" }, "English"),
      h("option", { value: "de" }, "German"),
    ),
  );
  assertStringIncludes(out, '<option value="de" selected>German</option>');
});

Deno.test("SSR: an option with no value of its own is named by its text", () => {
  const out = renderToString(
    h(
      "select",
      { value: "German" },
      h("option", null, "English"),
      h("option", null, "German"),
    ),
  );
  assertStringIncludes(out, "<option selected>German</option>");
});

Deno.test("SSR: a multiple select takes an array of values", () => {
  const out = renderToString(langs(["en", "de"], { multiple: true }));
  assertStringIncludes(out, '<option value="en" selected>');
  assertStringIncludes(out, '<option value="de" selected>');
  assert(!/<option value="fr" selected>/.test(out), "fr must not be selected");
});

Deno.test("SSR: an explicit selected prop wins over the select's value", () => {
  const out = renderToString(
    h(
      "select",
      { value: "en" },
      h("option", { value: "en", selected: false }, "English"),
      h("option", { value: "fr", selected: true }, "French"),
    ),
  );
  assertStringIncludes(out, '<option value="fr" selected>French</option>');
  assert(!/value="en" selected/.test(out), "the author's false must hold");
});

Deno.test("SSR: options inside an optgroup are still in the select's scope", () => {
  const out = renderToString(
    h(
      "select",
      { value: "fr" },
      h(
        "optgroup",
        { label: "Europe" },
        h("option", { value: "fr" }, "French"),
        h("option", { value: "de" }, "German"),
      ),
    ),
  );
  assertStringIncludes(out, '<option value="fr" selected>French</option>');
});

Deno.test("SSR: no select, no selected — and the scope does not leak after one", () => {
  const loose = renderToString(h("option", { value: "fr" }, "French"));
  assertEquals(loose, '<option value="fr">French</option>');
  // Render a select, then a bare option with the same value: if the scope
  // stack leaked, this one would come back marked.
  renderToString(langs("fr"));
  assertEquals(
    renderToString(h("option", { value: "fr" }, "French")),
    '<option value="fr">French</option>',
  );
});

Deno.test("SSR: a select with no value marks nothing", () => {
  const out = renderToString(langs(undefined));
  assert(!/selected/.test(out), `nothing should be selected: ${out}`);
});

// ── …and hydration must not throw the server's choice away ───────────────
//
// Hydration sweeps off every attribute the component's props do not imply,
// which is right — a server-only `disabled` or `hidden` kept forever is a
// real bug it was written to end. But `selected` on an `<option>` is the
// server's ONLY spelling of the parent select's `value`: mount sets
// `select.value`, which flips the option's selected PROPERTY and writes no
// attribute, so the option's own props can never imply it. Without an
// exemption the sweep strips the server's choice back to the first option,
// and the divergence check reports correct markup as a disagreement in the
// renderer's loudest dev warning.
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { _setDocument, _unmount, hydrate } from "../src/air/aio-renderer.ts";

Deno.test("hydrate: the server's chosen option survives", async () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  try {
    const App = () => langs("fr");
    const host = doc.createElement("main");
    doc.body.appendChild(host);
    host.innerHTML = renderToString(h(App, null));
    const before = host.querySelector('option[value="fr"]')!;
    assert(before.hasAttribute("selected"), "the server marked it");

    const handle = hydrate(host, App);
    const sel = host.querySelector("select") as unknown as HTMLSelectElement;
    assertEquals(sel.value, "fr", "and the hydrated select still says so");
    assert(
      host.querySelector('option[value="fr"]')!.hasAttribute("selected"),
      "the attribute was not swept away",
    );
    _unmount(handle);
    host.remove();
  } finally {
    await closeWindow(win);
  }
});
