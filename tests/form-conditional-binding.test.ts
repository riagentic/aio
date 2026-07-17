// risoto 2026-07-16d: a conditional ELEMENT binding whose insertion anchor is
// a direct child of <form> froze at its mount-time value, while the same
// binding under any other container (and sibling text bindings in the same
// form) updated. These tests pin the fixed behavior across every shape in the
// report's repro matrix.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { Fragment, h } from "../src/air/vdom.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { cell } from "../mod.ts";

const flag = cell("form-cond-flag", {
  state: { n: 0 },
  methods: {
    inc(s) {
      s.n += 1;
    },
  },
});

// Child component with a fragment root wrapping a conditional (the exact
// shape from the report's Warn component).
function Warn() {
  return h(Fragment, null, flag.n === 0 && h("div", null, "WARN"));
}

function doc() {
  // deno-lint-ignore no-explicit-any
  return new Window().document as any;
}

Deno.test("conditional element binding under <div> re-reconciles (control)", async () => {
  const App = () =>
    h(
      "div",
      null,
      flag.n === 0 && h("div", null, "WARN"),
      h("span", null, String(flag.n)),
    );
  const ui = await testUI(App, { document: doc() });
  await ui.settle();
  assertEquals(ui.html().includes("WARN"), true);
  flag.inc();
  await ui.settle();
  assertEquals(
    ui.html().includes("WARN"),
    false,
    "div container must drop WARN",
  );
  await ui.dispose();
});

Deno.test("conditional element binding as direct <form> child re-reconciles", async () => {
  const App = () =>
    h(
      "form",
      null,
      flag.n === 0 && h("div", null, "WARN"),
      h("span", null, String(flag.n)),
    );
  const ui = await testUI(App, { document: doc() });
  await ui.settle();
  assertEquals(ui.html().includes("WARN"), true);
  flag.inc();
  await ui.settle();
  assertEquals(
    ui.html().includes("WARN"),
    false,
    "form container must drop WARN",
  );
  assertEquals(
    ui.html().includes("1"),
    true,
    "sibling text binding updates too",
  );
  await ui.dispose();
});

Deno.test("fragment-root component as direct <form> child re-reconciles", async () => {
  const App = () =>
    h("form", null, h(Warn, null), h("span", null, String(flag.n)));
  const ui = await testUI(App, { document: doc() });
  await ui.settle();
  assertEquals(ui.html().includes("WARN"), true);
  flag.inc();
  await ui.settle();
  assertEquals(
    ui.html().includes("WARN"),
    false,
    "fragment child of form must drop WARN",
  );
  await ui.dispose();
});

Deno.test("conditional flips back on (false → true) inside <form>", async () => {
  const App = () => h("form", null, flag.n === 1 && h("div", null, "SHOW"));
  const ui = await testUI(App, { document: doc() });
  await ui.settle();
  assertEquals(ui.html().includes("SHOW"), false);
  flag.inc();
  await ui.settle();
  assertEquals(
    ui.html().includes("SHOW"),
    true,
    "conditional must appear inside form",
  );
  await ui.dispose();
});
