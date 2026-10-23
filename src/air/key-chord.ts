// key-chord.ts — the ONE reading of a key spelling, shared by `am trigger`,
// testUI's `press`/`keyDown`/`keyUp`, and `onGlobalKey`'s chord strings
// (`bindingChord` — the one export the browser bundle reaches). Pure.

/** The KeyboardEvent `key` for the names people write in lowercase or short
 *  form. `press("enter")` used to dispatch `key: "enter"` — no handler and no
 *  default action matched it, and the test stayed green having pressed
 *  nothing. */
const NAMED: Record<string, string> = {
  enter: "Enter",
  return: "Enter",
  esc: "Escape",
  escape: "Escape",
  space: " ",
  spacebar: " ",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
};

/** A key NAME in its KeyboardEvent spelling (`"enter"` → `"Enter"`,
 *  `"f5"` → `"F5"`). One character is left alone — `"K"` and `"k"` are
 *  different keys. */
export function normalizeKey(key: string): string {
  if (key.length < 2) return key;
  const low = key.toLowerCase();
  return NAMED[low] ??
    (/^f([1-9]|1[0-9]|2[0-4])$/.test(low) ? "F" + low.slice(1) : key);
}

/** Is `platform` (a `navigator.platform`, or a User-Agent) an Apple one?
 *  Only a User-Agent's first `(…)` is read — an app named "Macros" or
 *  "iPodcast" elsewhere in it is not a Mac — and happy-dom's platform on a
 *  Mac host ("X11; Darwin arm64") is one. */
export function isMacPlatform(platform: string | undefined): boolean {
  const s = platform ?? "";
  return /\b(Mac(intosh|Intel|PPC|68K)?|macOS|Darwin|iPhone|iPad|iPod)\b/
    .test(/\(([^)]*)\)/.exec(s)?.[1] ?? s);
}

/** Is the process parsing on macOS — the default for `mod`. The OS itself
 *  (`Deno.build.os`), not `navigator.platform`, which is not the OS on every
 *  host. Read per call. A driver that knows the TARGET's platform (am: the UI
 *  client's; testUI: the DOM window's) passes it instead. */
const hostMac = (): boolean =>
  (globalThis as { Deno?: { build?: { os?: string } } }).Deno?.build?.os ===
    "darwin";

const MODS: Record<string, string> = {
  ctrl: "ctrlKey",
  control: "ctrlKey",
  cmd: "metaKey",
  command: "metaKey",
  meta: "metaKey",
  super: "metaKey",
  alt: "altKey",
  option: "altKey",
  shift: "shiftKey",
};

/** `mod` is THE modifier of the target platform — ⌘ on macOS, Ctrl
 *  elsewhere — the spelling cross-platform shortcut docs use. It used to be
 *  an unknown segment, so `press "mod+k"` sent the literal key "mod+k". */
const modFlag = (seg: string, mac: boolean): string | undefined => {
  const low = seg.toLowerCase();
  return low === "mod" ? (mac ? "metaKey" : "ctrlKey") : MODS[low];
};

/** The KeyboardEvent `key` of each modifier, for a press of the modifier
 *  itself. */
const MOD_KEY: Record<string, string> = {
  ctrlKey: "Control",
  metaKey: "Meta",
  altKey: "Alt",
  shiftKey: "Shift",
};

/** Parse a chord like `"ctrl+shift+Enter"` (or a bare `"ctrl+alt"`) into the
 *  modifier flags plus the key, so one spelling drives keys and pointer
 *  gestures alike. Unknown segments are the KEY — `"Enter"`, `"a"`, `"F2"` —
 *  and a bare modifier list yields no key at all. `mac` decides `mod`. */
export function parseChord(
  spec: string,
  mac: boolean = hostMac(),
): { mods?: Record<string, boolean>; key: string } {
  const parts = spec.split("+").filter(Boolean);
  const mods: Record<string, boolean> = {};
  const keys: string[] = [];
  for (const p of parts) {
    const flag = modFlag(p, mac);
    if (flag) mods[flag] = true;
    else keys.push(p);
  }
  // The literal `+` key: splitting on "+" swallows it, so `press "+"` (zoom
  // in — a real gesture) and `press "ctrl++"` would silently fall back to the
  // caller's default key. A spec that ENDS in a separator with no key parsed
  // means the key IS "+".
  let key = keys.join("+");
  if (key === "" && spec.endsWith("+") && spec.length > 0) key = "+";
  return {
    mods: Object.keys(mods).length ? mods : undefined,
    key: normalizeKey(key),
  };
}

/** The key a PRESS of `spec` means — `parseChord`, plus: a bare modifier
 *  list presses its last modifier (`"Shift"` → Shift, `"ctrl+shift"` → Shift
 *  with Ctrl held; it used to press Enter), and a spelling that names no one
 *  key throws rather than sending something else (`"a+"` sent "a",
 *  `"hyper+k"` the literal "hyper+k"). */
export function pressChord(
  spec: string,
  mac: boolean = hostMac(),
): { mods?: Record<string, boolean>; key: string } {
  const c = parseChord(spec, mac);
  const flag = modFlag(spec.split("+").filter(Boolean).pop() ?? "", mac);
  if (c.key === "" && flag) c.key = MOD_KEY[flag]!;
  if (
    c.key === "" || (c.key.length > 1 && c.key.includes("+")) ||
    (spec.endsWith("+") && c.key !== "+")
  ) {
    throw new Error(
      `${JSON.stringify(spec)} names no key — write a key ("Enter", "k", ` +
        `" ") or ctrl/shift/alt/meta/mod + one key ("ctrl+k", "mod+k"); ` +
        `a modifier alone ("Shift") presses that modifier.`,
    );
  }
  return c;
}

type BindMod = "ctrl" | "meta" | "alt" | "shift" | "mod";

/** The modifiers a BINDING spelling names, keyed as `KeyChord` fields. */
const BIND_MODS: Record<string, BindMod> = {
  ctrl: "ctrl",
  control: "ctrl",
  cmd: "meta",
  command: "meta",
  meta: "meta",
  super: "meta",
  alt: "alt",
  option: "alt",
  shift: "shift",
  mod: "mod",
};

/** Does a keydown (`key`, `code`) press the KEYCAP a chord string names?
 *
 *  `e.key` alone misses two presses a user means: Shift+1 types `"!"` (so
 *  `"ctrl+shift+1"` never fired), and on macOS Alt+letter types another
 *  character (`"alt+f"` → `"ƒ"`), as does every letter on a non-Latin layout
 *  (`"ф"`). The rule, per key class:
 *  - a DIGIT is the digit-row key (`code` `Digit1`) or a key typing that
 *    digit (numpad): every layout prints the digits on that row, even the
 *    ones (AZERTY) where the unshifted key types `&` — and Shift is then a
 *    real modifier, so `"ctrl+1"` and `"ctrl+shift+1"` are different bindings;
 *  - a LETTER is the key typing that letter — the layout's own keycap, so
 *    AZERTY's `"ctrl+a"` is the key labelled A, not QWERTY's A position — and
 *    falls back to the US position (`code` `KeyA`) only when the key typed no
 *    ASCII character (Alt on macOS, a dead key, a non-Latin layout), the same
 *    fallback browsers' own shortcuts use. An ASCII result is never
 *    re-interpreted: AZERTY's `,` sits at `KeyM` and must not fire `"ctrl+m"`;
 *  - a US PUNCTUATION key (`/`, `=`, `-`, `[`, `;`, `,` … `US_PUNCT`) is its US position
 *    (`code` `Slash`) when that key typed its US shifted twin (`?` for `/`)
 *    and the chord names shift — `"ctrl+shift+/"`, `"shift+="` used to never
 *    fire, since Shift+/ types `?`. AZERTY's `Slash` key types `!`/`§`:
 *    an ASCII `!` is never re-read as `/`. With Alt held, a key typing NO
 *    ASCII character is its US position too, on any layout (as letters
 *    already are): macOS Alt+/ types `÷`, Alt+= `≠`, so `"alt+/"`, `"alt+="`
 *    never fired on a Mac — and a German Mac's Alt+- (`–`, at the US Slash
 *    position) fires `"alt+/"` likewise;
 *  - anything else is `key` alone (case-insensitive). */
export function keycapMatch(
  bind: string,
  key: string,
  code: string,
  shift = false,
  alt = false,
): boolean {
  if (key.toLowerCase() === bind.toLowerCase()) return true;
  if (/^[0-9]$/.test(bind)) return code === "Digit" + bind;
  const typedNoAscii = key === "Dead" || key === "Unidentified" ||
    ([...key].length === 1 && key.codePointAt(0)! > 0x7f);
  const sym = Object.hasOwn(US_PUNCT, bind) ? US_PUNCT[bind] : undefined;
  if (sym) {
    return code === sym[0] &&
      ((shift && key === sym[1]) || (alt && typedNoAscii));
  }
  if (!/^[a-z]$/i.test(bind)) return false;
  return typedNoAscii && code === "Key" + bind.toUpperCase();
}

/** A US punctuation keycap: its `code` and what Shift makes it type. */
const US_PUNCT: Record<string, readonly [string, string]> = {
  "/": ["Slash", "?"],
  "=": ["Equal", "+"],
  "-": ["Minus", "_"],
  "[": ["BracketLeft", "{"],
  "]": ["BracketRight", "}"],
  "\\": ["Backslash", "|"],
  ";": ["Semicolon", ":"],
  "'": ["Quote", '"'],
  ",": ["Comma", "<"],
  ".": ["Period", ">"],
  "`": ["Backquote", "~"],
};

/** `onGlobalKey`'s chord string —`"ctrl+s"`, `"ctrl+shift+s"`, `"mod+k"`,
 *  `"alt+f1"`, `"ctrl++"` — as the key plus the modifiers it names. Unlike a
 *  press, `mod` stays `mod` (Ctrl OR ⌘ at event time): a binding runs on
 *  every platform. A segment before the key that is not a modifier
 *  (`"hyper+k"`), or no key at all (`"ctrl+"`), throws — the string used to
 *  be compared literally against `KeyboardEvent.key` and never fired. */
export function bindingChord(
  spec: string,
): { key: string; mods: Partial<Record<BindMod, true>> } {
  const fail = (why: string) =>
    new Error(
      `onGlobalKey(${JSON.stringify(spec)}): ${why} — write ` +
        `modifier+…+key with ctrl/shift/alt/meta/mod ` +
        `("ctrl+s", "mod+shift+k", "alt+f1").`,
    );
  // `"ctrl++"` is Ctrl and the `+` key: splitting on "+" would lose it.
  const plusKey = spec.endsWith("++");
  const parts = (plusKey ? spec.slice(0, -2) : spec).split("+");
  const key = plusKey ? "+" : parts.pop()!;
  if (key === "") throw fail("no key after the last +");
  const mods: Partial<Record<BindMod, true>> = {};
  for (const p of parts) {
    const m = BIND_MODS[p.toLowerCase()];
    if (!m) throw fail(`${JSON.stringify(p)} is not a modifier`);
    mods[m] = true;
  }
  return { key: normalizeKey(key), mods };
}
