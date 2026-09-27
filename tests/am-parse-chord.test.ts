// `am trigger` chords — one spelling for keys and pointer modifiers.
//
// The parser's edge is the literal `+` key: splitting on "+" swallows it, so
// `press "+"` (zoom in — a real user gesture) silently became the caller's
// default key. A parser that turns one key into a different key is the
// harness lying about what it did.
import { assertEquals, assertThrows } from "@std/assert";
import { parseChord } from "../src/am/am-cmd-inspect.ts";
import { isMacPlatform, pressChord } from "../src/air/key-chord.ts";

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

// `am trigger … press enter` dispatched key "enter" — nothing listens for it.
Deno.test("chord: lowercase / short key names become the real key", () => {
  assertEquals(parseChord("enter").key, "Enter");
  assertEquals(parseChord("esc").key, "Escape");
  assertEquals(parseChord("space").key, " ");
  assertEquals(parseChord("shift+tab"), {
    mods: { shiftKey: true },
    key: "Tab",
  });
  assertEquals(parseChord("f5").key, "F5");
  assertEquals(parseChord("K").key, "K"); // one character is never re-cased
});

// `am trigger press "mod+k"` sent the literal key "mod+k"; `press Shift` sent
// shift+Enter; `press "a+"` sent "a". A press means one key, or it throws.
Deno.test("press chord: mod is the platform modifier", () => {
  const mac = /Mac|iP(hone|ad|od)/.test(navigator.platform ?? "");
  const mod: Record<string, boolean> = { [mac ? "metaKey" : "ctrlKey"]: true };
  assertEquals(pressChord("mod+k"), { mods: mod, key: "k" });
  assertEquals(parseChord("mod").mods, mod);
});

Deno.test("press chord: a bare modifier presses that modifier", () => {
  assertEquals(pressChord("Shift"), { mods: { shiftKey: true }, key: "Shift" });
  assertEquals(pressChord("ctrl"), { mods: { ctrlKey: true }, key: "Control" });
  assertEquals(pressChord("ctrl+shift"), {
    mods: { ctrlKey: true, shiftKey: true },
    key: "Shift",
  });
});

Deno.test("press chord: a spelling that names no one key throws", () => {
  for (const bad of ["a+", "shift+a+", "hyper+k", ""]) {
    assertThrows(() => pressChord(bad), Error, "names no key");
  }
  assertEquals(pressChord("+").key, "+");
  assertEquals(pressChord("ctrl++").key, "+");
  assertEquals(pressChord("enter").key, "Enter");
});

Deno.test("chord: mod follows the TARGET's platform, not the parser's", () => {
  // `am trigger` runs on one machine and drives a browser on another: a Mac
  // client gets ⌘ for `mod` even when am runs on Linux, and vice versa.
  assertEquals(pressChord("mod+k", true), {
    mods: { metaKey: true },
    key: "k",
  });
  assertEquals(pressChord("mod+k", false), {
    mods: { ctrlKey: true },
    key: "k",
  });
  assertEquals(pressChord("mod", true).key, "Meta");
  assertEquals(pressChord("mod", false).key, "Control");
  const mac = [
    "MacIntel",
    "iPhone",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X)",
    // happy-dom's platform on a Mac host (built from process.platform)
    "X11; Darwin arm64",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148",
    "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Mobile/15E148",
  ];
  const other = [
    "Linux x86_64",
    "Win32",
    "X11; Linux x64",
    "",
    undefined,
    // An Electron app's NAME sits in the UA too — not its platform.
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Macros/1.0.0 Electron/37.0.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) iPodcast/2.1 Electron/37.0.0",
  ];
  assertEquals(mac.map(isMacPlatform), mac.map(() => true));
  assertEquals(other.map(isMacPlatform), other.map(() => false));
});

Deno.test("chord: the literal + key survives", () => {
  assertEquals(parseChord("+"), { mods: undefined, key: "+" });
  assertEquals(parseChord("ctrl++"), { mods: { ctrlKey: true }, key: "+" });
});
