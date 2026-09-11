import { assertEquals } from "@std/assert";
import { h } from "../src/air/vdom.ts";
import { testUI } from "../src/testing/ui-test.ts";

// A nested component with a t-handled input, two levels deep.
function Inner() {
  return h("div", null, h("input", { t: "watch-pubkey", value: "" }));
}
function Middle() {
  return h("div", null, h(Inner, null));
}
function App() {
  return h("div", null, h("h1", null, "T"), h(Middle, null));
}

Deno.test("t-handle hoists to top level regardless of nesting", async () => {
  const ui = await testUI(App);
  await ui.settle();
  // Previously required ui.find("...", n)[...]; now just ui["watch-pubkey"].
  await ui["watch-pubkey"].type("abc");
  assertEquals(ui["watch-pubkey"].value, "abc");
  await ui.dispose();
});
