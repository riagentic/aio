// The child-desync warning has to name a SITE, and it has to count.
//
// It said `<span> holds the wrong node at child 0`, keyed `child-desync-span` —
// one key for every `<span>` in the application. A field report's numbers say
// what that cost: ~180 spans across 25 components, so "a span, somewhere, at
// child 0" is not a lead, and they spent two hours bisecting a fuzz run by
// hand. Then they fixed NINE real shape instabilities in a row and the warning
// count stayed at exactly 1 the whole time, because the first silenced the
// rest — which reads as "nothing I did helped". A count that cannot move is
// not a diagnostic.
//
// And the message blamed the framework ("This is an aio bug; please report").
// Every cause they found was an app shape, and both are idiomatic JSX: a falsy
// conditional still occupies a sibling slot, and an empty string renders to NO
// node.
//
// WHY THIS DRIVES THE FUNCTION DIRECTLY. The first draft of this file mounted
// both reported shapes and watched for the warning. Neither reproduces — AIR
// handles them — so all three tests passed having asserted nothing, which is
// the exact failure they were written to prevent. The claims here are about the
// MESSAGE, not about when a desync happens, so the message is what is driven.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { _assertRegionAlignment } from "../src/air/vdom-diff.ts";
import { h } from "../src/air/vdom.ts";
import { _instanceStack } from "../src/air/renderer-state.ts";
import type { ComponentInstance } from "../src/air/renderer-types.ts";
import type { VNode } from "../src/air/vdom.ts";
import { setDevModeOverride } from "../src/state/dev-flag.ts";
import { setDevMode } from "../src/air/vdom-types.ts";

/** Report on a `<tag class=…>` inside `<Component>`, with a DOM that cannot
 *  align (the element is given a child region that is simply empty). */
async function warningsFor(
  tag: string,
  cls: string,
  component: string | undefined,
): Promise<string[]> {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const out: string[] = [];
  const real = console.warn;
  console.warn = (...a: unknown[]) => out.push(String(a[0]));
  if (component) {
    _instanceStack.push(
      { _component: component } as unknown as ComponentInstance,
    );
  }
  try {
    setDevModeOverride(true);
    const el = doc.createElement(tag);
    const vnode = h(tag, { class: cls }, "text-child") as VNode;
    // `first` is null: the region has no DOM at all, so the very first child
    // "ran out of DOM nodes" — the shortest path to the reporter.
    _assertRegionAlignment(vnode, null, true);
    void el;
  } finally {
    if (component) _instanceStack.pop();
    console.warn = real;
    // AWAITED. `void closeWindow(win)` left the macrotask turn it schedules
    // running past the end of the test, and the sanitizers called it what it
    // is: "a timer was started in this test, but never completed". Passed in
    // isolation, failed in the suite — the shape a targeted run cannot see.
    await closeWindow(win);
  }
  return out.filter((w) => w.includes("child reconciler desynced"));
}

Deno.test("child-desync: the warning names the class and the component", async () => {
  setDevMode(false); // clears the once-per-site dedup set
  const warns = await warningsFor("span", "ptab__sub", "ProjectTab");
  assertEquals(warns.length, 1, `the reporter must fire: ${warns.join("|")}`);
  assert(
    warns[0]!.includes('class="ptab__sub"'),
    `"a span, somewhere" is not a lead: ${warns[0]}`,
  );
  assert(
    warns[0]!.includes("inside <ProjectTab>"),
    `the enclosing component is on the instance stack: ${warns[0]}`,
  );
});

Deno.test("child-desync: the message names the APP shapes, not 'an aio bug'", async () => {
  setDevMode(false); // clears the once-per-site dedup set
  const m = (await warningsFor("span", "x", "Any"))[0]!;
  assert(m.includes("cond &&"), `the conditional-sibling shape: ${m}`);
  assert(m.includes('v === ""'), `the empty-string shape: ${m}`);
  assert(
    m.includes("If neither applies"),
    `an unconditional "this is an aio bug" sends the author to file an issue ` +
      `about their own child shape: ${m}`,
  );
});

Deno.test("child-desync: two different sites are two findings, not one", async () => {
  setDevMode(false); // clears the once-per-site dedup set
  // The property that turns the count into a progress bar. Keyed on the tag
  // alone, the second site was silent — so nine fixes read as zero progress.
  const a = await warningsFor("span", "alpha", "CompA");
  const b = await warningsFor("span", "beta", "CompB");
  const again = await warningsFor("span", "alpha", "CompA");
  assertEquals(a.length, 1, "first site reports");
  assertEquals(
    b.length,
    1,
    "a differently-classed site in another component too",
  );
  assertEquals(again.length, 0, "…and the SAME site still reports only once");
});
