// `key={5}` renders exactly like `key="5"`; the finder compared strictly and
// missed one spelling SILENTLY (field report §4.5).
import { assertEquals } from "@std/assert";
import { findComponents, type UISurfaceNode } from "../src/air/ui-surface.ts";

const node = (key: string | number): UISurfaceNode => ({
  component: "Row",
  key,
  path: `App/Row[${key}]`,
  elements: [],
  children: [],
  text: "",
} as unknown as UISurfaceNode);

const root: UISurfaceNode = {
  component: "App",
  path: "App",
  elements: [],
  children: [node(5), node("7")],
  text: "",
} as unknown as UISurfaceNode;

Deno.test("findComponents: numeric and string keys match either spelling", () => {
  assertEquals(findComponents(root, "Row", 5).length, 1);
  assertEquals(findComponents(root, "Row", "5").length, 1);
  assertEquals(findComponents(root, "Row", 7).length, 1);
  assertEquals(findComponents(root, "Row", "7").length, 1);
  assertEquals(findComponents(root, "Row", 6).length, 0);
  assertEquals(findComponents(root, "Row").length, 2);
});
