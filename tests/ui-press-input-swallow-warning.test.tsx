// A press that dispatches, asserts green, and ran the handler ZERO times.
//
// `press` puts a real keydown on the element with `bubbles: true`, so it does
// reach the document — and `onGlobalKey` then SKIPS it, by design, when the
// key landed in a field (`ignoreInInput`: a bare "n" shortcut must not fire
// while someone is typing a note). Both halves are correct; together they make
// `await ui.AmountField.press("Enter")` a green assertion about a keyboard
// shortcut that never ran (a field report). `tests/ui-window-key.test.tsx`
// wrote "the request succeeds — that is the trap" and left it armed.
//
// So the trigger says it, at the press, with the address that works. The half
// that keeps the warning honest is the SILENT cases below: a warning that
// fires on correct code is the same defect as one that never fires.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { onGlobalKey } from "../src/air/renderer-lifecycle.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { signal } from "../src/state/signal.ts";

const fired = signal(0, "press.fired");

/** Capture `console.warn` for the span of `fn` (the queue is drained first, so
 *  no earlier action's warning lands inside the window). */
async function warnings(fn: () => Promise<unknown>): Promise<string[]> {
  const out: string[] = [];
  const real = console.warn;
  console.warn = (...a: unknown[]) => out.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.warn = real;
  }
  return out;
}

const swallowed = (lines: string[]) =>
  lines.filter((l) => l.includes("ignoreInInput"));

/** The ONE swallow warning these lines must carry — asserted, then returned. */
function oneSwallow(lines: string[]): string {
  const hit = swallowed(lines);
  assertEquals(
    hit.length,
    1,
    `expected exactly one swallow warning, got ${JSON.stringify(lines)}`,
  );
  return hit[0] ?? "";
}

// ── The trap ─────────────────────────────────────────────────────────

function Palette() {
  onGlobalKey("Enter", () => fired.set(fired.peek() + 1));
  return (
    <div>
      <span t="count">{String(fired.value)}</span>
      <input t="field" />
      <textarea t="note"></textarea>
      <div t="row">row</div>
    </div>
  );
}

testUI(
  Palette,
  "press into a field that the shortcut ignores is NAMED",
  async (ui) => {
    fired.set(0);
    const lines = await warnings(() => ui.field.press("Enter"));
    assertEquals(ui.count.text, "0", "the binding must not have fired");
    const hit = oneSwallow(lines);
    assertStringIncludes(hit, `press("Enter")`);
    assertStringIncludes(hit, "<input>");
    assertStringIncludes(hit, "nothing ran");
    // The fix must have a NAME, or the warning only renames the dead end.
    assertStringIncludes(hit, `ui.window.press("Enter")`);
    assertStringIncludes(hit, "am trigger window press Enter");
  },
);

testUI(Palette, "press on a textarea is named too", async (ui) => {
  fired.set(0);
  const lines = await warnings(() => ui.note.press("Enter"));
  assertStringIncludes(oneSwallow(lines), "<textarea>");
  assertEquals(ui.count.text, "0");
});

testUI(Palette, "a HOLD into a field is named the same way", async (ui) => {
  // `keyDown` dispatches the same keydown `onGlobalKey` listens to, so a hold
  // aimed at a field is exactly as silent as a tap.
  fired.set(0);
  const lines = await warnings(() => ui.field.keyDown("Enter"));
  const hit = oneSwallow(lines);
  assertStringIncludes(hit, `keyDown("Enter")`);
  assertStringIncludes(hit, `ui.window.keyDown("Enter")`);
  assertEquals(ui.count.text, "0");
});

// ── Silent: correct code must stay quiet ─────────────────────────────

testUI(Palette, "silent: a press a binding actually HEARD", async (ui) => {
  fired.set(0);
  const lines = await warnings(() => ui.row.press("Enter"));
  assertEquals(ui.count.text, "1", "the binding ran — the press was correct");
  assertEquals(swallowed(lines), [], "a correct press must warn NOTHING");
});

testUI(Palette, "silent: the window address", async (ui) => {
  fired.set(0);
  const lines = await warnings(() => ui.window.press("Enter"));
  assertEquals(ui.count.text, "1", "`ui.window.press` must reach onGlobalKey");
  assertEquals(swallowed(lines), []);
});

function PlainField() {
  // No window-level binding at all: Enter in this field is the FIELD's
  // business (implicit submission, a keydown handler). Nothing was swallowed,
  // so nothing is warned — this is the false-positive guard.
  return (
    <div>
      <input t="field" />
    </div>
  );
}

testUI(PlainField, "silent: no window binding exists", async (ui) => {
  const lines = await warnings(() => ui.field.press("Enter"));
  assertEquals(swallowed(lines), [], "no binding was listening — say nothing");
});

function AlwaysOn() {
  onGlobalKey("Enter", () => fired.set(fired.peek() + 1), {
    ignoreInInput: false,
  });
  return (
    <div>
      <span t="count">{String(fired.value)}</span>
      <input t="field" />
    </div>
  );
}

testUI(AlwaysOn, "silent: the binding opted INTO inputs", async (ui) => {
  fired.set(0);
  const lines = await warnings(() => ui.field.press("Enter"));
  assertEquals(ui.count.text, "1", "ignoreInInput:false must still fire");
  assertEquals(swallowed(lines), []);
});

function Both() {
  // One binding skipped, another ran: SOMETHING happened, so the press proved
  // something and the warning would be a lie.
  onGlobalKey("Enter", () => fired.set(fired.peek() + 100));
  onGlobalKey("Enter", () => fired.set(fired.peek() + 1), {
    ignoreInInput: false,
  });
  return (
    <div>
      <span t="count">{String(fired.value)}</span>
      <input t="field" />
    </div>
  );
}

testUI(Both, "silent: one binding skipped, another ran", async (ui) => {
  fired.set(0);
  const lines = await warnings(() => ui.field.press("Enter"));
  assertEquals(ui.count.text, "1", "only the opted-in binding fires");
  assertEquals(swallowed(lines), []);
});

function Chord() {
  onGlobalKey("k", () => fired.set(fired.peek() + 1), { mod: true });
  return (
    <div>
      <span t="count">{String(fired.value)}</span>
      <input t="field" />
    </div>
  );
}

testUI(Chord, "silent: the chord did not match anyway", async (ui) => {
  // A bare "k" typed into a field is not the ⌘K shortcut at all — the chord is
  // decided before `ignoreInInput`, so nothing was swallowed.
  fired.set(0);
  const lines = await warnings(() => ui.field.press("k"));
  assertEquals(ui.count.text, "0");
  assertEquals(swallowed(lines), [], "a non-matching chord is not the trap");
});

testUI(
  Chord,
  "silent: the chord matched, in a field, and is named",
  async (ui) => {
    fired.set(0);
    const lines = await warnings(() => ui.field.press("k", { ctrlKey: true }));
    assertEquals(ui.count.text, "0", "…ignoreInInput swallowed it");
    oneSwallow(lines);
  },
);

// ── The named address works for the rest of the key actions ──────────

const held = signal(0, "held.down");

function Held() {
  onGlobalKey("ArrowLeft", () => held.set(held.peek() + 1));
  return (
    <div>
      <span t="down">{String(held.value)}</span>
      <input t="field" />
    </div>
  );
}

testUI(Held, "silent: a hold a binding HEARD", async (ui) => {
  held.set(0);
  const lines = await warnings(() => ui.field.keyUp("ArrowLeft"));
  assertEquals(swallowed(lines), [], "keyup is not the swallowed keydown");
});

testUI(Held, "ui.window.keyDown/keyUp are the same address", async (ui) => {
  held.set(0);
  await ui.window.keyDown("ArrowLeft");
  assertEquals(ui.down.text, "1", "a held key must reach onGlobalKey");
  await ui.window.keyUp("ArrowLeft");
  assertEquals(ui.down.text, "1", "keyup is not a second keydown");
});

testUI(Held, "ui.window.press joins the ordered action queue", async (ui) => {
  held.set(0);
  // Un-awaited, like every other testUI action: the queue orders them.
  ui.window.press("ArrowLeft");
  ui.window.press("ArrowLeft");
  await ui.settle();
  assertEquals(ui.down.text, "2");
  assert(typeof ui.window.addEventListener === "function", "still a window");
});
