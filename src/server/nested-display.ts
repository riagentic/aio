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
 * human (src/am/am-display.ts). One display number means one Xephyr on the
 * box, which is the whole reason this file exists instead of a second copy of
 * the spawn: a second number would mean two nested desktops, and the user
 * would have to know which of them their app went to.
 *
 * The load-bearing rule, and the reason this is a module rather than a flag:
 *
 *   **the display is started ONCE and left running. Nobody stops it.**
 *
 * A caller that starts Xephyr and kills it per run reproduces the original
 * problem exactly — a window appearing and vanishing, grabbing focus as it
 * maps. So it outlives the process that started it, on purpose.
 *
 * POLICY lives with each caller, because the two differ: a test always wants
 * containment, `am start` only wants it when there is a human to protect and
 * they have not said otherwise.
 */

/** THE nested display, shared by every aio caller that needs one.
 *
 *  Fixed, not allocated: a stable number is what lets one Xephyr, started once,
 *  serve every later run — and what lets a person find their agent's window.
 *  High enough not to collide with a real session (`:0`, `:1`) or with the
 *  displays a desktop's own nested tools tend to claim. */
export const AIO_NESTED_DISPLAY: string = ":77";

/** Default geometry — big enough for a real app layout, small enough to leave
 *  the screen usable. */
export const AIO_NESTED_SCREEN: string = "1280x900";

/** True when an X server is already listening on `display`.
 *
 *  Checked by its socket rather than by running a client: `xdpyinfo` is not
 *  installed everywhere, and spawning a probe process per call is exactly the
 *  kind of cost that makes a helper get skipped. */
export function displayIsUp(display: string): boolean {
  const n = display.replace(/^:/, "").split(".")[0];
  try {
    Deno.statSync(`/tmp/.X11-unix/X${n}`);
    return true;
  } catch {
    return false;
  }
}

/** Start Xephyr on `display`, DETACHED, and do not wait for it.
 *
 *  Detached is the whole point: the child must outlive this process, or the
 *  next run starts another one and the flicker is back. Returns false when
 *  Xephyr is not installed — every caller degrades rather than fails, because
 *  refusing to run is worse than a stolen focus. */
export function startXephyr(
  display: string = AIO_NESTED_DISPLAY,
  screen: string = AIO_NESTED_SCREEN,
): boolean {
  try {
    new Deno.Command("Xephyr", {
      args: ["-screen", screen, "-resizeable", "-ac", display],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn().unref();
  } catch {
    return false; // not installed
  }
  // Give the server a moment to create its socket. Bounded and small: a slow
  // start just means this window lands on the fallback display rather than
  // failing.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (displayIsUp(display)) return true;
    // Busy-wait deliberately: this is a one-shot, and making it async would
    // push `await` into every GUI-launching call site.
    const until = Date.now() + 50;
    while (Date.now() < until) { /* spin */ }
  }
  return displayIsUp(display);
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
