// SVG camelCase attribute mapping — stopColor etc. must emit
// as stop-color or gradients/strokes render black, while structural attrs like
// viewBox stay camelCase. Covers client (applyProps) and SSR (renderToString).
import { assert, assertStringIncludes } from "@std/assert";
import { Window } from "happy-dom";
import { h, renderToString } from "../src/air/vdom.ts";
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
