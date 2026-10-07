// Every testUI mount gets its dev audits — an app with no cells too.
//
// The renderer's audit memories (the contrast walk's throttle and its
// reported pairs, the selector and untracked-read dedups) were forgotten at
// mount only inside `if (cells.length > 0)`. A cell-less App mounted within
// the walk's 750 ms throttle of the previous mount was therefore never
// walked: its unreadable text passed in a suite and was reported alone, and a
// harness more lenient than the browser is the one thing testUI may not be.
import { assertEquals } from "@std/assert";
import { h } from "../src/air/vdom.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { signal } from "../src/state/signal.ts";
import { getRegisteredCells } from "../src/state/cell-reactive.ts";

const page = (ink: string) => () =>
  h("div", { class: "app" }, [
    h("style", null, [
      `body { background-color: #ffffff } .t { color: ${ink}; background-color: #ffffff }`,
    ]),
    h("span", { class: "t" }, ["text"]),
  ]);

Deno.test("testUI: a cell-less mount right after another still gets its contrast walk", async () => {
  assertEquals(getRegisteredCells().size, 0, "premise: no cells in this file");
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => warns.push(a.map(String).join(" "));
  // The walk's throttle reads `Date.now()`. Held still, every mount below is
  // at the same instant as the one before it — inside the 750 ms window on a
  // machine of any speed (measured against the wall clock, the premise failed
  // on a loaded Windows run, where three mounts took longer than that).
  const realNow = Date.now;
  const at = realNow();
  Date.now = () => at;
  try {
    {
      await using ui = await testUI(page("#111111") as never);
      await ui.settle();
    }
    assertEquals(warns.filter((w) => w.includes("unreadable")), []);
    // The same defect twice: the second mount is inside the first's throttle
    // window, and the third must not be muted by the second having said it.
    for (const nth of ["second", "third"]) {
      warns.length = 0;
      await using ui = await testUI(page("#eeeeee") as never);
      await ui.settle();
      assertEquals(
        warns.filter((w) => w.includes("unreadable")).length,
        1,
        `the ${nth} mount's #eeeeee on #ffffff was not reported:\n` +
          warns.join("\n"),
      );
    }
  } finally {
    Date.now = realNow;
    console.warn = orig;
  }
});

// The renderer's own once-only dev warnings (`_devWarn`: duplicate keys, a
// hydration mismatch, a lost text position…) are remembered per PROCESS —
// right for a dev session, and under testUI the same trap as above: the
// second test to make the same mistake heard nothing about it.
Deno.test("testUI: a renderer dev warning is said again on the next mount", async () => {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => warns.push(a.map(String).join(" "));
  // The check runs where keys are USED — a diff — so the list re-renders.
  const tick = signal(0);
  const Dup = () =>
    h("ul", { "data-n": tick.value }, [
      h("li", { key: "k" }, ["a"]),
      h("li", { key: "k" }, ["b"]),
    ]);
  try {
    for (const nth of ["first", "second"]) {
      warns.length = 0;
      await using ui = await testUI(Dup as never);
      tick.set(tick.peek() + 1);
      await ui.settle();
      assertEquals(
        warns.filter((w) => w.includes('Duplicate key "k"')).length,
        1,
        `the ${nth} mount's duplicate key:\n` + warns.join("\n"),
      );
    }
  } finally {
    console.warn = orig;
  }
});
