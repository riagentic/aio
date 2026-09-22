// The duplicate-`t` report used to see ONE component at a time: `taken` is
// built fresh per component, so `t="save"` in two DIFFERENT components was
// reported nowhere. The author heard about it only later — and only if
// resolution happened to become ambiguous — as a throw at use time, in a test
// that had passed before (a field report).
//
// The scope of the report is the whole surface now, for AUTHOR-WRITTEN handles
// only. The silent cases below are the point of the pair: generated ordinals
// are a within-component count and must keep restarting per component, and one
// `t` written once on a component that renders N times is correct code. A gate
// that fires on those would be as bad as one that never fires.
import { assert, assertEquals } from "@std/assert";
import { h } from "../src/air/vdom.ts";
import type { ComponentFn } from "../src/air/vdom.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { _resetSurfaceWarnings } from "../src/air/ui-surface.ts";

/** Mount `App`, returning every `[aio:ui] duplicate t=` line it provoked. */
async function duplicateWarnings(
  App: ComponentFn,
  after?: (ui: Awaited<ReturnType<typeof testUI>>) => void | Promise<void>,
): Promise<string[]> {
  _resetSurfaceWarnings();
  const lines: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  let ui;
  try {
    ui = await testUI(App);
    await after?.(ui);
    return lines.filter((l) => l.includes("duplicate t="));
  } finally {
    console.warn = orig;
    await ui?.dispose();
    _resetSurfaceWarnings();
  }
}

Deno.test("surface: the same explicit t= in TWO components is reported", async () => {
  const Toolbar = () => h("button", { t: "save", onClick: () => {} }, "Save");
  const Sidebar = () => h("button", { t: "save", onClick: () => {} }, "Store");
  const App = () => h("div", null, h(Toolbar, null), h(Sidebar, null));
  const warns = await duplicateWarnings(App as ComponentFn);
  assertEquals(warns.length, 1, warns.join("\n"));
  const w = warns[0]!;
  assert(w.includes('duplicate t="save"'), w);
  // It must say WHERE — the two components — and what actually goes wrong.
  assert(w.includes("Toolbar"), w);
  assert(w.includes("Sidebar"), w);
  assert(w.includes("ambiguous"), w);
});

Deno.test("surface: a duplicate explicit t= across components is reported ONCE", async () => {
  const A = () => h("button", { t: "go", onClick: () => {} }, "A");
  const B = () => h("button", { t: "go", onClick: () => {} }, "B");
  const App = () => h("div", null, h(A, null), h(B, null));
  // Several observations => several surface walks; the report is per name.
  const warns = await duplicateWarnings(App as ComponentFn, async (ui) => {
    await ui.settle();
    ui.surface();
    ui.surface();
    await ui.settle();
  });
  assertEquals(warns.length, 1, warns.join("\n"));
});

Deno.test("surface: DIFFERENT explicit handles in two components stay silent", async () => {
  const Toolbar = () => h("button", { t: "save", onClick: () => {} }, "Save");
  const Sidebar = () => h("button", { t: "load", onClick: () => {} }, "Load");
  const App = () => h("div", null, h(Toolbar, null), h(Sidebar, null));
  const warns = await duplicateWarnings(App as ComponentFn, async (ui) => {
    await ui.settle();
    ui.surface();
  });
  assertEquals(warns, [], warns.join("\n"));
});

Deno.test("surface: the same GENERATED name in two components stays silent", async () => {
  // No `t` anywhere: both buttons are named "SubmitButton" by their label, in
  // their own component. That is the ordinal counter doing its job.
  const Left = () => h("button", { onClick: () => {} }, "Submit");
  const Right = () => h("button", { onClick: () => {} }, "Submit");
  const App = () => h("div", null, h(Left, null), h(Right, null));
  const warns = await duplicateWarnings(App as ComponentFn, async (ui) => {
    await ui.settle();
    const s = ui.surface();
    // Both really are on the surface under the same generated name.
    assertEquals(
      s.children.flatMap((c) => c.elements.map((e) => e.name)),
      ["SubmitButton", "SubmitButton"],
    );
  });
  assertEquals(warns, [], warns.join("\n"));
});

Deno.test("surface: one t= on a component rendered N times stays silent", async () => {
  // A list row's handle is ONE name the author wrote once — addressed per
  // instance, never at the top level. Warning here would fire on correct code.
  const Row = (p: { label: string }) =>
    h("button", { t: "del", onClick: () => {} }, p.label);
  const App = () =>
    h(
      "div",
      null,
      h(Row as ComponentFn, { key: 1, label: "a" }),
      h(Row as ComponentFn, { key: 2, label: "b" }),
      h(Row as ComponentFn, { key: 3, label: "c" }),
    );
  const warns = await duplicateWarnings(App as ComponentFn, async (ui) => {
    await ui.settle();
    ui.surface();
  });
  assertEquals(warns, [], warns.join("\n"));
});

Deno.test("surface: a duplicate t= WITHIN one component keeps its own wording", async () => {
  // The per-component report is unchanged: there, the second element really is
  // renamed, and the message names the address it got.
  const App = () =>
    h(
      "div",
      null,
      h("button", { t: "save", onClick: () => {} }, "A"),
      h("button", { t: "save", onClick: () => {} }, "B"),
    );
  const warns = await duplicateWarnings(App as ComponentFn);
  assertEquals(warns.length, 1, warns.join("\n"));
  assert(warns[0]!.includes('addressable as "save2"'), warns[0]!);
});
