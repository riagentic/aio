/**
 * @module
 * Where an app that `am start` launches puts its window — and whether it is
 * allowed to open a tab in the human's browser.
 *
 * The complaint this answers, in the words of the person who has it: an agent
 * starts a windowed app, the window maps on the desktop the human is typing
 * into, and takes focus. Then the agent retries and it happens again. The same
 * hour, a browser-client app hands a URL to `xdg-open` and stacks tabs in the
 * user's real browser that aio cannot close afterwards.
 *
 * Both are the same defect with two mechanisms, and both have an existing fix
 * in this codebase that simply was not wired to `am start`: a nested X server
 * (server/nested-display.ts — what aio's own GUI tests have used for months),
 * and `AIO_NO_OPEN` (server/open-external.ts's documented override).
 *
 * ## What this does NOT do
 *
 * It does not decide that nested displays are a good idea for everybody. A
 * human who types `am start` at a terminal gets exactly what they got before:
 * their window, on their desktop, and a tab if the app opens one. Containment
 * is for the case where there is no human in the loop to want the window —
 * which `am` already detects the same way it decides between pretty output and
 * JSON (`detectMode`): is there a terminal on the other end.
 *
 * So the rule is narrow on purpose:
 *
 *   contain a launch ⟺ the caller is not interactive AND the user has not said
 *   otherwise AND there is a desktop session worth protecting.
 *
 * ## The escape hatch is one spelling
 *
 * `--display=current` (or `AIO_AM_DISPLAY=current`) turns ALL of it off — the
 * window goes where it always went and the tab opens. One switch for both
 * halves, because "leave my desktop alone" and "leave my browser alone" are
 * one preference, and two switches would mean someone sets one and is
 * surprised by the other.
 *
 * Never fatal. No Xephyr installed, no desktop to nest in, a spawn that fails
 * — every one of those falls back to the previous behaviour and says so. A
 * refusal to start the app would be a far worse outcome than a stolen focus.
 */
import {
  hasParentDisplay,
  nestedDisplayCookie,
  type NestedDisplayPick,
  nestedDisplayRange,
  pickNestedDisplay,
  startXephyrDetailed,
  XEPHYR_INSTALL_HINT,
  type XephyrStart,
} from "../server/nested-display.ts";

/** `--display=` / `AIO_AM_DISPLAY=`.
 *  - `auto` (default): contain only a non-interactive launch.
 *  - `isolated`: always use the nested display.
 *  - `current`: change nothing — the pre-existing behaviour, opt-out for both
 *    the window and the browser tab.
 *  - `:N`: a display you name and manage yourself (Xvfb, a second seat, a
 *    remote X). */
export type DisplayChoice = string;

/** The OS facts this policy reads. Injected so the decision can be tested
 *  without an X server on the box — the policy is the part that has bugs, and
 *  a test that needs a desktop is a test that does not run in CI. */
export type DisplayProbe = {
  /** Which nested display THIS USER should use: the first candidate that is
   *  theirs (up — reuse it) or free (start one there). Never another
   *  account's, whose socket being up says nothing about whose desktop it is
   *  (cc §10). Null when every candidate belongs to somebody else. */
  pick: () => NestedDisplayPick | null;
  /** Start Xephyr on `display`, with a cookie; `warning` when it came up
   *  without one. */
  start: (display: string) => XephyrStart;
  /** The cookie file on record for `display`, or null — what the child's
   *  `XAUTHORITY` must name to be let in. */
  cookie: (display: string) => string | null;
  hasParent: () => boolean;
};

const REAL: DisplayProbe = {
  pick: pickNestedDisplay,
  start: (display) => startXephyrDetailed(display),
  cookie: nestedDisplayCookie,
  hasParent: hasParentDisplay,
};

/** What `am start` should add to the child's environment, and what to tell the
 *  person watching. */
export type DisplayPlan = {
  /** Env additions. Empty means "exactly what am did before". */
  env: Record<string, string>;
  /** One line on stderr — always present when something was contained, so a
   *  window that does not appear where expected is never a mystery. */
  note?: string;
  /** Whether the reader has to DO anything about it. `note` is "here is what
   *  happened"; `warn` is "this one did not work and your desktop is about to
   *  be used". A diagnostic that does not say which is a diagnostic the
   *  reader has to guess at — pinned by tests/every-message-has-a-level. */
  level?: "note" | "warn";
};

/** THE spelling. `start` is a PASSTHROUGH verb, so this flag has no row in
 *  am-flags.ts's table — naming it here gives it the one home a gate can
 *  read, which is what keeps the agent brief from advertising a flag nothing
 *  parses. */
export const DISPLAY_FLAG = "--display";

/** `--display=<choice>` out of a raw argv, and the value to forward. Returns
 *  `null` when the flag is absent. Pure. @internal */
export function readDisplayFlag(args: readonly string[]): string | null {
  const pre = `${DISPLAY_FLAG}=`;
  const hit = args.find((a) => a.startsWith(pre));
  return hit ? hit.slice(pre.length) : null;
}

/** The choice in force: the flag, else the env, else `auto`. Pure. */
export function displayChoice(
  flag: string | null,
  env: string | undefined,
): DisplayChoice {
  return flag ?? (env && env.trim() !== "" ? env : "auto");
}

/** Valid spellings, for the refusal. A `--display=` we cannot read must be an
 *  error rather than a silent `auto`: silently ignoring the one flag whose job
 *  is "keep off my desktop" is the worst possible failure for it. */
export function validDisplayChoice(c: string): boolean {
  return c === "auto" || c === "isolated" || c === "current" ||
    /^:\d+(\.\d+)?$/.test(c);
}

/** THE decision. `gui` is whether the app opens a real window (electron or a
 *  client target); `interactive` is whether a human is on the other end of
 *  this `am` invocation. */
export function planDisplay(opts: {
  choice: DisplayChoice;
  gui: boolean;
  interactive: boolean;
  probe?: DisplayProbe;
  /** The caller's own `$DISPLAY` / `$XAUTHORITY`, for the one thing an
   *  uncontained launch still needs: a human who typed `DISPLAY=:77 am start`
   *  to watch their agent's display gets its cookie handed to the child, or
   *  the window they asked for never appears ("Authorization required"). */
  inheritedDisplay?: string;
  inheritedXauthority?: string;
  /** Whether the app could open a browser tab at all. `--client=server-only`
   *  (and `cli`) never hand a URL to anything, so "browser tabs suppressed"
   *  is not a fact about that launch — the env is still set (it costs
   *  nothing and one rule is better than two), the NOTE is not printed.
   *  Default true: every caller that does not say is the old behaviour. */
  tabs?: boolean;
}): DisplayPlan {
  const { choice, gui, interactive } = opts;
  const probe = opts.probe ?? REAL;
  /** DISPLAY plus the cookie for it when one is on record. */
  const onto = (display: string): Record<string, string> => {
    const cookie = probe.cookie(display);
    return cookie
      ? { DISPLAY: display, XAUTHORITY: cookie }
      : { DISPLAY: display };
  };
  /** An uncontained launch: `{}` — unless the inherited DISPLAY is one of
   *  OUR nested displays and no XAUTHORITY came with it, in which case the
   *  cookie is the only addition. Everything else is byte-for-byte inherited. */
  const untouched = (): DisplayPlan => {
    const d = opts.inheritedDisplay;
    if (!d || opts.inheritedXauthority) return { env: {} };
    const cookie = probe.cookie(d);
    return cookie ? { env: { XAUTHORITY: cookie } } : { env: {} };
  };

  // The opt-out, and the only branch that is byte-for-byte the old behaviour.
  if (choice === "current") return untouched();

  // A display the caller named is theirs to manage — we do not probe it, do
  // not start anything, and do not second-guess it. The cookie rides along
  // only when it is one of ours (`--display=:77` to reach the agent's screen).
  if (choice.startsWith(":")) {
    return {
      env: { ...onto(choice), AIO_NO_OPEN: "1" },
      level: "note",
      note: `window → ${choice} (you named it); browser tabs suppressed`,
    };
  }

  const wantContained = choice === "isolated" || !interactive;
  if (!wantContained) return untouched();

  // From here the launch IS contained. `AIO_NO_OPEN` travels with that
  // decision ALWAYS, including when there is no display to nest in and
  // including for a non-GUI client: a nested display keeps a spawned window
  // off the desktop but does nothing about the app handing a URL to
  // `xdg-open`, which reaches the real browser in the real session and leaves
  // a tab aio cannot close. Stacking one per launch is the failure people
  // actually report.
  const env: Record<string, string> = { AIO_NO_OPEN: "1" };

  if (!gui) {
    if (opts.tabs === false) return { env };
    return {
      env,
      level: "note",
      note: "no human on this terminal — browser tabs suppressed " +
        "(--display=current to allow them)",
    };
  }

  if (!probe.hasParent()) {
    // Nothing to nest inside, and no focus to steal either. Contain the tab,
    // leave the window alone.
    return {
      env,
      level: "note",
      note: "no desktop session — nothing to contain",
    };
  }

  // Whose nested display: this user's, or a free number — never another
  // account's. `am start` used to reuse `:77` because its socket was up, and
  // sent one user's app onto another user's screen (cc §10).
  const pick = probe.pick();
  if (pick === null) {
    return {
      env,
      level: "warn",
      note: `every nested display from ${nestedDisplayRange()} belongs to ` +
        `another user — this app's window will open on the REAL desktop ` +
        `and may take focus. Pass --display=:N for a display you manage`,
    };
  }

  if (pick.up) {
    return {
      env: { ...env, ...onto(pick.display) },
      level: "note",
      note: `window → ${pick.display} (your nested display, already up) ` +
        `— not your desktop. --display=current to use your desktop instead` +
        (pick.secured ? "" : `. NOTE: no access cookie is on file for ` +
          `${pick.display} — it was started by hand or by an older aio and ` +
          `may be open to every local account; close it and let am start ` +
          `one with access control`),
    };
  }

  const started = probe.start(pick.display);
  if (started.ok) {
    return {
      env: { ...env, ...onto(pick.display) },
      level: started.warning ? "warn" : "note",
      note: `started a nested X server on ${pick.display} — this app's ` +
        `window opens THERE, not on your desktop. It stays up on purpose ` +
        `(closing it per run is the flicker it exists to remove); close it ` +
        `yourself when you are done. --display=current to opt out` +
        (started.warning ? `. ${started.warning}` : ""),
    };
  }

  // Xephyr is not installed. Degrade loudly: the window is about to appear on
  // someone's desktop and they should know why.
  return {
    env,
    // The one branch the reader may want to ACT on: nothing was contained,
    // and a window is about to appear on a desktop someone is using.
    level: "warn",
    note: `Xephyr not found — this app's window will open on the REAL ` +
      `desktop and may take focus. Install it (${XEPHYR_INSTALL_HINT}), ` +
      `or pass --display=:N for a display you manage`,
  };
}

/** Is a human on the other end of this `am` invocation?
 *
 *  The same fact `detectMode` keys output format on — a terminal on stdout.
 *  Deliberately the same probe and not a second heuristic: `am` already tells
 *  a person from a pipe exactly this way, and a second answer to one question
 *  is how two surfaces start disagreeing about who they are talking to.
 *
 *  A closed or absent stdout answers "not a human", which is the safe side:
 *  it contains a launch that might not have needed containing, rather than
 *  putting a window on a desktop that might have one. */
export function amIsInteractive(): boolean {
  try {
    return Deno.stdout.isTerminal();
  } catch {
    // aio-ok: no stdout to ask (a detached caller, a closed pipe).
    return false;
  }
}
