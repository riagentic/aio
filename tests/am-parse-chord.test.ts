// `am trigger` chords — one spelling for keys and pointer modifiers.
//
// The parser's edge is the literal `+` key: splitting on "+" swallows it, so
// `press "+"` (zoom in — a real user gesture) silently became the caller's
// default key. A parser that turns one key into a different key is the
// harness lying about what it did.
import { assertEquals } from "@std/assert";
import { parseChord } from "../src/am/am-cmd-inspect.ts";

Deno.test("chord: bare key", () => {
  assertEquals(parseChord("F2"), { mods: undefined, key: "F2" });
  assertEquals(parseChord("Enter"), { mods: undefined, key: "Enter" });
});

Deno.test("chord: modifiers + key", () => {
  assertEquals(parseChord("ctrl+Enter"), {
    mods: { ctrlKey: true },
    key: "Enter",
  });
  assertEquals(parseChord("ctrl+shift+s"), {
    mods: { ctrlKey: true, shiftKey: true },
    key: "s",
  });
  assertEquals(parseChord("cmd+k").mods, { metaKey: true });
});

Deno.test("chord: bare modifier list (pointer gestures)", () => {
  assertEquals(parseChord("ctrl"), { mods: { ctrlKey: true }, key: "" });
  assertEquals(parseChord("ctrl+alt"), {
    mods: { ctrlKey: true, altKey: true },
    key: "",
  });
});

Deno.test("chord: the literal + key survives", () => {
  assertEquals(parseChord("+"), { mods: undefined, key: "+" });
  assertEquals(parseChord("ctrl++"), { mods: { ctrlKey: true }, key: "+" });
});
