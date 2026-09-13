// The list of addressable names must be reachable WITHOUT provoking a failure.
//
// It existed all along: a miss prints `available: …`, so "what can I address?"
// was answered by asking for something that is not there (report 6 §5a). That is
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

/** A CHILD COMPONENT, and two of it.
 *
 *  The fixture above has none, which is why the agreement test below could not
 *  see half of what it claims to check: a miss lists child COMPONENT names
 *  (`Row ×2 — use Row2 …`) as well as element names, and with no children in
 *  the tree that half never appeared. It also means no path here ever had a
 *  `#2` ordinal in it, so nothing proved an ordinal path was addressable. */
function Row(props: { n: number }) {
  return (
    <div class="row">
      <button type="button">Delete{props.n}</button>
    </div>
  );
}

function Nested() {
  return (
    <div class="panel">
      <input type="text" aria-label="Search" />
      <Row n={1} />
      <Row n={2} />
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

Deno.test("uiNames(ui): EVERY path it returns is one ui[…] accepts", async () => {
  // The list is documented as "the same form `am trigger` takes". `ui[…]`
  // refused all of it — `ui["Panel:SearchInput"]` answered "no component or
  // element named …" — so the discovery list this very harness produces was
  // not usable in it, and the doc page teaches `uiNames(ui)` beside a
  // `testUI` example. Nothing caught it because the old check only compared
  // the part AFTER the last colon, which is exactly the part that was never
  // the problem.
  await using ui = await testUI(Nested);
  await ui.settle();
  const names = uiNames(ui);
  assertEquals(names.length, 3, "one input and two delete buttons");
  assert(
    names.some((n) => n.includes("#2")),
    `no ordinal path in ${names.join(", ")} — the fixture must have two of ` +
      `the same component, or the ordinal half is untested`,
  );
  for (const n of names) {
    // deno-lint-ignore no-explicit-any
    const handle = (ui as any)[n];
    assert(
      handle && typeof handle.text === "string",
      `uiNames listed "${n}" and ui["${n}"] does not resolve to an element`,
    );
  }
  // …and the path disambiguates, which a bare name cannot: two Delete buttons
  // live under two Rows, and each path reaches its own one.
  // deno-lint-ignore no-explicit-any
  const a = (ui as any)["Nested/Row:Delete1Button"].text;
  // deno-lint-ignore no-explicit-any
  const b = (ui as any)["Nested/Row#2:Delete2Button"].text;
  assertEquals([a, b], ["Delete1", "Delete2"]);
});

Deno.test("uiNames(ui): the list AGREES with what a miss reports as available", async () => {
  // Two producers of one fact is how they come to disagree. If a miss can see a
  // name that `names()` cannot, the discovery list is quietly incomplete.
  //
  // They report different SCOPES on purpose — `names()` gives the full
  // `Component:Element` path an `am trigger` takes, a miss lists the names
  // relative to the component it searched — so the comparison is on the last
  // segment, which is the part both are naming.
  // The NESTED fixture, not the flat one. With no child components in the
  // tree, the component half of a miss listing never appeared, so this test
  // compared elements against elements and called that agreement.
  await using ui = await testUI(Nested);
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
  // A miss lists TWO kinds of thing, and they are addressed differently:
  //   • an ELEMENT, by name — and `uiNames` carries it as the last segment of
  //     a path;
  //   • a child COMPONENT, by name or ordinal (`Row ×2 — use Row2 …`), which
  //     `uiNames` does NOT list, because its documented shape is
  //     `Component…:Element` and a component is not one.
  // So the agreement to check is: every ELEMENT a miss offers is in the list,
  // and every COMPONENT it offers is reachable the way the miss says.
  const components: string[] = [];
  const elements: string[] = [];
  for (const a of available) {
    const m = /^(\w+) ×\d+/.exec(a);
    if (m) components.push(m[1]!);
    else if (fromNames.includes(a)) elements.push(a);
    else components.push(a); // a single child component, listed bare
  }
  assert(
    components.length > 0,
    `the miss offered no component at all (${available.join(", ")}) — the ` +
      `fixture must nest one, or this half is not being checked`,
  );
  for (const a of elements) {
    assert(
      fromNames.includes(a),
      `a miss offers element "${a}" but uiNames(ui) does not list it — two ` +
        `producers of one fact, and they already disagree`,
    );
  }
  for (const c of components) {
    // deno-lint-ignore no-explicit-any
    const handle = (ui as any)[c];
    assert(
      handle,
      `a miss offers component "${c}" and ui.${c} does not resolve`,
    );
    // …and `uiNames` names it too, as the PREFIX of the paths under it, which
    // is how a reader discovers a component from the list.
    assert(
      uiNames(ui).some((n) => n.includes(`${c}:`) || n.includes(`${c}#`)),
      `component "${c}" appears nowhere in uiNames(ui), not even as a path ` +
        `prefix — it is undiscoverable without provoking a miss`,
    );
  }
  assertEquals(
    elements.length + components.length,
    available.length,
    "not every name was compared",
  );
});

Deno.test("uiNames(): a handle with no name list answers empty, not by throwing", () => {
  // "No names yet" is the honest answer to asking early — before a mount, or
  // against a handle that predates the feature. Throwing would make discovery
  // itself a failure, which is the shape being removed.
  // deno-lint-ignore no-explicit-any
  assertEquals(uiNames({} as any), []);
});
