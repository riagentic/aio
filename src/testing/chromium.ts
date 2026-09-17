/**
 * @module
 * THE headless Chromium a test launches — found, spawned, contained and
 * killed in one place. `testBrowser` hands the process to the test; the test
 * video recorder drives it over CDP. One launcher, so a flag that keeps a
 * browser off the developer's desktop (or out of their keychain) cannot be
 * present for one and missing for the other.
 */

import { testDisplayEnv } from "./test-display.ts";
import { dropTempDir, tempDir } from "./temp-dir.ts";
import { cdpConnect, type CdpSession } from "../media/cdp.ts";

const CHROMIUM_PATHS = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

/** Locate a headless-capable Chromium/Chrome binary, or null. */
export function findChromium(): string | null {
  const env = Deno.env.get("CHROMIUM_BIN") ?? Deno.env.get("CHROME_BIN");
  if (env) return env;
  for (const c of CHROMIUM_PATHS) {
    try {
      Deno.statSync(c);
      return c;
    } catch {
      // aio-ok: this is a PROBE of a list of well-known install paths, and
      // "not here" is the answer for all but one of them on every machine.
      // The absence is the information; the caller's `null` (and the clear
      // "no headless Chromium/Chrome found" throw above it) is where a real
      // miss is reported.
    }
  }
  return null;
}

/** Pure-ish probe: does `bin` name an existing file — a path as given, or a
 *  bare command name found on `$PATH` (how `Deno.Command` resolves it)? */
function binExists(bin: string): boolean {
  const isFile = (p: string) => {
    try {
      return Deno.statSync(p).isFile;
    } catch {
      // aio-ok: a probe — "no file here" is the answer, and the caller turns
      // a final `false` into a throw that names the path.
      return false;
    }
  };
  if (/[\\/]/.test(bin)) return isFile(bin);
  const sep = Deno.build.os === "windows" ? ";" : ":";
  const exts = Deno.build.os === "windows" ? ["", ".exe"] : [""];
  return (Deno.env.get("PATH") ?? "").split(sep).some((d) =>
    d !== "" && exts.some((x) => isFile(`${d}/${bin}${x}`))
  );
}

/** The binary to launch — `browserPath`, else {@linkcode findChromium} — or a
 *  throw that says what to install. `who` is the tag that opens the line (`[testBrowser]`).
 *
 *  An EXPLICIT choice (`browserPath`, `$CHROMIUM_BIN`, `$CHROME_BIN`) is
 *  checked here, synchronously: returned unchecked, a typo surfaced later as
 *  a raw "Failed to spawn" — after a whole recorded test had run, for
 *  `testUI --video` — naming neither the setting nor the fix. */
export function chromiumBin(who: string, browserPath?: string): string {
  const bin = browserPath ?? findChromium();
  const fix = "install one, set $CHROMIUM_BIN, or pass { browserPath }.";
  if (!bin) {
    throw new Error(`${who} no headless Chromium/Chrome found — ${fix}`);
  }
  if (!binExists(bin)) {
    const source = browserPath !== undefined
      ? `{ browserPath: ${JSON.stringify(bin)} }`
      : Deno.env.get("CHROMIUM_BIN")
      ? `$CHROMIUM_BIN=${bin}`
      : `$CHROME_BIN=${bin}`;
    const where = /[\\/]/.test(bin) ? "does not exist" : "is not found on PATH";
    throw new Error(
      `${who} no headless Chromium/Chrome at ${bin}: ${source} ${where} — ` +
        fix,
    );
  }
  return bin;
}

/** A launched headless Chromium the caller owns. */
export type LaunchedChromium = {
  proc: Deno.ChildProcess;
  /** The temp profile directory (removed on close). */
  profile: string;
  /** Kill the browser, wait for it, remove the profile. Idempotent. */
  close(): Promise<void>;
};

/** Spawn headless Chromium with `args` (URL last). The process is killed and
 *  its profile removed on `close()`, and an `unload` backstop kills it even if
 *  Deno dies mid-test (the orphaned-chrome leak). */
export async function launchChromium(
  bin: string,
  args: readonly string[],
): Promise<LaunchedChromium> {
  const profile = await tempDir("aio-test-browser-");
  const proc = new Deno.Command(bin, {
    args: [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      `--password-store=basic`,
      `--use-mock-keychain`,
      `--user-data-dir=${profile}`,
      ...args,
    ],
    stdin: "null",
    stdout: "null",
    stderr: "null",
    // Contained even though `--headless=new` opens nothing today: the day
    // someone drops that flag to debug a test, the window must land in the
    // nested display and not on the developer's desktop. Cheap now,
    // impossible to remember later.
    env: { ...Deno.env.toObject(), ...testDisplayEnv() },
  }).spawn();

  let killed = false;
  const kill = (signal: Deno.Signal = "SIGTERM") => {
    if (killed && signal === "SIGTERM") return;
    killed = true;
    try {
      proc.kill(signal);
    } catch (e) {
      // A browser that already exited is the ordinary case — `close()` runs
      // after the tab may well have gone by itself, and Deno answers that
      // with "child process has already terminated". ANY other failure
      // means a live browser this harness did not kill, which is precisely
      // the orphaned-chrome leak the `unload` backstop above exists to
      // prevent — so it is never swallowed.
      if (!/already terminated/i.test(String(e))) {
        console.error(
          `[testBrowser] could not kill the browser (pid ${proc.pid}): ${e}`,
        );
      }
    }
  };
  // Backstop: if the Deno process unloads without close(), don't leak chrome.
  const onUnload = () => kill();
  addEventListener("unload", onUnload);

  let closing: Promise<void> | null = null;
  const close = () =>
    closing ??= (async () => {
      removeEventListener("unload", onUnload);
      kill();
      // Bounded: a browser that ignores SIGTERM (a loaded box, a renderer
      // stuck mid-paint) must not leave the exit wait pending — that was a
      // "leaks detected: a child process" failure under the full suite. The
      // wait is ALWAYS awaited, after SIGKILL if it comes to that.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const exited = await Promise.race([
        proc.status.then(() => true),
        new Promise<false>((r) => timer = setTimeout(() => r(false), 5_000)),
      ]);
      clearTimeout(timer);
      if (!exited) kill("SIGKILL");
      await proc.status;
      await dropTempDir(profile);
    })();
  return { proc, profile, close };
}

/** Connect to the first page of a Chromium launched with
 *  `--remote-debugging-port=0`. The port the browser picked is read from the
 *  profile's `DevToolsActivePort` file — asking for port 0 is what keeps two
 *  parallel test files from racing for one fixed port. */
export async function chromiumPage(
  browser: LaunchedChromium,
  timeoutMs = 10_000,
): Promise<CdpSession> {
  const deadline = Date.now() + timeoutMs;
  let port = 0;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    const exited = await Promise.race([
      browser.proc.status.then((s) => s),
      new Promise<null>((r) => setTimeout(() => r(null), 50)),
    ]);
    if (exited) {
      throw new Error(
        `[aio] headless Chromium exited (code ${exited.code}) before it ` +
          `opened its DevTools port`,
      );
    }
    try {
      if (!port) {
        const text = await Deno.readTextFile(
          `${browser.profile}/DevToolsActivePort`,
        );
        port = Number(text.split("\n")[0]);
      }
      const r = await fetch(`http://127.0.0.1:${port}/json`);
      const targets = await r.json() as {
        type: string;
        webSocketDebuggerUrl: string;
      }[];
      const page = targets.find((t) => t.type === "page");
      if (page) return await cdpConnect(page.webSocketDebuggerUrl);
    } catch (e) {
      lastErr = e; // not up yet — the loop is the wait
    }
  }
  throw new Error(
    `[aio] headless Chromium opened no DevTools page within ${timeoutMs}ms` +
      (lastErr ? ` (last: ${lastErr})` : ""),
  );
}
