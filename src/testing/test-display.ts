/**
 * @module
 * Where a test's GUI windows go — so a test run cannot steal your focus.
 *
 * A UI test that opens a real window opens it on YOUR desktop, takes focus
 * mid-keystroke, and does it again on every retry. That is not a cosmetic
 * annoyance: it makes the suite unrunnable while you work, which means it gets
 * run less, which is the actual cost.
 *
 * The fix is a nested X server (Xephyr) — a window that is its own desktop.
 * Everything the tests open lives inside it and cannot take focus from the
 * session outside it.
 *
 * The part that matters, and the reason this module exists rather than a flag:
 *
 *   **the display is started ONCE and left running. The tests never stop it.**
 *
 * A harness that starts Xephyr and kills it per run reproduces the original
 * problem exactly — a window appearing and vanishing on every test invocation,
 * grabbing focus as it maps. So: the user starts it (`scripts/xephyr.sh`) and
 * the user closes it. If it is not running when tests need it, this starts it
 * DETACHED and still never closes it. It outlives the run on purpose.
 *
 * No Xephyr installed → say so once, loudly, and fall back to the real display.
 * Refusing to run the tests would be worse than a stolen focus.
 */

import {
  AIO_NESTED_DISPLAY,
  AIO_NESTED_SCREEN,
  displayIsUp,
  startXephyr,
  XEPHYR_INSTALL_HINT,
} from "../server/nested-display.ts";

export { displayIsUp, startXephyr };

/** The display aio's tests use — THE nested display, shared with `am start`
 *  when it contains an agent's window. One number means one Xephyr on the box
 *  (see server/nested-display.ts); two would mean two nested desktops and a
 *  person having to guess which one their app went to. */
export const AIO_TEST_DISPLAY: string = AIO_NESTED_DISPLAY;

/** Default geometry — big enough for a real app layout, small enough to leave
 *  the screen usable. */
export const AIO_TEST_SCREEN: string = AIO_NESTED_SCREEN;

let _resolved: string | null = null;
let _warned = false;

/** THE display every GUI child of a test should be launched on.
 *
 *  Order, and the reason for each step:
 *   1. `$AIO_TEST_DISPLAY` — an explicit choice always wins (CI with Xvfb, a
 *      user who already runs a nested session, a remote X display).
 *   2. an Xephyr already up on {@linkcode AIO_TEST_DISPLAY} — the normal case
 *      once someone has run `scripts/xephyr.sh`.
 *   3. start one, detached, and LEAVE IT RUNNING.
 *   4. no Xephyr on the box → the real `$DISPLAY`, with one loud warning that
 *      says what to install and why the focus jumped.
 *
 *  Cached: the answer cannot change usefully within one test process, and
 *  re-probing per window is how a helper becomes a cost. */
export function testDisplay(): string {
  if (_resolved !== null) return _resolved;
  if (Deno.build.os !== "linux") {
    // macOS/Windows have no nested-X equivalent worth pretending about.
    _resolved = Deno.env.get("DISPLAY") ?? "";
    return _resolved;
  }
  const explicit = Deno.env.get("AIO_TEST_DISPLAY");
  if (explicit) return (_resolved = explicit);
  if (displayIsUp(AIO_TEST_DISPLAY)) return (_resolved = AIO_TEST_DISPLAY);
  // No parent display: a headless box or CI. Xephyr is a NESTED server — it
  // needs a session to open its window inside — and there is no focus to steal
  // here anyway. Trying anyway costs a doomed spawn and a 3s wait per run.
  if (!Deno.env.get("DISPLAY")) return (_resolved = "");
  // Both arguments spelled out, not defaulted: the shared primitive owns the
  // fallbacks, but what a TEST display is (this number, this geometry) is
  // this module's decision, and `scripts/xephyr.sh` reads $AIO_TEST_SCREEN
  // expecting the same value. A default that silently agrees today is the
  // drift this repo keeps finding.
  if (startXephyr(AIO_TEST_DISPLAY, AIO_TEST_SCREEN)) {
    console.error(
      `[aio:test] started Xephyr on ${AIO_TEST_DISPLAY} for this and every ` +
        `later run — test windows open THERE, not on your desktop. It stays ` +
        `up on purpose; close it yourself when you are done (or run ` +
        `scripts/xephyr.sh to manage it).`,
    );
    return (_resolved = AIO_TEST_DISPLAY);
  }
  if (!_warned) {
    _warned = true;
    console.error(
      `[aio:test] Xephyr not found — GUI tests will open on your REAL desktop ` +
        `and take focus. Install it (${XEPHYR_INSTALL_HINT}), ` +
        `or point $AIO_TEST_DISPLAY at a display you control.`,
    );
  }
  return (_resolved = Deno.env.get("DISPLAY") ?? "");
}

/** The env additions a GUI child process needs to land on the test display.
 *  Empty when there is nothing to contain (no display at all — a headless CI
 *  box), so spreading it is always safe. */
export function testDisplayEnv(): Record<string, string> {
  const d = testDisplay();
  // AIO_NO_OPEN travels with the display, ALWAYS — including on a headless box
  // where `testDisplay()` returns nothing.
  //
  // A nested display keeps a spawned app's own window off your desktop, but it
  // does nothing about the app handing a URL to `xdg-open`: that reaches the
  // real browser, in the real session, and leaves a tab aio cannot close.
  // Stacking one per spawned app is the failure people actually report. The
  // display and "do not open anything" are the same decision — a test's UI
  // belongs to the test — so they ship together and cannot be set apart.
  return d ? { DISPLAY: d, AIO_NO_OPEN: "1" } : { AIO_NO_OPEN: "1" };
}

/** Test seam: forget the cached answer. @internal */
export function _resetTestDisplay(): void {
  _resolved = null;
  _warned = false;
}
