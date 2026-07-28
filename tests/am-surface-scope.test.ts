// llama.md, second update #2 + wishlist #3: "`am surface` has no way to scope
// the tree. One page of my app is a 32 KB single-line JSON blob, and I want one
// component out of it. I ended up piping into Python to walk the tree — again,
// the same shape of problem as the `--json` one, except this time the flag really
// does not exist."
//
// `am` is the framework's best debugging tool; this was the one place it made
// someone write a script. Scoping happens client-side so it behaves identically
// for a live client and the headless server render.
import { assertEquals } from "@std/assert";
import { _scope } from "../src/am/am-cmd-inspect.ts";

// A miniature of the shape that motivated this: a deep tree where the thing you
// want is one component among many.
const SURFACE = [{
  component: "App",
  path: "App",
  elements: [{ name: "save", tag: "button", events: ["click"] }],
  children: [
    {
      component: "Sidebar",
      path: "App/Sidebar",
      elements: [],
      children: [
        {
          component: "CtxControls",
          path: "App/Sidebar/CtxControls",
          elements: [{ name: "ctxSize", tag: "input", events: ["input"] }],
          children: [],
        },
      ],
    },
    {
      component: "Main",
      path: "App/Main",
      elements: [],
      children: [
        {
          component: "CtxControls",
          path: "App/Main/CtxControls",
          elements: [{ name: "ctxSize2", tag: "input", events: ["input"] }],
          children: [],
        },
      ],
    },
  ],
}];

Deno.test("surface --component: every instance, wherever it sits", () => {
  const got = _scope(SURFACE, { component: "CtxControls" });
  assertEquals(got.map((n) => n.path), [
    "App/Sidebar/CtxControls",
    "App/Main/CtxControls",
  ]);
  assertEquals(got[0]!.elements[0]!.name, "ctxSize", "subtree comes with it");
});

Deno.test("surface --path: one subtree by prefix", () => {
  const got = _scope(SURFACE, { path: "App/Main" });
  assertEquals(got.map((n) => n.path), ["App/Main"]);
  assertEquals(
    got[0]!.children.map((c) => c.component),
    ["CtxControls"],
    "the matched node keeps its children — that is the point of a subtree",
  );
});

Deno.test("surface --depth: cap the tree without losing the top", () => {
  assertEquals(
    _scope(SURFACE, { depth: 0 })[0]!.children,
    [],
    "depth 0 = this component only",
  );
  const d1 = _scope(SURFACE, { depth: 1 })[0]!;
  assertEquals(d1.children.map((c) => c.component), ["Sidebar", "Main"]);
  assertEquals(d1.children[0]!.children, [], "and no deeper");
});

Deno.test("surface: filters compose", () => {
  const got = _scope(SURFACE, { component: "Sidebar", depth: 1 });
  assertEquals(got.length, 1);
  assertEquals(got[0]!.children.map((c) => c.component), ["CtxControls"]);
  assertEquals(got[0]!.children[0]!.children, []);
});

Deno.test("surface: no filter returns the whole tree unchanged", () => {
  assertEquals(_scope(SURFACE, {}), SURFACE);
});
