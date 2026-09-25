// A browser shows what author CSS shows: `visibility` inherits but a child may
// override it (a `visibility:visible` child of a `visibility:hidden` parent is
// painted and takes events), and `[hidden]` is only the UA `display:none`,
// which an author `display` beats. The harness must not refuse either — while
// still refusing the genuinely hidden cases next to them.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { testUI } from "../src/testing/ui-test.ts";

const fired: string[] = [];

function Panel() {
  return (
    <div>
      <style>{".flex{display:flex}"}</style>
      <div style="visibility:hidden">
        <button
          type="button"
          t="Shown"
          style="visibility:visible"
          onMouseEnter={() => fired.push("shown:hover")}
          onFocus={() => fired.push("shown:focus")}
          onClick={() => fired.push("shown:click")}
        >
          shown
        </button>
        <button type="button" t="Ghost" onClick={() => fired.push("ghost")}>
          ghost
        </button>
      </div>
      <button
        type="button"
        t="Inline"
        hidden
        style="display:block"
        onClick={() => fired.push("inline:click")}
      >
        inline
      </button>
      <button
        type="button"
        t="Classed"
        hidden
        class="flex"
        onMouseEnter={() => fired.push("classed:hover")}
      >
        classed
      </button>
      <button
        type="button"
        t="Plain"
        hidden
        onClick={() => fired.push("plain")}
      >
        plain
      </button>
    </div>
  );
}

testUI(
  Panel,
  "visibility override and author display on [hidden] are operable, the rest refused",
  async (ui) => {
    fired.length = 0;
    ui.Shown.hover();
    ui.Shown.focus();
    ui.Shown.click();
    ui.Inline.click();
    ui.Classed.hover();
    await ui.settle();
    assertEquals(fired, [
      "shown:hover",
      "shown:focus",
      "shown:click",
      "inline:click",
      "classed:hover",
    ]);
    for (
      const [act, want] of [
        [() => ui.Ghost.click(), "visibility: hidden"],
        [() => ui.Plain.click(), "`hidden` attribute"],
      ] as const
    ) {
      let err = "";
      try {
        act();
        await ui.settle();
      } catch (e) {
        err = String(e);
      }
      assertStringIncludes(err, want);
    }
    assertEquals(fired.length, 5);
  },
);
