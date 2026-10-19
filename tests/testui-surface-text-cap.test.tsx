// `ui.surface()` caps text at 80 chars (marked "…"), so an assertion on a long
// label read from it failed on a correct UI (feedback network §4). The
// full-text door is `.text` on the element or component handle — pinned here
// as never capped, as docs/testing/ui-testing.md says.
import { assert, assertEquals } from "@std/assert";
import type { UISurfaceNode } from "../src/air/ui-surface.ts";
import { testUI } from "../src/testing/ui-test.ts";

const LONG = "RouterOS router configuration page — ".repeat(4).trim();

function Detail() {
  return <button type="button" t="detail">{LONG}</button>;
}
function App() {
  return <Detail />;
}

const texts = (n: UISurfaceNode): string[] => [
  n.text,
  ...n.elements.map((e) => e.text ?? ""),
  ...n.children.flatMap(texts),
];

Deno.test("surface() caps text, marked; .text on a handle is whole", async () => {
  await using ui = await testUI(App);
  assert(LONG.length > 80);
  const capped = texts(ui.surface());
  assert(!capped.includes(LONG), "the surface is capped");
  assert(capped.some((t) => t.endsWith("…")), "the cut is marked");
  assertEquals(ui.detail.text, LONG, "an element's .text is never capped");
  assertEquals(ui.Detail.text, LONG, "a component's .text is never capped");
});
