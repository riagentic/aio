// A chord STRING names a keycap, not an `e.key` value. `e.key` alone missed
// two presses a user means: Shift+1 types "!" (so "ctrl+shift+1" never
// fired), and macOS Alt+letter / a non-Latin layout types another character.
// The rule (`keycapMatch`, key-chord.ts): a digit is the digit-row key
// (`Digit1`) on every layout; a letter is the layout's own keycap, with the
// US position (`KeyF`) as the fallback only when the key typed no ASCII
// character. The object form keeps matching `e.key` alone.
import { assert, assertEquals } from "@std/assert";
import { onGlobalKey, signal } from "aio/air";
import { testUI } from "aio/testing";
import { runUITrigger } from "../src/air/ui-remote.ts";
import { keycapMatch, pressChord } from "../src/air/key-chord.ts";

const hits = signal<string[]>([]);
const push = (s: string) => hits.set([...hits(), s]);

function App() {
  onGlobalKey("ctrl+1", () => push("tab1"));
  onGlobalKey("ctrl+shift+1", () => push("heading1"));
  onGlobalKey("alt+f", () => push("file"));
  onGlobalKey("ctrl+m", () => push("m"));
  onGlobalKey("g", () => push("obj-g"), { alt: true }); // object form
  onGlobalKey("ctrl+shift+/", () => push("help"));
  onGlobalKey("shift+=", () => push("zoom"));
  onGlobalKey("alt+/", () => push("alt-slash"));
  onGlobalKey("alt+-", () => push("alt-minus"));
  return <button type="button" t="btn">focus me</button>;
}

function Comment() {
  onGlobalKey("ctrl+/", () => push("comment"));
  return <button type="button" t="btn">focus me</button>;
}

/** A keydown exactly as a browser sends it — `key` AND `code` chosen. */
// deno-lint-ignore no-explicit-any
const down = (ui: any, key: string, code: string, mods = {}) => {
  const w = ui.window;
  w.document.body.dispatchEvent(
    new w.KeyboardEvent("keydown", { key, code, bubbles: true, ...mods }),
  );
};

testUI(App, "ctrl+shift+1 fires on QWERTY's Shift+1 (key '!')", async (ui) => {
  hits.set([]);
  down(ui, "!", "Digit1", { ctrlKey: true, shiftKey: true });
  down(ui, "1", "Digit1", { ctrlKey: true });
  await ui.settle();
  assertEquals(hits(), ["heading1", "tab1"]);
});

testUI(
  App,
  "AZERTY: the digit row types & é … — still the digit",
  async (ui) => {
    hits.set([]);
    down(ui, "&", "Digit1", { ctrlKey: true }); // unshifted AZERTY 1-key
    down(ui, "1", "Digit1", { ctrlKey: true, shiftKey: true }); // Shift → "1"
    down(ui, "1", "Numpad1", { ctrlKey: true }); // numpad types the digit
    await ui.settle();
    assertEquals(hits(), ["tab1", "heading1", "tab1"]);
  },
);

testUI(App, "macOS Alt+F types 'ƒ' — alt+f still fires", async (ui) => {
  hits.set([]);
  down(ui, "ƒ", "KeyF", { altKey: true });
  down(ui, "Dead", "KeyF", { altKey: true }); // a dead key
  down(ui, "а", "KeyF", { altKey: true }); // Cyrillic layout
  await ui.settle();
  assertEquals(hits(), ["file", "file", "file"]);
});

testUI(App, "an ASCII result is the keycap: AZERTY ',' at KeyM", async (ui) => {
  hits.set([]);
  down(ui, ",", "KeyM", { ctrlKey: true }); // AZERTY: must NOT be ctrl+m
  down(ui, "m", "Semicolon", { ctrlKey: true }); // AZERTY's M keycap
  await ui.settle();
  assertEquals(hits(), ["m"]);
});

testUI(App, "the object form keeps e.key alone", async (ui) => {
  hits.set([]);
  down(ui, "©", "KeyG", { altKey: true }); // macOS Alt+G
  down(ui, "g", "KeyG", { altKey: true });
  await ui.settle();
  assertEquals(hits(), ["obj-g"]);
});

testUI(App, "testUI press and am trigger drive ctrl+shift+1", async (ui) => {
  hits.set([]);
  await ui.btn.press("!", { ctrlKey: true, shiftKey: true }); // browser-like
  await ui.window.press("ctrl+shift+1"); // am spelling (key "1" + mods)
  const chord = pressChord("ctrl+shift+1", false);
  const r = await runUITrigger({
    path: "window",
    action: "press",
    key: chord.key,
    mods: chord.mods,
  });
  assert(r.ok, r.error);
  await ui.settle();
  assertEquals(hits(), ["heading1", "heading1", "heading1"]);
});

testUI(
  App,
  "a shifted US symbol: ctrl+shift+/ and shift+= fire on the real keydown (key '?' / '+') AND on testUI press — the two agree",
  async (ui) => {
    hits.set([]);
    down(ui, "?", "Slash", { ctrlKey: true, shiftKey: true }); // US Shift+/
    await ui.window.press("ctrl+shift+/"); // key "/" + Shift
    down(ui, "+", "Equal", { shiftKey: true }); // US Shift+=
    await ui.window.press("shift+=");
    await ui.settle();
    assertEquals(hits(), ["help", "help", "zoom", "zoom"]);
  },
);

testUI(
  Comment,
  "ctrl+/ names no shift: US Ctrl+? is not it, AZERTY's Slash key ('!', '§') never is",
  async (ui) => {
    hits.set([]);
    down(ui, "?", "Slash", { ctrlKey: true, shiftKey: true });
    down(ui, "!", "Slash", { ctrlKey: true });
    down(ui, "§", "Slash", { ctrlKey: true, shiftKey: true });
    down(ui, "/", "Slash", { ctrlKey: true });
    await ui.settle();
    assertEquals(hits(), ["comment"]);
  },
);

testUI(
  App,
  "macOS Alt+/ types '÷', Alt+- '–' — alt+/ and alt+- still fire; no Alt, no fallback",
  async (ui) => {
    hits.set([]);
    down(ui, "÷", "Slash", { altKey: true });
    down(ui, "–", "Minus", { altKey: true });
    down(ui, "÷", "Slash", {}); // not Alt: not alt+/
    await ui.settle();
    assertEquals(hits(), ["alt-slash", "alt-minus"]);
  },
);

Deno.test("keycapMatch: rule table", () => {
  const t = (b: string, k: string, c: string) => keycapMatch(b, k, c);
  assert(t("1", "!", "Digit1"));
  assert(t("1", "&", "Digit1"));
  assert(t("1", "1", "Numpad1"));
  assert(!t("1", "2", "Digit2"));
  assert(t("f", "ƒ", "KeyF"));
  assert(t("F", "f", "KeyF"));
  assert(t("f", "Dead", "KeyF"));
  assert(t("f", "Unidentified", "KeyF"));
  assert(!t("m", ",", "KeyM"));
  assert(!t("f", "ƒ", "KeyG"));
  assert(t("a", "a", "KeyQ")); // AZERTY: the A keycap sits at KeyQ
  assert(!t("q", "a", "KeyQ"));
  assert(t("Escape", "escape", ""));
  assert(!t("+", "=", "Equal"));
  const s = (b: string, k: string, c: string) => keycapMatch(b, k, c, true);
  assert(s("/", "?", "Slash"));
  assert(s("=", "+", "Equal"));
  assert(s("[", "{", "BracketLeft"));
  assert(s("\\", "|", "Backslash"));
  assert(!t("/", "?", "Slash")); // shift not named
  assert(!s("/", "§", "Slash")); // AZERTY Shift+! key
  assert(!s("/", "?", "Minus"));
  const a = (b: string, k: string, c: string) =>
    keycapMatch(b, k, c, false, true);
  assert(a("/", "÷", "Slash")); // macOS Alt+/
  assert(a("=", "≠", "Equal"));
  assert(a("`", "Dead", "Backquote"));
  assert(!a("/", "!", "Slash")); // ASCII: never re-read
  assert(!t("/", "÷", "Slash")); // no Alt
  assert(!t("/", "§", "Slash"));
});

// German layout: "/" is Shift+7, so Ctrl+Shift+7 is key "/" with Shift held.
// Bound alone, "ctrl+/" fires on it (Shift is free on a symbol key). With
// "ctrl+shift+/" bound too, only the binding naming Shift runs — one press
// used to run both handlers.
function GermanBoth() {
  onGlobalKey("ctrl+/", () => push("comment"));
  onGlobalKey("ctrl+shift+/", () => push("help"));
  return <button type="button" t="btn">focus me</button>;
}

testUI(
  GermanBoth,
  "German Ctrl+Shift+7 ('/'): with ctrl+/ AND ctrl+shift+/ bound, only the Shift one runs",
  async (ui) => {
    hits.set([]);
    down(ui, "/", "Digit7", { ctrlKey: true, shiftKey: true }); // German
    down(ui, "?", "Slash", { ctrlKey: true, shiftKey: true }); // US Shift+/
    down(ui, "/", "Slash", { ctrlKey: true }); // US Ctrl+/
    await ui.settle();
    assertEquals(hits(), ["help", "help", "comment"]);
  },
);

testUI(
  Comment,
  "German Ctrl+Shift+7 ('/'): ctrl+/ bound alone still fires",
  async (ui) => {
    hits.set([]);
    down(ui, "/", "Digit7", { ctrlKey: true, shiftKey: true });
    await ui.settle();
    assertEquals(hits(), ["comment"]);
  },
);

// The Shift-specific binding takes the keystroke only when it would FIRE:
// with focus in a field it is input-gated (default), so the free binding that
// opted into fields (`ignoreInInput: false`) must not yield to it — that left
// NEITHER firing (R9 review).
function GermanInField() {
  onGlobalKey("ctrl+/", () => push("comment"), { ignoreInInput: false });
  onGlobalKey("ctrl+shift+/", () => push("help"));
  return <input t="field" />;
}

testUI(
  GermanInField,
  "German Ctrl+Shift+7 in a field: ctrl+shift+/ is input-gated, so ctrl+/ (ignoreInInput: false) fires",
  async (ui) => {
    hits.set([]);
    const w = ui.window;
    const field = w.document.querySelector("input")!;
    field.dispatchEvent(
      new w.KeyboardEvent("keydown", {
        key: "/",
        code: "Digit7",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    down(ui, "/", "Digit7", { ctrlKey: true, shiftKey: true }); // outside: help wins
    await ui.settle();
    assertEquals(hits(), ["comment", "help"]);
  },
);
