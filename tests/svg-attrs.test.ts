// SVG camelCase attribute mapping — stopColor etc. must emit
// as stop-color or gradients/strokes render black, while structural attrs like
// viewBox stay camelCase. Covers client (applyProps) and SSR (renderToString).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Window } from "happy-dom";
import { h, renderToString } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";
import { testUI } from "../src/testing/ui-test.ts";

const Gradient = () =>
  h(
    "svg",
    { viewBox: "0 0 10 10" },
    h(
      "defs",
      null,
      h(
        "linearGradient",
        { id: "g" },
        h("stop", { offset: "0%", stopColor: "red", stopOpacity: "0.5" }),
        h("stop", { offset: "100%", stopColor: "blue" }),
      ),
    ),
    h("rect", {
      width: 10,
      height: 10,
      fill: "url(#g)",
      strokeWidth: 2,
      stroke: "black",
    }),
  );

Deno.test("SVG: client render kebabs known attrs, preserves viewBox", async () => {
  // deno-lint-ignore no-explicit-any
  const ui = await testUI(Gradient, { document: new Window().document as any });
  await ui.settle();
  const html = ui.html();
  assertStringIncludes(html, "stop-color");
  assertStringIncludes(html, "stop-opacity");
  assertStringIncludes(html, "stroke-width");
  assertStringIncludes(html, 'viewBox="0 0 10 10"');
  assert(!html.includes("stopColor"), "stopColor leaked (renders black)");
  await ui.dispose();
});

Deno.test("SVG: SSR renderToString agrees with the client", () => {
  const html = renderToString(Gradient());
  assertStringIncludes(html, "stop-color");
  assertStringIncludes(html, "stroke-width");
  assertStringIncludes(html, 'viewBox="0 0 10 10"');
  assert(!html.includes("stopColor"));
});

// Removal has to use the SAME name mapping the write used. `_writeProp` sets
// `strokeWidth` as `stroke-width`; the remove path used the raw JSX key, so it
// deleted an attribute that never existed and left the real one on the element
// — an incremental diff that does not converge on what a fresh render makes,
// silently, for all 41 mapped SVG names.
Deno.test("svg: a removed camelCase attribute really leaves the DOM", () => {
  const win = new Window({ url: "https://localhost" });
  _setDocument(win.document as unknown as Document);
  const doc = win.document as unknown as Document;
  try {
    const host = doc.createElement("main");
    doc.body.appendChild(host);
    const withProps = () =>
      h(
        "svg",
        null,
        h("circle", { cx: 4, strokeWidth: 4, fillOpacity: "0.5" }),
      );
    const without = () => h("svg", null, h("circle", { cx: 4 }));

    const handle = mount(host, withProps);
    handle._flush?.();
    const before = host.innerHTML;
    _unmount(handle);
    host.innerHTML = "";

    // Incremental: mount with the props, then diff to the version without.
    const live = signal(true);
    const App = () =>
      live.value
        ? h(
          "svg",
          null,
          h("circle", { cx: 4, strokeWidth: 4, fillOpacity: "0.5" }),
        )
        : h("svg", null, h("circle", { cx: 4 }));
    const h2 = mount(host, App);
    h2._flush?.();
    assertStringIncludes(host.innerHTML, "stroke-width");
    live.set(false);
    h2._flush?.();
    const incremental = host.innerHTML;
    _unmount(h2);
    host.innerHTML = "";

    // Fresh render of the same model — the reference answer.
    const h3 = mount(host, without);
    h3._flush?.();
    const fresh = host.innerHTML;
    _unmount(h3);

    assertEquals(
      incremental,
      fresh,
      `a diff must converge on a fresh render (had: ${before})`,
    );
  } finally {
    win.happyDOM.close();
  }
});
