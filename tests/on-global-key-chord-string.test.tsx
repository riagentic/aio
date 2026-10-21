// `onGlobalKey("ctrl+s", fn)` — the chord-string form. It type-checked and
// never fired (the string was compared literally against KeyboardEvent.key).
// It now parses into key + modifiers and matches EXACTLY by default; the
// `(key, fn, chord)` form keeps "omitted = don't care", with `exact: true`
// as the opt-in.
import { assertEquals, assertThrows } from "@std/assert";
import { onGlobalKey, signal } from "aio/air";
import { testUI } from "aio/testing";
import { bindingChord } from "../src/air/key-chord.ts";

const hits = signal<string[]>([]);
const push = (s: string) => hits.set([...hits(), s]);

function App() {
  onGlobalKey("ctrl+s", () => push("save"));
  onGlobalKey("ctrl+shift+s", () => push("save-as"));
  onGlobalKey("mod+k", () => push("palette"));
  onGlobalKey("alt+f1", () => push("help"));
  onGlobalKey("ctrl++", () => push("zoom"));
  onGlobalKey("ctrl+?", () => push("keys"));
  onGlobalKey("h", () => push("find"), { mod: true, exact: true });
  onGlobalKey("j", () => push("loose"), { mod: true });
  onGlobalKey("mod+e", () => push("e-loose"), { exact: false });
  onGlobalKey("ctrl+i", () => push("in-field"), { ignoreInInput: false });
  return (
    <div>
      <button t="btn">focus me</button>
      <input t="field" />
    </div>
  );
}

const run = async (
  // deno-lint-ignore no-explicit-any
  ui: any,
  presses: [string, Record<string, boolean>?][],
) => {
  hits.set([]);
  for (const [k, m] of presses) await ui.btn.press(k, m);
  await ui.settle();
  return hits();
};

testUI(App, "ctrl+s fires on Ctrl+S only — exact", async (ui) => {
  assertEquals(
    await run(ui, [
      ["s"],
      ["s", { ctrlKey: true }],
      ["s", { ctrlKey: true, altKey: true }],
      ["s", { metaKey: true }],
    ]),
    ["save"],
  );
});

testUI(App, "ctrl+shift+s is its own binding", async (ui) => {
  // Shift+S types "S"; the key matches case-insensitively.
  assertEquals(
    await run(ui, [["S", { ctrlKey: true, shiftKey: true }]]),
    ["save-as"],
  );
});

testUI(App, "mod+k matches Ctrl or Cmd, nothing else held", async (ui) => {
  assertEquals(
    await run(ui, [
      ["k", { ctrlKey: true }],
      ["k", { metaKey: true }],
      ["k", { ctrlKey: true, shiftKey: true }],
      ["k"],
    ]),
    ["palette", "palette"],
  );
});

testUI(App, "alt+f1 and ctrl++ parse", async (ui) => {
  assertEquals(
    await run(ui, [
      ["F1", { altKey: true }],
      ["F1", { altKey: true, ctrlKey: true }],
      ["F1"],
      ["+", { ctrlKey: true }],
      ["+", { ctrlKey: true, shiftKey: true }], // Shift types "+": free
    ]),
    ["help", "zoom", "zoom"],
  );
});

testUI(App, "Shift is free on a symbol key, held for a letter", async (ui) => {
  assertEquals(
    await run(ui, [["?", { ctrlKey: true, shiftKey: true }]]),
    ["keys"],
  );
});

testUI(App, "exact: true opts the object form in", async (ui) => {
  assertEquals(
    await run(ui, [
      ["h", { ctrlKey: true }],
      ["H", { ctrlKey: true, shiftKey: true }],
      ["h", { metaKey: true, altKey: true }],
    ]),
    ["find"],
  );
});

testUI(App, "the object form still means don't care", async (ui) => {
  assertEquals(
    await run(ui, [["J", { ctrlKey: true, shiftKey: true }]]),
    ["loose"],
  );
});

testUI(App, "a chord string with exact: false is loose", async (ui) => {
  assertEquals(
    await run(ui, [["E", { ctrlKey: true, shiftKey: true }]]),
    ["e-loose"],
  );
});

testUI(App, "ignoreInInput still applies to a string chord", async (ui) => {
  hits.set([]);
  // aio-ok: press swallowed on purpose — ctrl+s must NOT fire in a field
  await ui.field.press("s", { ctrlKey: true });
  await ui.field.press("i", { ctrlKey: true });
  await ui.settle();
  assertEquals(hits(), ["in-field"]);
});

testUI(App, "am-trigger spelling drives a string binding", async (ui) => {
  hits.set([]);
  await ui.window.press("ctrl+s");
  await ui.settle();
  assertEquals(hits(), ["save"]);
});

Deno.test("bindingChord: parse table", () => {
  assertEquals(bindingChord("ctrl+s"), { key: "s", mods: { ctrl: true } });
  assertEquals(bindingChord("Ctrl+Shift+S"), {
    key: "S",
    mods: { ctrl: true, shift: true },
  });
  assertEquals(bindingChord("mod+k"), { key: "k", mods: { mod: true } });
  assertEquals(bindingChord("alt+f1"), { key: "F1", mods: { alt: true } });
  assertEquals(bindingChord("cmd+option+esc"), {
    key: "Escape",
    mods: { meta: true, alt: true },
  });
  assertEquals(bindingChord("ctrl++"), { key: "+", mods: { ctrl: true } });
});

Deno.test("bindingChord: an unknown modifier or no key throws", () => {
  assertThrows(() => bindingChord("hyper+k"), Error, '"hyper" is not a');
  assertThrows(() => bindingChord("ctrl+"), Error, "no key");
  assertThrows(() => bindingChord("a+b"), Error, '"a" is not a');
});

function Bad() {
  onGlobalKey("hyper+k", () => {});
  return <div />;
}
function Conflict() {
  onGlobalKey("ctrl+s", () => {}, { ctrl: false });
  return <div />;
}

Deno.test("onGlobalKey: an unknown modifier throws at render", async () => {
  for (const C of [Bad, Conflict]) {
    let err: unknown;
    try {
      await using _ui = await testUI(C);
    } catch (e) {
      err = e;
    }
    assertEquals(
      String(err).includes("onGlobalKey("),
      true,
      `${C.name}: ${err}`,
    );
  }
});
