/**
 * @module
 * A nested X display — the mechanism, with no policy attached.
 *
 * A GUI window that maps on the active display takes focus mid-keystroke, and
 * does it again on every retry. That is not cosmetic: it is what makes a suite
 * unrunnable while a person is working, and what makes an agent driving a
 * windowed app hostile to the human whose machine it is running on.
 *
 * Xephyr solves it — a nested X server is a window that is its own desktop, so
 * everything inside it is contained and nothing inside it can take focus from
 * the session outside.
 *
 * Two callers want this and they want it on THE SAME display: aio's own test
 * suite (src/testing/test-display.ts) and `am start` when the caller is not a
 * human (src/am/am-display.ts). One display number means one Xephyr per user
 * on the box, which is the whole reason this file exists instead of a second
 * copy of the spawn: a second number would mean two nested desktops, and the
 * user would have to know which of them their app went to.
 *
 * The load-bearing rule, and the reason this is a module rather than a flag:
 *
 *   **the display is started ONCE and left running. Nobody stops it.**
 *
 * A caller that starts Xephyr and kills it per run reproduces the original
 * problem exactly — a window appearing and vanishing, grabbing focus as it
 * maps. So it outlives the process that started it, on purpose.
 *
 * ## Access control — the display is YOURS, not the machine's
 *
 * A nested X server is a full X server: whoever can connect to it can read
 * every window on it, screenshot it, and send it keystrokes. Started with
 * `-ac` (no access control), which is what this did until 1.0.3, that was
 * every local account — and `am start` sent a second user's app to the first
 * user's `:77` because the socket was up, without asking whose it was (field
 * report cc §10, reproduced: `XAUTHORITY=/dev/null xdpyinfo -display :77`
 * opened another user's screen).
 *
 * So two rules, both here so no caller can get one without the other:
 *
 * 1. **Xephyr starts with a cookie** (`-auth`), an MIT-MAGIC-COOKIE-1 written
 *    by this module into the user's private runtime directory. Every child
 *    aio sends to the display gets `XAUTHORITY` pointing at it
 *    ({@linkcode nestedDisplayEnv}); nobody else can present it.
 * 2. **A display is reused only when its socket is owned by this uid**
 *    ({@linkcode pickNestedDisplay}). Another user's `:77` is skipped, and the
 *    next free number is this user's — so two accounts on one box each get
 *    their own nested desktop, never each other's.
 *
 * POLICY lives with each caller, because the two differ: a test always wants
 * containment, `am start` only wants it when there is a human to protect and
 * they have not said otherwise.
 */
import { join } from "@std/path";
import { privateDirRefusal, selfUid } from "./dir-permissions.ts";

/** THE nested display every aio caller tries first.
 *
 *  Fixed, not allocated: a stable number is what lets one Xephyr, started once,
 *  serve every later run — and what lets a person find their agent's window.
 *  High enough not to collide with a real session (`:0`, `:1`) or with the
 *  displays a desktop's own nested tools tend to claim. When it belongs to
 *  ANOTHER user, {@linkcode pickNestedDisplay} moves on to the next number. */
export const AIO_NESTED_DISPLAY: string = ":77";

/** How many numbers from {@linkcode AIO_NESTED_DISPLAY} upward are tried
 *  before giving up: one per local account that runs aio at the same time. */
export const AIO_NESTED_DISPLAY_CANDIDATES: number = 10;

/** Default geometry — big enough for a real app layout, small enough to leave
 *  the screen usable. */
export const AIO_NESTED_SCREEN: string = "1280x900";

/** `:77` → `77`; `:77.0` → `77`. */
function displayNumber(display: string): string {
  return display.replace(/^:/, "").split(".")[0]!;
}

/** The socket an X server on `display` listens on. */
function displaySocket(display: string): string {
  return `/tmp/.X11-unix/X${displayNumber(display)}`;
}

/** True when an X server is already listening on `display`.
 *
 *  Checked by its socket rather than by running a client: `xdpyinfo` is not
 *  installed everywhere, and spawning a probe process per call is exactly the
 *  kind of cost that makes a helper get skipped. */
export function displayIsUp(display: string): boolean {
  try {
    Deno.statSync(displaySocket(display));
    return true;
  } catch {
    return false;
  }
}

/** Whose X server is on `display`: `"mine"` (this uid owns its socket),
 *  `"other"` (another account's — never to be reused), or `"none"` (nothing
 *  is listening there). A uid this process cannot read counts as `"mine"`:
 *  "cannot tell" must not refuse, and a box where that happens (Windows, a
 *  run without --allow-sys) is not the shared multi-user box this guards. */
export type DisplayOwner = "mine" | "other" | "none";
export function displayOwner(display: string): DisplayOwner {
  let st: Deno.FileInfo;
  try {
    st = Deno.statSync(displaySocket(display));
  } catch {
    return "none";
  }
  const me = selfUid();
  if (st.uid === null || st.uid === undefined || me === null) return "mine";
  return st.uid === me ? "mine" : "other";
}

/** The private, per-user directory the display cookies live in — the same
 *  `<runtime>/aio` that holds this user's control sockets, with the same
 *  uid-scoped fallback when that one belongs to somebody else. Null when no
 *  private directory can be had, which is when a cookie cannot be kept. */
function cookieDir(): string | null {
  if (Deno.build.os === "windows") return null;
  const base = Deno.env.get("XDG_RUNTIME_DIR") ?? "/tmp";
  const prepare = (dir: string): boolean => {
    try {
      Deno.mkdirSync(dir, { recursive: true });
    } catch {
      // aio-ok: exists already — the stat below is the real check
    }
    try {
      Deno.chmodSync(dir, 0o700);
    } catch {
      // aio-ok: not ours to chmod — precisely what the stat below is for
    }
    try {
      const st = Deno.statSync(dir);
      return st.isDirectory && privateDirRefusal(dir, st.mode, st.uid) === null;
    } catch {
      return false;
    }
  };
  const shared = join(base, "aio");
  if (prepare(shared)) return shared;
  const uid = selfUid();
  if (uid === null) return null;
  const scoped = join(base, `aio-u${uid}`);
  return prepare(scoped) ? scoped : null;
}

/** Where the cookie for `display` is kept, when one is — an `.Xauthority`
 *  file holding exactly one entry, readable by its owner only. */
export function nestedDisplayCookieFile(display: string): string | null {
  const dir = cookieDir();
  return dir ? join(dir, `xephyr-${displayNumber(display)}.auth`) : null;
}

/** The cookie file for `display` if one is on file, else null. */
export function nestedDisplayCookie(display: string): string | null {
  const file = nestedDisplayCookieFile(display);
  if (!file) return null;
  try {
    return Deno.statSync(file).isFile ? file : null;
  } catch {
    return null;
  }
}

/** One `.Xauthority` record: the bytes libXau reads and the X server loads.
 *
 *  Layout (every length a big-endian u16): family, address, number, name,
 *  data. Family `0xffff` is `FamilyWild` — it matches any address, so a
 *  laptop whose hostname changes between the write and the read is never
 *  stranded (an `xauth add :77 . …` entry is tied to the hostname it was
 *  written on). The server side ignores family and address entirely and
 *  compares only name + data. Exported for the test that pins the bytes. */
export function xauthorityEntry(
  display: string,
  cookie: Uint8Array,
): Uint8Array {
  const enc = new TextEncoder();
  const fields = [
    new Uint8Array(0), // address — none, FamilyWild
    enc.encode(displayNumber(display)),
    enc.encode("MIT-MAGIC-COOKIE-1"),
    cookie,
  ];
  const out = new Uint8Array(
    2 + fields.reduce((n, f) => n + 2 + f.length, 0),
  );
  let at = 0;
  const u16 = (n: number) => {
    out[at++] = (n >> 8) & 0xff;
    out[at++] = n & 0xff;
  };
  u16(0xffff);
  for (const f of fields) {
    u16(f.length);
    out.set(f, at);
    at += f.length;
  }
  return out;
}

/** Write a fresh cookie for `display` and return the file, or null (with the
 *  reason in `problem`) when no private place exists to keep it. A new cookie
 *  on every start: the file describes the server that is about to run, never
 *  an earlier one. */
function writeNestedDisplayCookie(
  display: string,
): { file: string; problem?: undefined } | { file: null; problem: string } {
  const file = nestedDisplayCookieFile(display);
  if (!file) {
    return {
      file: null,
      problem: `no private runtime directory for the display cookie (set ` +
        `$XDG_RUNTIME_DIR to a directory you own)`,
    };
  }
  const cookie = new Uint8Array(16);
  crypto.getRandomValues(cookie);
  try {
    Deno.writeFileSync(file, xauthorityEntry(display, cookie), {
      mode: 0o600,
    });
    Deno.chmodSync(file, 0o600); // the mode applies to a NEW file only
    return { file };
  } catch (e) {
    return {
      file: null,
      problem: `could not write the display cookie ${file} (${
        e instanceof Error ? e.message : e
      })`,
    };
  }
}

/** The env a child needs to land on `display`: `DISPLAY`, plus `XAUTHORITY`
 *  naming its cookie when one is on file. A display without a cookie on file
 *  (one somebody started by hand, or with an older aio) gets `DISPLAY` alone,
 *  exactly as before. */
export function nestedDisplayEnv(display: string): Record<string, string> {
  const cookie = nestedDisplayCookie(display);
  return cookie
    ? { DISPLAY: display, XAUTHORITY: cookie }
    : { DISPLAY: display };
}

/** What starting Xephyr came to. `warning` is set when it is up but WITHOUT
 *  access control — the one degradation this module allows, said out loud. */
export type XephyrStart = { ok: boolean; warning?: string };

/** @internal The spawn itself, returned so a test can stop what it started.
 *  Null when Xephyr is not installed. */
export function _spawnXephyr(
  display: string,
  screen: string,
  authFile: string | null,
  /** Env for the Xephyr process itself — which PARENT display it opens its
   *  window on (a test nests its throwaway server inside the shared one, so
   *  no window touches the desktop). Inherited when omitted. */
  env?: Record<string, string>,
): Deno.ChildProcess | null {
  try {
    return new Deno.Command("Xephyr", {
      args: [
        "-screen",
        screen,
        "-resizeable",
        ...(authFile ? ["-auth", authFile] : ["-ac"]),
        display,
      ],
      ...(env ? { env: { ...Deno.env.toObject(), ...env } } : {}),
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
  } catch {
    return null; // not installed
  }
}

/** Start Xephyr on `display`, DETACHED, with a fresh cookie, and do not wait
 *  for it beyond its socket appearing.
 *
 *  Detached is the whole point: the child must outlive this process, or the
 *  next run starts another one and the flicker is back. `ok: false` when
 *  Xephyr is not installed — every caller degrades rather than fails, because
 *  refusing to run is worse than a stolen focus. When the cookie cannot be
 *  kept (no private directory), the server still starts, with `-ac`, and
 *  `warning` says so: an unguarded display is the previous behaviour and a
 *  window that never appears is worse — but it is never silent. */
export function startXephyrDetailed(
  display: string = AIO_NESTED_DISPLAY,
  screen: string = AIO_NESTED_SCREEN,
): XephyrStart {
  const cookie = writeNestedDisplayCookie(display);
  const child = _spawnXephyr(display, screen, cookie.file);
  if (!child) return { ok: false };
  child.unref();
  // Give the server a moment to create its socket. Bounded and small: a slow
  // start just means this window lands on the fallback display rather than
  // failing.
  const deadline = Date.now() + 3000;
  let up = false;
  while (Date.now() < deadline) {
    if (displayIsUp(display)) {
      up = true;
      break;
    }
    // Busy-wait deliberately: this is a one-shot, and making it async would
    // push `await` into every GUI-launching call site.
    const until = Date.now() + 50;
    while (Date.now() < until) { /* spin */ }
  }
  if (!up) up = displayIsUp(display);
  if (!up) return { ok: false };
  return cookie.file ? { ok: true } : {
    ok: true,
    warning: `${display} is up WITHOUT access control — ${cookie.problem}. ` +
      `Any local account can read this display until it is closed.`,
  };
}

/** {@linkcode startXephyrDetailed} for callers that only need yes/no. */
export function startXephyr(
  display: string = AIO_NESTED_DISPLAY,
  screen: string = AIO_NESTED_SCREEN,
): boolean {
  return startXephyrDetailed(display, screen).ok;
}

/** Which nested display THIS USER should use. */
export type NestedDisplayPick = {
  display: string;
  /** Already listening (and owned by this uid) — reuse it, start nothing. */
  up: boolean;
  /** A cookie is on file for it. False only for a display that is up but was
   *  started by hand or by an older aio, so it may be running open (`-ac`). */
  secured: boolean;
};

/** The first display from {@linkcode AIO_NESTED_DISPLAY} upward that is either
 *  this uid's (up, reused) or free (to be started). Another account's display
 *  is skipped, never reused: a socket being up says nothing about whose
 *  desktop it is. Null when every candidate belongs to somebody else. */
export function pickNestedDisplay(): NestedDisplayPick | null {
  const first = Number(displayNumber(AIO_NESTED_DISPLAY));
  for (let i = 0; i < AIO_NESTED_DISPLAY_CANDIDATES; i++) {
    const display = `:${first + i}`;
    const owner = displayOwner(display);
    if (owner === "other") continue;
    const up = owner === "mine";
    return {
      display,
      up,
      secured: up ? nestedDisplayCookie(display) !== null : true,
    };
  }
  return null;
}

/** The candidates {@linkcode pickNestedDisplay} walks, for a message. */
export function nestedDisplayRange(): string {
  const first = Number(displayNumber(AIO_NESTED_DISPLAY));
  return `:${first}–:${first + AIO_NESTED_DISPLAY_CANDIDATES - 1}`;
}

/** What to tell someone whose box has no Xephyr — the install line for the
 *  three families that cover almost every developer machine. Shared so the
 *  test helper and `am` cannot drift on the advice they give. */
export const XEPHYR_INSTALL_HINT: string =
  "Debian/Ubuntu: apt install xserver-xephyr, " +
  "Fedora: dnf install xorg-x11-server-Xephyr, " +
  "Arch: pacman -S xorg-server-xephyr";

/** Is there a desktop session for a nested server to open INSIDE?
 *
 *  Xephyr is nested: with no parent display there is nothing to nest in — and
 *  no focus to steal either, so containment is moot. Callers use this to skip
 *  a doomed spawn and its 3-second wait. */
export function hasParentDisplay(): boolean {
  return Deno.build.os === "linux" && !!Deno.env.get("DISPLAY");
}
