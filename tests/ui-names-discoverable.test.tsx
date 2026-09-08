// The list of addressable names must be reachable WITHOUT provoking a failure.
//
// It existed all along: a miss prints `available: …`, so "what can I address?"
// was answered by asking for something that is not there (anathomy §5a). That is
// a fine recovery path and a poor discovery one — and it is exactly the list an
// agent needs BEFORE it writes its first line, not after its first mistake.
//
// `uiNames(ui)` in a test, `am surface --names` on a live app: one answer, two
// places, same shape.
import { assert, assertEquals } from "@std/assert";
import { testUI, uiNames } from "../src/testing/ui-test.ts";

function Panel() {
  return (
    <div class="panel">
      <input type="text" aria-label="Search" />
      <button type="button">Save</button>
      <button type="button">Cancel</button>
    </div>
  );
}

Deno.test("uiNames(ui): the addressable paths, without provoking a miss", async () => {
  await using ui = await testUI(Panel);
  await ui.settle();

  const names = uiNames(ui);
  assert(Array.isArray(names), "names() must return an array");
  assert(names.length > 0, "a mounted surface with three controls named none");

  // The shape has to be the one `am trigger` takes — `<Component…:Element>` —
  // or the discovery list is a list you cannot act on.
  for (const n of names) {
    assert(
      n.includes(":") && n.split(":").pop()!.length > 0,
      `"${n}" is not in the <Component…:Element> form am trigger accepts`,
    );
  }
  assert(
    names.some((n) => n.endsWith("SaveButton")),
    `the Save button is addressable but not listed: ${names.join(", ")}`,
  );
  assert(
    names.some((n) => n.endsWith("CancelButton")),
    `the Cancel button is addressable but not listed: ${names.join(", ")}`,
  );
});

Deno.test("uiNames(ui): the list AGREES with what a miss reports as available", async () => {
  // Two producers of one fact is how they come to disagree. If a miss can see a
  // name that `names()` cannot, the discovery list is quietly incomplete.
  //
  // They report different SCOPES on purpose — `names()` gives the full
  // `Component:Element` path an `am trigger` takes, a miss lists the names
  // relative to the component it searched — so the comparison is on the last
  // segment, which is the part both are naming.
  await using ui = await testUI(Panel);
  await ui.settle();
  const fromNames = uiNames(ui).map((n) => n.split(":").pop()!).sort();

  let available: string[] = [];
  try {
    // deno-lint-ignore no-explicit-any
    (ui as any).NoSuchThingButton.click();
    await ui.settle();
  } catch (e) {
    const m = /available: ([^\n]+)/.exec(String(e));
    if (m) {
      available = m[1]!.split(",").map((x) => x.trim()).filter((x) =>
        x && x !== "(none)" && !x.startsWith("…")
      ).sort();
    }
  }
  // The miss MUST have produced a list — if it did not, this test proves
  // nothing and should say so rather than pass quietly.
  assert(
    available.length > 0,
    "the miss reported no `available:` list, so there was nothing to compare " +
      "— the comparison this test exists for did not happen",
  );
  let compared = 0;
  for (const a of available) {
    assert(
      fromNames.includes(a),
      `a miss offers "${a}" but uiNames(ui) does not list it — two producers ` +
        `of one fact, and they already disagree`,
    );
    compared++;
  }
  assertEquals(compared, available.length, "not every name was compared");
});

Deno.test("uiNames(): a handle with no name list answers empty, not by throwing", () => {
  // "No names yet" is the honest answer to asking early — before a mount, or
  // against a handle that predates the feature. Throwing would make discovery
  // itself a failure, which is the shape being removed.
  // deno-lint-ignore no-explicit-any
  assertEquals(uiNames({} as any), []);
});
