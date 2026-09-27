// key-chord.ts — the ONE reading of a key spelling, shared by `am trigger`
// and testUI's `press`/`keyDown`/`keyUp`. Pure; not imported by the browser
// bundle (the live client receives the already-parsed key + modifiers).

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
