// `am trigger <path> press "Enter"` on a visible, focusable <input>.
//
// A field report (report 5 §6) had this refused. It is not refused now — but
// "I could not reproduce it" is not a fix, and an unreproducible report whose
// shape nobody pinned is one release away from coming back. So the two layers
// it passes through are asserted end to end, against the SAME functions the
// CLI calls: the chord parser that turns the positional into a key, and the
// trigger engine that `am trigger` and `testUI` share.
//
// What makes this worth having: the guards in `assertOperable` are deliberately
// strict — a disabled, readonly, hidden or non-text-holding element refuses,
// because a harness more permissive than a browser manufactures green tests. A
// strict guard is exactly the kind that grows one condition too many, and an
// <input> that a user can plainly see and type into is the case that must
// never be caught by it.
import { assert, assertEquals } from "@std/assert";
import { testUI } from "../src/testing/ui-test.ts";
import { h } from "../src/air/vdom.ts";
import { runUITrigger } from "../src/air/ui-remote.ts";
import { parseChord } from "../src/am/am-cmd-inspect.ts";
import { assertOperable } from "../src/air/ui-trigger.ts";

Deno.test("the CLI turns the positional into a key, chords and all", () => {
  // `am trigger p press "Enter"` — the plain case the report used.
  assertEquals(parseChord("Enter"), { key: "Enter", mods: undefined });
  assertEquals(parseChord("ctrl+Enter"), {
    key: "Enter",
    mods: { ctrlKey: true },
  });
  assertEquals(parseChord("cmd+shift+k"), {
    key: "k",
    mods: { metaKey: true, shiftKey: true },
  });
  // The literal `+` key (zoom in) — splitting on "+" swallows it.
  assertEquals(parseChord("+").key, "+");
  assertEquals(parseChord("ctrl++"), { key: "+", mods: { ctrlKey: true } });
  // Nothing typed: the command defaults to Enter at the call site, and an
  // empty chord must not silently become a keypress of "".
  assertEquals(parseChord("").key, "");
});

Deno.test("press Enter on a visible input reaches the app's handler", async () => {
  let submitted = 0;
  let lastKey = "";
  const App = () =>
    h(
      "form",
      { onSubmit: () => submitted++ },
      h("input", {
        "aria-label": "Search",
        type: "text",
        onKeyDown: (e: { key: string }) => {
          lastKey = e.key;
        },
      }),
    );
  await using ui = await testUI(App);
  await ui.settle();

  const r = await runUITrigger({
    path: "App:SearchInput",
    action: "press",
    key: "Enter",
  }) as { ok: boolean; error?: string };
  assertEquals(
    r.ok,
    true,
    `a visible, focusable <input> refused a keypress: ${r.error}`,
  );
  assertEquals(lastKey, "Enter", "the key never reached the app's handler");
  assert(submitted > 0, "Enter in a single-field form must submit it");
});

Deno.test("the operability guard does not catch a plain text input", () => {
  // Straight at the guard, with the element shape the report had. `text: true`
  // is the strictest form of the check — the one `type` uses.
  const el = {
    tagName: "INPUT",
    // nodeType matters: hiddenReason walks ancestors only while
    // `node.nodeType === 1`, so a stub without it skips the whole visibility
    // check and the "it still catches what it should" half below passes
    // vacuously.
    nodeType: 1,
    type: "text",
    disabled: false,
    readOnly: false,
    hidden: false,
    style: {},
    parentElement: null,
    getAttribute: () => null,
  };
  assertOperable(el as never, "press a key on", { name: "SearchInput" });
  assertOperable(el as never, "type into", { write: true, text: true });

  // …and it still catches what a user genuinely cannot do, so the silence
  // above means "allowed", not "the guard stopped working".
  for (
    const [bad, why] of [
      [{ ...el, disabled: true }, "disabled"],
      [{ ...el, hidden: true }, "hidden"],
      [{ ...el, type: "hidden" }, 'type="hidden"'],
    ] as const
  ) {
    let threw = false;
    try {
      assertOperable(bad as never, "press a key on");
    } catch {
      threw = true;
    }
    assert(threw, `the guard let a ${why} element through`);
  }
});

Deno.test("press Enter does not submit when keydown was preventDefault'd", async () => {
  let submitted = 0;
  const App = () =>
    h(
      "form",
      { onSubmit: () => submitted++ },
      h("input", {
        "aria-label": "Pick",
        type: "text",
        onKeyDown: (e: { key: string; preventDefault: () => void }) => {
          if (e.key === "Enter") e.preventDefault();
        },
      }),
    );
  await using ui = await testUI(App);
  await ui.settle();
  const r = await runUITrigger({
    path: "App:PickInput",
    action: "press",
    key: "Enter",
  }) as { ok: boolean; error?: string };
  assertEquals(r.ok, true, r.error);
  assertEquals(submitted, 0, "preventDefault'd Enter must not submit the form");
});
