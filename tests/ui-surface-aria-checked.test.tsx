// ARIA picker state must be readable on the testUI surface.
//
// From a field report (§6): a radio group built as
//
//   <button role="radio" aria-checked="true">Yes</button>
//
// left `ui.…Radio.checked` false because only native
// `<input type=checkbox|radio>` got `checked` from `el.checked`. Authors also
// reached for `.getAttribute` on a handle and got "no element named
// getAttribute" — the wrong question.
//
// Pinned here: ARIA radio/checkbox/switch report `checked` from `aria-checked`;
// `check()`/`uncheck()` drive those roles (a click); mixed collapses to false
// on `.checked` but survives on `.attr("aria-checked")`; native inputs still
// win; `.attr()` reads live attributes; a DOM antipattern name on a component
// path misses with the aimed message.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { cell } from "../mod.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { getSerializedSurfaces } from "../src/air/ui-remote.ts";
import type { UIElementInfo, UISurfaceNode } from "../src/air/ui-surface.ts";

const form = cell("surface-aria-checked", {
  state: {
    pick: "yes" as "yes" | "no",
    native: false,
    power: false,
    filter: "off" as "off" | "on" | "mixed",
  },
  methods: {
    setPick(s: { pick: "yes" | "no" }, v: "yes" | "no") {
      s.pick = v;
    },
    setNative(s: { native: boolean }, v: boolean) {
      s.native = v;
    },
    setPower(s: { power: boolean }, v: boolean) {
      s.power = v;
    },
    togglePower(s: { power: boolean }) {
      s.power = !s.power;
    },
    setFilter(
      s: { filter: "off" | "on" | "mixed" },
      v: "off" | "on" | "mixed",
    ) {
      s.filter = v;
    },
  },
});

function Picker() {
  return (
    <div role="radiogroup" t="picker">
      <button
        type="button"
        t="yes"
        role="radio"
        aria-checked={form.pick === "yes" ? "true" : "false"}
        data-on={form.pick === "yes" ? "1" : "0"}
        onClick={() => form.setPick("yes")}
      >
        Yes
      </button>
      <button
        type="button"
        t="no"
        role="radio"
        aria-checked={form.pick === "no" ? "true" : "false"}
        onClick={() => form.setPick("no")}
      >
        No
      </button>
    </div>
  );
}

function App() {
  return (
    <div>
      <Picker />
      <input
        t="native-box"
        type="checkbox"
        checked={form.native}
        aria-checked={form.native ? "false" : "true"}
        onChange={(e) =>
          form.setNative(
            (e.target as unknown as { checked: boolean }).checked,
          )}
      />
      <button
        t="power"
        type="button"
        role="switch"
        aria-checked={form.power ? "true" : "false"}
        onClick={() => form.togglePower()}
      >
        Power
      </button>
      <button
        t="filter"
        type="button"
        role="checkbox"
        aria-checked={form.filter === "on"
          ? "true"
          : form.filter === "mixed"
          ? "mixed"
          : "false"}
        onClick={() =>
          form.setFilter(
            form.filter === "off"
              ? "mixed"
              : form.filter === "mixed"
              ? "on"
              : "off",
          )}
      >
        Filter
      </button>
    </div>
  );
}

/** Find an element on a serialized surface tree by its `t` handle. */
function findEl(node: UISurfaceNode, name: string): UIElementInfo | undefined {
  const hit = node.elements.find((e) => e.name === name);
  if (hit) return hit;
  for (const c of node.children) {
    const deep = findEl(c, name);
    if (deep) return deep;
  }
  return undefined;
}

Deno.test("role=radio + aria-checked=true → handle and surface checked === true", async () => {
  await using ui = await testUI(App as never);
  await ui.settle();

  assertEquals(ui.yes.checked, true);
  assertEquals(ui.no.checked, false);

  for (
    const surface of [
      ui.surface() as UISurfaceNode,
      getSerializedSurfaces()[0]!,
    ]
  ) {
    assertEquals(findEl(surface, "yes")!.checked, true);
    assertEquals(findEl(surface, "no")!.checked, false);
  }
});

Deno.test("aria-checked=false → .checked === false", async () => {
  await using ui = await testUI(App as never);
  await ui.settle();
  // Mutate after mount — cells reset to defaults on each mount.
  form.setPick("no");
  await ui.settle();

  assertEquals(ui.yes.checked, false);
  assertEquals(ui.no.checked, true);
  assertEquals(findEl(ui.surface() as UISurfaceNode, "yes")!.checked, false);
});

Deno.test("native checkbox still wins over aria-checked (regression)", async () => {
  await using ui = await testUI(App as never);
  await ui.settle();
  form.setNative(true);
  await ui.settle();

  // Native el.checked is true; aria-checked is deliberately the opposite so a
  // wrong reader would flip the answer.
  assertEquals(ui["native-box"].checked, true);
  assertEquals(
    findEl(ui.surface() as UISurfaceNode, "native-box")!.checked,
    true,
  );
  assertEquals(ui["native-box"].attr("aria-checked"), "false");
});

Deno.test(".attr reads live attributes; missing → null", async () => {
  await using ui = await testUI(App as never);
  await ui.settle();

  assertEquals(ui.yes.attr("data-on"), "1");
  assertEquals(ui.yes.attr("aria-checked"), "true");
  assertEquals(ui.yes.attr("role"), "radio");
  assertEquals(ui.yes.attr("missing"), null);
});

Deno.test("accessing .getAttribute on a nested component path aims at the right question", async () => {
  await using ui = await testUI(App as never);
  await ui.settle();

  const err = assertThrows(() => {
    // Property access on a component path — the DOM antipattern authors reach
    // for instead of .attr() / state readers.
    void (ui.Picker as Record<string, unknown>).getAttribute;
  }) as Error;
  const m = err.message;

  assert(
    /"getAttribute" is not a testUI action or child/.test(m),
    `names the antipattern: ${m}`,
  );
  assert(
    m.includes('.attr("…")'),
    `points at .attr(): ${m}`,
  );
  assert(
    !/no element or component named "getAttribute"/.test(m),
    `not aimed at a missing child: ${m}`,
  );
});

Deno.test("role=switch: .checked reads aria-checked; check()/uncheck() drive it", async () => {
  await using ui = await testUI(App as never);
  await ui.settle();

  assertEquals(ui.power.checked, false);
  assertEquals(ui.power.attr("aria-checked"), "false");

  await ui.power.check();
  assertEquals(form.power, true, "check() must click an ARIA switch");
  assertEquals(ui.power.checked, true);
  assertEquals(ui.power.attr("aria-checked"), "true");

  // Idempotent — already on, no second toggle.
  await ui.power.check();
  assertEquals(form.power, true, "check() on an on switch is a no-op");

  await ui.power.uncheck();
  assertEquals(form.power, false);
  assertEquals(ui.power.checked, false);
});

Deno.test("aria-checked=mixed → .checked === false; .attr keeps mixed", async () => {
  await using ui = await testUI(App as never);
  await ui.settle();
  form.setFilter("mixed");
  await ui.settle();

  assertEquals(
    ui.filter.checked,
    false,
    "mixed collapses on the boolean field",
  );
  assertEquals(ui.filter.attr("aria-checked"), "mixed");
  assertEquals(
    findEl(ui.surface() as UISurfaceNode, "filter")!.checked,
    false,
  );
});

Deno.test("role=radio: check() selects the option (write path matches surface)", async () => {
  await using ui = await testUI(App as never);
  await ui.settle();
  form.setPick("no");
  await ui.settle();
  assertEquals(ui.yes.checked, false);

  await ui.yes.check();
  assertEquals(form.pick, "yes");
  assertEquals(ui.yes.checked, true);
  assertEquals(ui.no.checked, false);
});
