import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { h } from "../src/air/vdom.ts";
import { cell } from "../src/state/cell-create.ts";
import { testUI } from "../src/testing/ui-test.ts";

const edition = cell("editionrt", {
  state: { tier: 2, base: 10 },
  methods: { setTier(s: {tier:number;base:number}, t: number) { s.tier = t; } },
  selectors: { accountLimit: (s: { tier: number; base: number }) => s.base * s.tier },
});

Deno.test("selector is bound + computes at runtime", async () => {
  const ui = await testUI(() => h("div", null, ""), { document: new Window().document as any });
  assertEquals((edition as any).accountLimit(), 20); // 10 * 2
  await (edition as any).setTier(5);
  await ui.settle();
  assertEquals((edition as any).accountLimit(), 50); // 10 * 5 — recomputes
  await ui.dispose();
});
