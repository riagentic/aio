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

/** Where a Chromium-family browser is installed on `os`, in the order they are
 *  tried: what earlier releases probed, then the ones that speak the same flags and CDP
 *  (Edge — on every Windows 11 — and Brave). `os` and `env` are parameters so
 *  the Windows list is checked on whichever host runs the suite.
 *  @internal exported for its test */
export function _chromiumCandidates(
  os: string = Deno.build.os,
  env: (name: string) => string | undefined = (n) => Deno.env.get(n),
): string[] {
  if (os === "windows") {
    const roots = ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
      .map(env).filter((r): r is string => !!r);
    return [
      "Chromium\\Application\\chrome.exe",
      "Google\\Chrome\\Application\\chrome.exe",
      "Microsoft\\Edge\\Application\\msedge.exe",
      "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    ].flatMap((rel) => roots.map((r) => `${r}\\${rel}`));
  }
  if (os === "darwin") {
    return [
      "Google Chrome.app/Contents/MacOS/Google Chrome",
      "Chromium.app/Contents/MacOS/Chromium",
      "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "Brave Browser.app/Contents/MacOS/Brave Browser",
    ].map((rel) => `/Applications/${rel}`);
  }
  return [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/snap/bin/chromium",
    "/usr/bin/microsoft-edge",
    "/usr/bin/microsoft-edge-stable",
    "/usr/bin/brave-browser",
  ];
}

/** Locate a headless-capable Chromium/Chrome binary, or null. */
export function findChromium(): string | null {
  const env = Deno.env.get("CHROMIUM_BIN") ?? Deno.env.get("CHROME_BIN");
  if (env) return env;
  for (const c of _chromiumCandidates()) {
    try {
      if (Deno.statSync(c).isFile) return c;
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

/** Every live process started with `--user-data-dir=<profile>` (Linux:
 *  `/proc`; macOS: `ps`; Windows: its process table). Chromium's helpers — the network and storage
 *  services, the renderers — all carry it, and they are not this process's
 *  children: a helper that outlives the browser keeps writing into the
 *  profile, so a profile removed right after the browser exits came back
 *  (`Default/.org.chromium.Chromium.TransportSecurity.*`, `Default/Cache/`) —
 *  the `aio-test-browser-*` / `aio-e2e-prof-*` orphans of a loaded run. */
/** Does the /proc `cmdline` text `cmd` run on `profile`? Not split on NUL:
 *  Chromium rewrites its process title, so a helper's cmdline is ONE
 *  space-joined string — matching whole NUL-split arguments found none of
 *  them, and nothing was ever killed. The flag counts when the character
 *  after it ends the argument (a longer profile path is another profile).
 *  @internal exported for its test */
export function _holdsProfile(cmd: string, profile: string): boolean {
  // Two spellings: the argument as given (which Windows wraps whole in quotes
  // when it holds a space), and `--user-data-dir="<profile>"` — what Chromium
  // on Windows writes into the command line of its OWN children (gpu,
  // renderer, utility), with or without a space. Matching the first alone
  // found the crashpad handler and none of those.
  for (
    const flag of [`--user-data-dir=${profile}`, `--user-data-dir="${profile}`]
  ) {
    for (let i = cmd.indexOf(flag); i >= 0; i = cmd.indexOf(flag, i + 1)) {
      const next = cmd[i + flag.length];
      if (
        next === undefined || next === "\0" || next === " " || next === '"'
      ) return true;
    }
  }
  return false;
}

/** The pids in a `<pid> <command line>` listing (one process per line — what
 *  `ps -axo pid=,command=` and the Windows query below print) that run on
 *  `profile`. Pure.
 *  @internal exported for its test */
export function _profilePidsIn(listing: string, profile: string): number[] {
  const out: number[] = [];
  for (const line of listing.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line.trimEnd());
    if (m && _holdsProfile(m[2]!, profile)) out.push(Number(m[1]));
  }
  return out;
}

/** Off Linux there is no /proc: macOS is asked through `ps`, Windows through
 *  its process table (CIM — the one place a command line can be read without
 *  a privilege). Both returned nothing before, so a test browser's helpers
 *  were never ended there and kept the profile directory busy. */
function listedProfileProcesses(profile: string): number[] {
  const [cmd, args] = Deno.build.os === "windows"
    ? ["powershell", [
      "-NoProfile",
      "-Command",
      'Get-CimInstance Win32_Process | % { "$($_.ProcessId) $($_.CommandLine)" }',
    ]]
    : ["ps", ["-axo", "pid=,command="]];
  try {
    const r = new Deno.Command(cmd as string, {
      args: args as string[],
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    return r.success
      ? _profilePidsIn(new TextDecoder().decode(r.stdout), profile)
        .filter((pid) => pid !== Deno.pid)
      : [];
  } catch {
    return []; // aio-ok: no process listing here — nothing to look for
  }
}

function profileProcesses(profile: string): number[] {
  if (Deno.build.os !== "linux") return listedProfileProcesses(profile);
  const out: number[] = [];
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync("/proc")];
  } catch {
    return out; // aio-ok: no /proc — nothing to look for
  }
  for (const e of entries) {
    if (!/^\d+$/.test(e.name)) continue;
    try {
      const cmd = Deno.readTextFileSync(`/proc/${e.name}/cmdline`);
      if (_holdsProfile(cmd, profile)) out.push(Number(e.name));
    } catch {
      // aio-ok: the process ended between the listing and the read
    }
  }
  return out;
}

/** Remove a browser profile once NOTHING writes to it any more: the helpers
 *  still running on it are killed and waited for (bounded), then the
 *  directory goes. Call it after the browser itself has exited. */
export async function dropBrowserProfile(profile: string): Promise<void> {
  // Off Linux ONE look at the process table costs a second or more (a `ps`,
  // a PowerShell query) — under load five seconds was two looks, and a
  // helper outlived the bound (seen on Windows, 1 run in 5).
  const deadline = Date.now() + (Deno.build.os === "linux" ? 5_000 : 20_000);
  for (;;) {
    // What a look finds is killed — on the last look too: the bound ends the
    // LOOKING, it never leaves a found helper running.
    const left = profileProcesses(profile);
    for (const pid of left) {
      try {
        Deno.kill(pid, "SIGKILL");
      } catch {
        // aio-ok: it exited on its own between the scan and the kill
      }
    }
    if (left.length === 0 || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  await dropTempDir(profile);
}

/** The exit-time twin of `dropBrowserProfile`: `unload` cannot await, so the
 *  helpers are SIGKILLed and their end is waited for synchronously (bounded),
 *  then the profile goes. A plain SIGTERM here let the browser shut down on
 *  its own time, after the temp-dir sweep had removed the profile — and its
 *  network service, flushing state on the way out, created it again
 *  (`Default/Cache`, `.org.chromium.Chromium.TransportSecurity.*`). */
function dropBrowserProfileSync(profile: string): void {
  // Off Linux one look costs a second or more (see `dropBrowserProfile`):
  // two seconds there was a single look, and whatever it found was never
  // confirmed gone.
  const deadline = Date.now() + (Deno.build.os === "linux" ? 2_000 : 10_000);
  const tick = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    const left = profileProcesses(profile);
    for (const pid of left) {
      try {
        Deno.kill(pid, "SIGKILL");
      } catch {
        // aio-ok: it exited on its own between the scan and the kill
      }
    }
    if (left.length === 0 || Date.now() >= deadline) break;
    Atomics.wait(tick, 0, 0, 10); // exit time: no timer will run again
  }
  try {
    Deno.removeSync(profile, { recursive: true });
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      console.error(`[testBrowser] could not remove ${profile} at exit: ${e}`);
    }
  }
}

/** The flags every test browser is launched with, before the caller's own.
 *
 *  Windows adds `--guest`: a Chromium there (Edge, measured) tries one
 *  interactive logon as the Windows user per launch on a fresh profile. It
 *  fails — Security event 4625 from `msedge.exe` — and Windows' default
 *  policy locks the ACCOUNT after ten of those in ten minutes. A guest
 *  window has no profile identity to sign in, so it costs none; `--inprivate`,
 *  `--no-first-run` and `--disable-sync` each still cost one. Since
 *  `findChromium` finds Edge on Windows, a launch without this flag is a
 *  test suite that locks its own user out.
 *
 *  Windows also adds `--do-not-de-elevate`: started from an elevated
 *  (administrator) shell, Chromium relaunches itself as the un-elevated user
 *  and the process aio spawned exits 0 at once — measured, Edge 155: every
 *  launch failed "exited (code 0) before it opened its DevTools port", and
 *  the relaunched browser ran on as an orphan nothing closes. The flag is the
 *  one Chromium appends to that relaunch itself, so it does not loop.
 *  @internal exported for its test */
export function _launchFlags(
  profile: string,
  os: string = Deno.build.os,
): string[] {
  return [
    ...(os === "windows" ? ["--guest", "--do-not-de-elevate"] : []),
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--password-store=basic`,
    `--use-mock-keychain`,
    `--user-data-dir=${profile}`,
  ];
}

/** A HOME of its own for a test browser, and the fonts of the real one.
 *
 *  `--user-data-dir` does not hold everything a Chromium writes on Linux:
 *  the crash database (`$XDG_CONFIG_HOME/chromium/Crash Reports/settings.dat`,
 *  rewritten on every launch) and the NSS store (`~/.pki/nssdb`, opened
 *  read-write) follow HOME — measured with `strace`, Chromium 153. Under
 *  `home` both land in the throwaway profile.
 *
 *  A new HOME alone loses the user's fonts and font rules, which fontconfig
 *  finds through HOME too, and a page then renders in other glyphs than the
 *  developer sees. So `FONTCONFIG_FILE` names a file that includes the
 *  configuration in force (which now resolves `~` and the XDG dirs to
 *  `home`) and then the real user's directories by full path, read only: the
 *  font cache is written under `home`.
 *  @internal exported for its test */
export function _ownHomeEnv(
  home: string,
  env: Record<string, string | undefined>,
): { env: Record<string, string>; fontsConf: string } {
  const real = env.HOME ?? "";
  const config = env.XDG_CONFIG_HOME || `${real}/.config`;
  const data = env.XDG_DATA_HOME || `${real}/.local/share`;
  const xml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const include = (p: string) =>
    `  <include ignore_missing="yes">${xml(p)}</include>\n`;
  const fontsConf = `<?xml version="1.0"?>\n<fontconfig>\n` +
    include(env.FONTCONFIG_FILE || "/etc/fonts/fonts.conf") +
    (real
      ? include(`${config}/fontconfig/conf.d`) +
        include(`${config}/fontconfig/fonts.conf`) +
        `  <dir>${xml(`${data}/fonts`)}</dir>\n` +
        `  <dir>${xml(`${real}/.fonts`)}</dir>\n`
      : "") +
    `</fontconfig>\n`;
  return {
    env: {
      HOME: home,
      XDG_CONFIG_HOME: `${home}/.config`,
      XDG_DATA_HOME: `${home}/.local/share`,
      XDG_CACHE_HOME: `${home}/.cache`,
      FONTCONFIG_FILE: `${home}/fonts.conf`,
      // Xlib finds its cookie through HOME when the variable is unset.
      ...(real && !env.XAUTHORITY ? { XAUTHORITY: `${real}/.Xauthority` } : {}),
    },
    fontsConf,
  };
}

/** The env that gives a browser on `profile` a HOME of its own, inside the
 *  profile (it goes when the profile goes) — or `{}`: this is opt-in
 *  (`AIO_TEST_BROWSER_HOME=own`, Linux), and by default a test browser runs
 *  in the developer's HOME, as it always has. Spread it into the spawn's
 *  `env`, BEFORE the display's (whose `XAUTHORITY` must win). */
export function browserHomeEnv(profile: string): Record<string, string> {
  if (
    Deno.build.os !== "linux" || Deno.env.get("AIO_TEST_BROWSER_HOME") !== "own"
  ) return {};
  const home = `${profile}/aio-home`;
  const own = _ownHomeEnv(home, Deno.env.toObject());
  Deno.mkdirSync(home, { recursive: true });
  Deno.writeTextFileSync(`${home}/fonts.conf`, own.fontsConf);
  return own.env;
}

/** Spawn headless Chromium with `args` (URL last). The process is killed and
 *  its profile removed on `close()`, and an `unload` backstop kills it even if
 *  Deno dies mid-test (the orphaned-chrome leak). */
export async function launchChromium(
  bin: string,
  args: readonly string[],
): Promise<LaunchedChromium> {
  const profile = await tempDir("aio-test-browser-");
  const proc = new Deno.Command(bin, {
    args: [..._launchFlags(profile), ...args],
    stdin: "null",
    stdout: "null",
    stderr: "null",
    // Contained even though `--headless=new` opens nothing today: the day
    // someone drops that flag to debug a test, the window must land in the
    // nested display and not on the developer's desktop. Cheap now,
    // impossible to remember later.
    env: {
      ...Deno.env.toObject(),
      ...browserHomeEnv(profile),
      ...testDisplayEnv(),
    },
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
  const onUnload = () => {
    kill("SIGKILL");
    dropBrowserProfileSync(profile);
  };
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
      await dropBrowserProfile(profile);
    })();
  return { proc, profile, close };
}

/** Connect to the first page of a Chromium launched with
 *  `--remote-debugging-port=0`. The port the browser picked is read from the
 *  profile's `DevToolsActivePort` file — asking for port 0 is what keeps two
 *  parallel test files from racing for one fixed port.
 *
 *  The loop returns the moment the page is up; `timeoutMs` only bounds a
 *  browser that never comes up. 10 s was missed by a cold start on a loaded
 *  machine (a full parallel suite beside an APK build: no DevToolsActivePort
 *  yet at 10 s), which is a slow start, not a hung one. */
export async function chromiumPage(
  browser: LaunchedChromium,
  timeoutMs = 30_000,
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
