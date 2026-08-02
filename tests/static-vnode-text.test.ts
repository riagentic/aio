// Regression: an element with bare string/number children must NOT be marked
// `_static`. In AIR's direct-cell-access model a text child like
// `{sol.toFixed(9)}` is a plain evaluated string with no signal binding — it is
// indistinguishable from a literal, yet it changes every render. Marking such
// elements static let the `_static` diff short-circuit reconcile the subtree
// against a stale/emptied `_dom`, freezing the rendered text at its mount value
// (the a field report "SOL balance never updates in the account list" bug, reproduced
// only in a real browser under concurrent parent+child re-renders). Elements
// whose children are all real static VNodes (icons / static markup, no text)
// must still be static so the optimization survives where it is sound.

import { assert } from "jsr:@std/assert";
import { h } from "../src/air/vdom.ts";

Deno.test("element with a text child is NOT static (text may be dynamic)", () => {
  const v = h("div", null, "42.000000000 SOL");
  assert(!v._static, "a text-bearing element must not be _static");
});

Deno.test("element with number child is NOT static", () => {
  const v = h("span", null, 42);
  assert(!v._static, "a number-bearing element must not be _static");
});

Deno.test("element with mixed text + element children is NOT static", () => {
  const v = h("div", null, h("b", { class: "x" }), "text");
  assert(!v._static, "mixed children with any text must not be _static");
});

Deno.test("element with only static element children IS static (optimization preserved)", () => {
  const inner = h("path", { d: "M0 0" });
  const v = h("svg", { viewBox: "0 0 1 1" }, inner);
  assert(
    inner._static,
    "leaf element with static props + no children is static",
  );
  assert(
    v._static,
    "element whose only children are static VNodes stays static",
  );
});

Deno.test("empty element IS static", () => {
  const v = h("br", null);
  assert(v._static, "childless element with static props is static");
});
