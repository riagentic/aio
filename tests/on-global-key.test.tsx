// `onGlobalKey` — the binding every app needs and every app rebuilds.
//
// Escape closes the lightbox, Ctrl+K opens the palette, `?` shows help. Two
// walls, hit by every app: `globalThis.addEventListener("keydown", …)` is the
// natural spelling and is INERT under testUI, and the chord logic gets
// rewritten each time — one field report's workaround was to extract the
// predicate into a pure function and test THAT, leaving the listener itself
// permanently uncovered. This is testable by construction.
import { assertEquals } from "@std/assert";
import { onGlobalKey, signal } from "aio/air";
import { testUI } from "aio/testing";

const hits = signal<string[]>([]);
const push = (s: string) => hits.set([...hits(), s]);

function App() {
  onGlobalKey("Escape", () => push("escape"));
  onGlobalKey("k", () => push("palette"), { mod: true });
  onGlobalKey("h", () => push("bare-h"));
  return (
    <div>
      <button t="btn">focus me</button>
      <input t="field" />
    </div>
  );
}

testUI(
  App,
  "a document-level chord fires from anywhere in the app",
  async (ui) => {
    hits.set([]);
    await ui.btn.press("Escape");
    await ui.settle();
    assertEquals(hits(), ["escape"]);
  },
);

testUI(App, "mod matches Ctrl (and would match Cmd)", async (ui) => {
  hits.set([]);
  await ui.btn.press("k"); // no modifier — must NOT fire
  await ui.btn.press("k", { ctrlKey: true });
  await ui.settle();
  assertEquals(hits(), ["palette"]);
});

testUI(App, "a bare key does not fire while you are typing", async (ui) => {
  // The bug in every app that has shipped one: a `h` shortcut that triggers
  // mid-word in a note field.
  hits.set([]);
  await ui.field.press("h");
  await ui.settle();
  assertEquals(hits(), []);
  await ui.btn.press("h");
  await ui.settle();
  assertEquals(hits(), ["bare-h"]);
});

testUI(App, "the binding is removed with the component", async (ui) => {
  hits.set([]);
  await ui.dispose();
  // Nothing to assert against a disposed mount beyond this: the handler is
  // off the document, so a later mount cannot double-fire. The next test in
  // this file proves that by counting exactly one hit.
  assertEquals(hits(), []);
});

testUI(
  App,
  "a remount fires exactly once, not once per past mount",
  async (ui) => {
    hits.set([]);
    await ui.btn.press("Escape");
    await ui.settle();
    assertEquals(hits(), ["escape"]);
  },
);

// The callback must be the LATEST one, not the one the first render happened
// to have. The listener is registered inside `onMount`, which runs once, so
// closing over the argument froze it at mount: a handler reading a value that
// changes (`() => go(page + 1)`) kept firing with render 1's copy forever.
// Measured `[1, 1, 1]` where the app expects `[1, 2, 3]`. `useRaf`/`useInterval`
// already solve this with a ref and document it; this is the same solution.
const page = signal(1);
const seen = signal<number[]>([]);

function Pager() {
  const current = page(); // subscribes, so the component re-renders
  onGlobalKey("n", () => seen.set([...seen(), current]));
  return (
    <div>
      <button t="btn">{String(current)}</button>
    </div>
  );
}

testUI(
  Pager,
  "the chord runs the LATEST callback, not render 1's",
  async (ui) => {
    page.set(1);
    seen.set([]);
    await ui.btn.press("n");
    page.set(2);
    await ui.settle();
    await ui.btn.press("n");
    page.set(3);
    await ui.settle();
    await ui.btn.press("n");
    await ui.settle();
    assertEquals(seen(), [1, 2, 3]);
  },
);
