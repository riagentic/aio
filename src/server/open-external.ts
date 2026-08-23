// open-external.ts — the per-OS "open this on the desktop" launcher, once.
//
// Three field-report apps (a disk analyzer, a config manager, this repo's own
// dev-server fallback) each re-derived the darwin/windows/linux ternary; the
// framework itself carried two more copies. One exported helper, fail-loud.

import { log } from "../diagnostics/logger-api.ts";

/** Open a file, folder or URL with the OS default handler (`open` /
 *  `start` / `xdg-open`) — the desktop app pattern "reveal in file manager" /
 *  "open in browser", from a cell method or serverFn. Server-only.
 *
 *  Resolves when the launcher hands off; rejects (never silently) when the
 *  launcher is missing or refuses the target. */
export async function openExternal(target: string): Promise<void> {
  if (typeof target !== "string" || target.length === 0) {
    throw new Error("openExternal: target must be a non-empty string");
  }
  const os = Deno.build.os;
  // Windows `start` is a cmd builtin, not an executable — it must go through
  // `cmd /c`, with an empty title argument so a quoted path is not eaten as
  // the window title.
  const [cmd, args]: [string, string[]] = os === "darwin"
    ? ["open", [target]]
    : os === "windows"
    ? ["cmd", ["/c", "start", "", target]]
    : ["xdg-open", [target]];
  const child = new Deno.Command(cmd, {
    args,
    stdout: "null",
    stderr: "null",
  }).spawn();
  const status = await child.status;
  if (!status.success) {
    throw new Error(
      `openExternal: ${cmd} exited with code ${status.code} for "${target}"`,
    );
  }
}

/** Is there a desktop for a window to appear on?
 *
 *  A DIFFERENT question from "does this client have a UI", and the two were
 *  conflated: `isHeadless` is derived purely from the client mode, so an
 *  Electron app on a machine with no display still tried to launch Electron.
 *  That fails — and because the window going away is what shuts a desktop app
 *  down, the app then exited. An app on a headless box should keep SERVING,
 *  not die trying to open a window that has nowhere to go.
 *
 *  Only linux is answerable this way. macOS and Windows have a session
 *  whenever someone is logged in, so they answer true and let the launcher
 *  report its own failure rather than having this guess for it. */
export function hasDesktopSession(): boolean {
  if (Deno.build.os !== "linux") return true;
  return !!(Deno.env.get("DISPLAY") ?? Deno.env.get("WAYLAND_DISPLAY"));
}

/** THE decider for "is a window allowed to appear on somebody's desktop right
 *  now", and the reason it exists:
 *
 *  A tab opened in the user's REAL browser is the one thing aio cannot clean up
 *  after itself. An Electron window is a child process — it can be closed. A
 *  tab handed to an already-running Firefox belongs to Firefox; the app exits
 *  and the tab stays. Run a suite that boots twenty apps and you have twenty
 *  tabs of the same app, each one having stolen focus as it appeared, none of
 *  them yours to close. That is not a tidiness problem, it is what makes a test
 *  suite unrunnable while a person is working.
 *
 *  So the rule is not "close them afterwards" — it is DO NOT OPEN ONE unless a
 *  human is plausibly sitting there waiting for it:
 *
 *   • `AIO_NO_OPEN=1` — the explicit override, for any harness that knows
 *     better than this heuristic.
 *   • a test process — `AIO_TEST_DISPLAY` is set by the test display helper,
 *     and `libraryMode` says a test or a host app owns this process.
 *   • CI — no one is watching, and a launcher there either fails or, worse,
 *     succeeds against a virtual display nobody sees.
 *   • no desktop at all — no `DISPLAY`/`WAYLAND_DISPLAY` on linux means
 *     `xdg-open` has nothing to open into.
 *
 *  Refusing is never silent: the URL is logged, which is what a person needs
 *  anyway. */
export function mayOpenExternal(): { ok: true } | { ok: false; why: string } {
  if (Deno.env.get("AIO_NO_OPEN")) {
    return { ok: false, why: "AIO_NO_OPEN is set" };
  }
  // Set by src/testing/test-display.ts for every spawned child, so a test that
  // routes its children through the nested display also inherits this refusal.
  if (Deno.env.get("AIO_TEST_DISPLAY")) {
    return { ok: false, why: "a test display is in use" };
  }
  if (Deno.env.get("CI")) return { ok: false, why: "running under CI" };
  if (!hasDesktopSession()) {
    return {
      ok: false,
      why: "no desktop session (no DISPLAY/WAYLAND_DISPLAY)",
    };
  }
  return { ok: true };
}

/** Framework-internal: best-effort variant for the dev-server's own
 *  browser-open fallbacks — logs instead of throwing (the server keeps
 *  serving either way; the URL is printed for a human to click).
 *
 *  Gated by {@linkcode mayOpenExternal}: a browser tab is the one window aio
 *  cannot take back, so it is opened only when someone is there to see it. */
export function openExternalBestEffort(target: string): void {
  const allowed = mayOpenExternal();
  if (!allowed.ok) {
    log.info(
      `not opening a browser (${allowed.why}) — the app is at ${target}`,
    );
    return;
  }
  openExternal(target).catch(() => {
    log.info(`open ${target} in your browser`);
  });
}
