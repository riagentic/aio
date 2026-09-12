// Mount-time rehydration was racy, and the race was silent.
//
// `mount()` is synchronous. A component that rehydrates on mount — an
// `onMount` that dispatches, a `resource` that fetches, a `useLocal` that
// restores — has that work IN FLIGHT when the test body starts, so whether the
// first assertion saw the before or the after came down to how many
// microtasks the harness happened to have spent. One repo measured ~40% flake
// (report 8 §11), and the answer until now was a house rule plus a comment
// on every affected test — which is a rule enforced by remembering, i.e. not
// enforced.
//
// `testUI` now settles once before handing the UI over, so the first
// observation is always of a mounted, quiesced app.
import { assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testUI } from "../src/cell-test.ts";
import { h } from "../src/air/vdom.ts";
import { onMount } from "../src/air/renderer-lifecycle.ts";

// deno-lint-ignore no-explicit-any
type D = any;

const hydrating = cell("rehydrate", {
  state: { loaded: false, rows: [] as string[] },
  methods: {
    // ASYNC, and slower than the harness's own INCIDENTAL waiting.
    //
    // The delay is 400ms because that is what was measured, not chosen. A
    // synchronous `onMount` dispatch lands before the test body whether or not
    // the mount settles — and so do 0ms, 25ms, 100ms and 200ms, because the
    // mount path already spans that long on its dynamic imports. A test built
    // on any of those passes BOTH ways and asserts nothing, which is exactly
    // the shape this repo keeps catching in its own suite. At 400ms it
    // discriminates: red without the mount settle, green with it.
    //
    // That incidental window is also the point of the fix. A guarantee that
    // holds because the harness happens to be slow enough is one that any
    // refactor can take away silently — which is what "racy AND silent"
    // meant. The wait is now on purpose.
    //
    // On a faster machine the incidental window shrinks and this still passes;
    // on a slower one it may stop DISCRIMINATING, but it never goes falsely
    // red.
    async load(s: { loaded: boolean; rows: string[] }) {
      await new Promise((r) => setTimeout(r, 400));
      s.loaded = true;
      s.rows = ["a", "b", "c"];
    },
  },
} as D);

/** The shape every affected app had: the component asks for its data on
 *  mount, and the answer arrives a tick later. */
function Rehydrating() {
  onMount(() => {
    // Fire-and-forget, as an app does: the render does not await its own data.
    void (hydrating as D).load();
  });
  return h(
    "div",
    { class: "panel" },
    h("span", { t: "status" }, (hydrating as D).loaded ? "ready" : "loading"),
    h("span", { t: "count" }, String((hydrating as D).rows.length)),
  );
}

// `testUI` registers its own `Deno.test`, so these are module-scope calls.

// No `await ui.settle()` anywhere below, on purpose — that is exactly the line
// a house rule asks people to remember, and these fail without the fix.
testUI(
  Rehydrating as D,
  "the FIRST assertion after testUI sees the rehydrated app",
  (ui: D) => {
    assertEquals(ui.status.text, "ready");
    assertEquals(ui.count.text, "3");
  },
);

testUI(
  Rehydrating as D,
  "…and it is not luck: the cell really ran its method",
  async (ui: D) => {
    await ui.expectCell(hydrating, (s: D) => s.loaded === true);
    assertEquals((hydrating as D).rows.length, 3);
  },
);

// The settle must not change what a plain mount looks like.
const Plain = () => h("div", null, h("span", { t: "v" }, "static"));
testUI(
  Plain as D,
  "a component that does NOT rehydrate is unaffected",
  (ui: D) => {
    assertEquals(ui.v.text, "static");
  },
);
