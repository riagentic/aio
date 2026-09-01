// A key that belongs to no element.
//
// `onGlobalKey` — the primitive for "Escape closes the lightbox", "⌘K opens the
// palette" — registers on the DOCUMENT, so nothing on the semantic surface owns
// the binding. From `testUI` that is fine and documented: `ui.<anything>
// .press("Escape")` bubbles up. From `am` it was not: every path names an
// element, and the obvious candidates are the wrong ones — an <input> is
// skipped by `ignoreInInput`, and anything else is a guess about someone's DOM.
//
// Field report (alpha71): "`am trigger … press` does not reach the keyboard.
// surface, click and setValue all work against a live instance; keyboard
// handlers live on the window, so a press reaches nothing." The workaround was
// raw CDP `window.dispatchEvent(new KeyboardEvent(...))` — the selector-level
// DOM work the semantic surface exists to delete.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { runUITrigger } from "../src/air/ui-remote.ts";
import { onGlobalKey } from "../src/air/renderer-lifecycle.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { signal } from "../src/state/signal.ts";

const closed = signal(0, "closed");
const typed = signal("", "typed");

function Palette() {
  onGlobalKey("Escape", () => closed.set(closed.peek() + 1));
  return (
    <div>
      <span t="count">{String(closed.value)}</span>
      <input t="field" value={typed.value} />
    </div>
  );
}

testUI(Palette, "am: `window` drives a key no element owns", async (ui) => {
  closed.set(0);
  assertEquals(ui.count.text, "0");
  const r = await runUITrigger({
    path: "window",
    action: "press",
    key: "Escape",
  });
  assert(r.ok, `the window path must be a real address: ${r.error}`);
  assertEquals(ui.count.text, "1", "the onGlobalKey binding must have fired");
});

testUI(Palette, "am: an input would have swallowed it", async (ui) => {
  // Why "just press on any element" is not the answer from a CLI: onGlobalKey
  // ignores the chord while focus is in a field (`ignoreInInput`), so aiming a
  // window-level key at the most obvious path on the surface silently does
  // nothing — and reports ok.
  closed.set(0);
  await ui.field.press("Escape"); // the request succeeds — that is the trap
  assertEquals(ui.count.text, "0", "…and the binding did not fire");

  const viaWindow = await runUITrigger({
    path: "window",
    action: "press",
    key: "Escape",
  });
  assert(viaWindow.ok);
  assertEquals(ui.count.text, "1");
});

testUI(Palette, "am: `window` refuses what is not a key", async (_ui) => {
  // A click or a `type` on the window is not a gesture a user can make.
  // Accepting one would report ok for an interaction that did nothing — the
  // exact failure shape this address exists to remove.
  const r = await runUITrigger({ path: "window", action: "click" });
  assertEquals(r.ok, false);
  assertStringIncludes(r.error ?? "", "WINDOW-LEVEL KEY");
  assertStringIncludes(r.error ?? "", "press");
});

testUI(
  Palette,
  "am: a miss LISTS window, or the one answer is invisible",
  async (_ui) => {
    const r = await runUITrigger({ path: "Nope:Missing", action: "press" });
    assertEquals(r.ok, false);
    assert(
      (r.available ?? []).includes("window"),
      `a miss must offer the window address; got ${
        JSON.stringify(r.available)
      }`,
    );
  },
);
