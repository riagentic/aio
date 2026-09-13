// Two claims the kit made and did not keep.
//
// 1. "Deterministic per component INSTANCE" — `nextId()`'s own doc comment,
//    next to a bare module counter incremented from a component BODY. A body
//    runs on every render, so every re-render handed out a NEW id:
//    `aria-controls` pointed at an id that no longer existed, a RadioGroup's
//    shared `name` changed under the browser (which is what makes arrow keys
//    work within a group), and the server's id disagreed with the client's on
//    hydration — the exact failure the comment promised not to have.
//
// 2. Arrow keys on `<Tabs>`. Roving focus looked the next tab up with
//    `CSS.escape` — a bare global that does not exist outside a browser — so
//    under `testUI` the whole handler threw `CSS is not defined`. The
//    framework CONTAINS handler errors so production keeps rendering, which
//    means the arrow keys simply did nothing, with no error anywhere.
import { assert, assertEquals } from "@std/assert";
import { testUI } from "../src/testing/ui-test.ts";
import { h } from "../src/air/vdom.ts";
import { RadioGroup, Tabs } from "../src/ui/controls.ts";
import { signal } from "../src/state/signal.ts";

const bump = signal(0);

const Page = () =>
  h("div", null, [
    // Something that changes, so the component re-renders.
    h("span", null, [String(bump.value)]),
    h(Tabs as never, {
      label: "Sections",
      tabs: [
        { id: "one", label: "One", panel: h("p", null, ["1"]) },
        { id: "two", label: "Two", panel: h("p", null, ["2"]) },
      ],
    }),
    h(RadioGroup as never, {
      label: "Size",
      options: [
        { value: "s", label: "S" },
        { value: "m", label: "M" },
      ],
    }),
  ]);

// `testUI` registers its own Deno.test, so the capture is installed here.
const WARNS: string[] = [];
const _origWarn = console.warn;
console.warn = (...a: unknown[]) => {
  WARNS.push(a.map(String).join(" "));
  _origWarn(...a);
};

testUI(
  Page as never,
  "kit ids survive a re-render, arrows work",
  async (ui) => {
    await ui.settle();
    // deno-lint-ignore no-explicit-any
    const doc = ui.document as any;
    const tabIds = () =>
      Array.from(doc.querySelectorAll('[role="tab"]')).map(
        // deno-lint-ignore no-explicit-any
        (e: any) => e.id as string,
      );
    const radioNames = () =>
      Array.from(doc.querySelectorAll('input[type="radio"]')).map(
        // deno-lint-ignore no-explicit-any
        (e: any) => e.getAttribute("name") as string,
      );

    const tabsBefore = tabIds();
    const radiosBefore = radioNames();
    assertEquals(tabsBefore.length, 2, "two tabs rendered");
    assertEquals(radiosBefore.length, 2, "two radios rendered");
    assert(
      radiosBefore[0] === radiosBefore[1],
      "a radio group shares ONE name, or the browser will not treat it as a group",
    );

    // Force a re-render that changes nothing about the controls themselves.
    bump.set(1);
    await ui.settle();
    bump.set(2);
    await ui.settle();

    assertEquals(
      tabIds(),
      tabsBefore,
      "a tab's id must not change when the component re-renders — " +
        "`aria-controls` points at it",
    );
    assertEquals(
      radioNames(),
      radiosBefore,
      "a radio group's shared name must not change when it re-renders",
    );

    // ── the arrow keys ────────────────────────────────────────────────────
    const before = WARNS.length;
    // deno-lint-ignore no-explicit-any
    const win = ui.window as any;
    const first = doc.querySelectorAll('[role="tab"]')[0];
    first.dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    await ui.settle();

    assertEquals(
      WARNS.slice(before).filter((w) => /CSS is not defined/.test(w)).length,
      0,
      "the keydown handler must not depend on a global the runtime may not have",
    );
    const selected = Array.from(doc.querySelectorAll('[role="tab"]')).filter(
      // deno-lint-ignore no-explicit-any
      (e: any) => e.getAttribute("aria-selected") === "true",
    );
    assertEquals(selected.length, 1, "exactly one tab is selected");
    assertEquals(
      // deno-lint-ignore no-explicit-any
      (selected[0] as any).id,
      tabsBefore[1],
      "ArrowRight moves the selection to the SECOND tab",
    );
  },
);
