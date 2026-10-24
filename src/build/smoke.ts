/**
 * @module
 * `build --smoke` — START what was just built, and fail the build when it
 * does not come up clean.
 *
 * A green build says the artifact exists. Whether it boots, serves its page,
 * finds the files it was told to carry and stops again is a different claim,
 * and every field report of "works in dev, missing in the package" was that
 * gap: the first person to run the package was a user. This runs it here —
 * from a foreign cwd, with a throwaway home, on a free port, never on the
 * visible desktop where the OS can contain a window (Linux; on Windows and
 * macOS the window opens for the seconds the check takes, and the run says
 * so) — and turns each refusal into a build failure with its line.
 *
 * The verdict rules are pure (unit-tested without a build); the runners are
 * the I/O around them. Internal — never re-exported from a public entry.
 */
import { dirname, join } from "@std/path";
import { cdpConnect } from "../media/cdp.ts";
import { HEY, NO } from "../diagnostics/fmt.ts";
import { APP_STYLE, BUNDLE_JS, workerBundlesIn } from "../server/app-files.ts";
import { readDenoJson } from "../server/deno-json.ts";
import { declaredGuestPreloads } from "../server/guest-preloads.ts";
import {
  displayIsUp,
  nestedDisplayEnv,
  pickNestedDisplay,
  startXephyr,
  XEPHYR_INSTALL_HINT,
} from "../server/nested-display.ts";
import {
  descendantPids,
  isProcessAlive,
} from "../server/single-instance-lock.ts";
import { assetUrlsIn } from "./build-compile.ts";

/** Off, on, `desktop` or `strict`: an artifact that COULD NOT be smoke-tested
 *  here (another OS, no display) is always listed; only `strict` makes it
 *  fail.
 *
 *  `desktop` is "on" plus the desktop smoke on a Windows or macOS host, where
 *  it opens a real window. Plain "on" skips it there, as it did through
 *  1.0.19 (`smokeWindow`): a build with `"smoke": true` that passed on such a
 *  host must not start failing — or opening windows — because aio was
 *  upgraded. `strict` includes it: a skipped row fails a strict build. */
export type SmokeMode = false | true | "desktop" | "strict";

/** Does this mode run the desktop smoke on a host with no nested display
 *  (Windows, macOS)? Pure. */
export const smokeWindow = (mode: SmokeMode): boolean =>
  mode === "desktop" || mode === "strict";

/** `--smoke` / `--smoke=desktop` / `--smoke=strict` (the flag wins), else
 *  deno.json `"build": { "smoke": true | "desktop" | "strict" }`. A value
 *  that is none of them is refused — read as "off", a typo would skip the
 *  check it asked for. Pure. */
export function smokeMode(
  flag: { bare: boolean; value?: string },
  declared: unknown,
): SmokeMode {
  const bad = (where: string, v: unknown) =>
    new Error(
      `${NO} ${where} is ${JSON.stringify(v)} — it must be true, false, ` +
        `"desktop" or "strict" (--smoke, --smoke=desktop, --smoke=strict).`,
    );
  if (flag.value !== undefined) {
    if (flag.value === "strict" || flag.value === "desktop") return flag.value;
    throw bad("--smoke=", flag.value);
  }
  if (flag.bare) return true;
  if (declared === undefined || declared === false) return false;
  if (declared === true || declared === "strict" || declared === "desktop") {
    return declared;
  }
  throw bad("deno.json build.smoke", declared);
}

/** The desktop artifact the smoke starts on each host OS — the one that runs
 *  WITHOUT installing anything:
 *
 *  - Linux: the AppImage, as is;
 *  - Windows: the `.zip`, unpacked into the throwaway dir. Not the one-click
 *    `.exe`: it installs itself under `%LOCALAPPDATA%`, adds a Start-menu
 *    shortcut, and exits as soon as it has started the app — there is no
 *    process of it left to watch;
 *  - macOS: the signed bundle in `<bin>-mac-<arch>.app.tar.gz`, unpacked into
 *    the throwaway dir and started by the program in `Contents/MacOS` — no
 *    disk image is mounted, nothing goes near `/Applications`, and Gatekeeper
 *    is not involved (it judges what Finder opens, not a program a build
 *    starts from its own output). */
const DESKTOP_PACKAGE: Record<string, { is: RegExp; what: string }> = {
  linux: { is: /\.appimage$/i, what: "AppImage" },
  windows: { is: /-win-[^.]+\.zip$/i, what: "Windows .zip" },
  darwin: { is: /\.app\.tar\.gz$/i, what: ".app.tar.gz" },
};

/** How one built target is smoke-tested on this host, or why it is not.
 *  Pure. `files` are the target's placed artifact names. */
export function smokePlan(opts: {
  kind: string;
  platform: string;
  hostPlatform: string;
  hostOs: string;
  files: readonly string[];
  /** The compiled binary's placed name, when the target has one. */
  binary?: string;
  /** {@linkcode smokeWindow} of the run's mode. */
  window?: boolean;
}):
  | { run: "server" | "cli" | "electron"; file: string; page: boolean }
  | { skip: string } {
  const { kind } = opts;
  if (opts.platform !== opts.hostPlatform) {
    return { skip: `not smoke-tested here: built for ${opts.platform}` };
  }
  if (kind === "electron") {
    const pack = DESKTOP_PACKAGE[opts.hostOs];
    if (pack && opts.hostOs !== "linux" && !opts.window) {
      // What 1.0.19 did on these hosts, whatever was built: listed, not run.
      return {
        skip: `not smoke-tested here: on ${opts.hostOs} the desktop smoke ` +
          `opens a real window on this desktop for the seconds it takes, ` +
          `so plain --smoke does not run it — \`--smoke=desktop\` (or ` +
          `"build": { "smoke": "desktop" }) does`,
      };
    }
    const file = pack && opts.files.find((f) => pack.is.test(f));
    if (!file) {
      return {
        skip: pack && opts.hostOs !== "linux"
          ? `not smoke-tested here: no ${pack.what} among this target's ` +
            `artifacts — the one the desktop smoke starts on ${opts.hostOs}`
          : `not smoke-tested here: the desktop smoke drives a Linux ` +
            `AppImage (this host: ${opts.hostOs})`,
      };
    }
    return { run: "electron", file, page: true };
  }
  if (kind === "browser" || kind === "server-app" || kind === "server") {
    if (!opts.binary) return { skip: "not smoke-tested: no binary was placed" };
    // `server` is headless: it has a health route and no page.
    return { run: "server", file: opts.binary, page: kind !== "server" };
  }
  if (kind === "cli") {
    if (!opts.binary) return { skip: "not smoke-tested: no binary was placed" };
    return { run: "cli", file: opts.binary, page: false };
  }
  return {
    skip: kind.endsWith("-client")
      ? `not smoke-tested: a ${kind} needs the server it connects to`
      : `not smoke-tested: a ${kind} artifact does not run on a build host`,
  };
}

/** The lines of an artifact's own output that mean it did not come up clean:
 *  anything logged at ERROR/FATAL, an uncaught error, and a `REFUSED` line
 *  (aio's refusals are spelled that way — a guest preload, a window). The
 *  smoke's own stop request is not one. `refused: false` drops the `REFUSED`
 *  rule — for `--help` output, whose prose names the refusal ("An unknown
 *  --flag … is REFUSED") and failed every `cli` smoke. Pure. */
export function logProblems(
  text: string,
  opts: { refused?: boolean } = {},
): string[] {
  const refused = opts.refused ?? true;
  const out = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const level = /^\d{4}-\d\d-\d\d \S+\s+(ERROR|FATAL)\s/.test(line);
    if (
      level || (refused && /\bREFUSED\b/.test(line)) ||
      /^(?:error: )?Uncaught\b|^error: /.test(line)
    ) {
      // The file log repeats the console line with a `(file:line)` suffix.
      out.add(line.replace(/\s+\([\w.-]+:\d+\)$/, "").slice(0, 400));
    }
  }
  return [...out];
}

/** Same-origin URLs the served shell names (`src=` / `href=`) — the bundle,
 *  the stylesheet, the icon. Pure. */
export function shellUrls(html: string): string[] {
  const out = new Set<string>();
  for (
    const m of html.matchAll(
      /<(?:script|link|img)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi,
    )
  ) {
    const u = m[1]!;
    if (u.startsWith("/") && !u.startsWith("//")) out.add(u.split("#")[0]!);
  }
  return [...out];
}

/** One row of the smoke table. */
export type SmokeRow = {
  target: string;
  artifact: string;
  status: "passed" | "FAILED" | "not smoke-tested";
  /** Failure lines, or the reason it was not run. */
  lines: string[];
};

/** The build's exit code for a smoke table. A row that was not run fails
 *  only under `strict`. Pure. */
export function smokeExit(rows: readonly SmokeRow[], mode: SmokeMode): number {
  return rows.some((r) =>
      r.status === "FAILED" ||
      (mode === "strict" && r.status === "not smoke-tested")
    )
    ? 1
    : 0;
}

/** The table, as lines. Pure. */
export function smokeTable(rows: readonly SmokeRow[]): string[] {
  const w = Math.max(...rows.map((r) => r.target.length), 6);
  return rows.flatMap((r) => [
    `  ${r.status === "passed" ? "✓" : r.status === "FAILED" ? "✗" : "–"} ` +
    `${r.target.padEnd(w)}  ${r.status.padEnd(16)}  ${r.artifact}`,
    ...r.lines.map((l) => `      ${l}`),
  ]);
}

// ── the runners ─────────────────────────────────────────────────────────────

const BOOT_MS = 90_000;
const STOP_MS = 20_000;
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A port nothing holds right now, on loopback. */
function freePort(): number {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const { port } = l.addr as Deno.NetAddr;
  l.close();
  return port;
}

type Running = {
  proc: Deno.ChildProcess;
  exited: () => boolean;
  output: () => string;
  /** The throwaway dir: `home/` (AIO_APPS_DIR), `tmp/`, `cwd/`, `config/`. */
  box: string;
};

/** `spawn()`, or the throwaway dir gone with the throw: an artifact that is
 *  not there (or is no program) fails AT the spawn, before anything could
 *  `settle` the run — and each such build left one `aio-smoke-*` dir in the
 *  temp dir, which on Windows is also where the lock dirs live. */
function spawnOrDrop(
  box: string,
  spawn: () => Deno.ChildProcess,
): Deno.ChildProcess {
  try {
    return spawn();
  } catch (e) {
    Deno.removeSync(box, { recursive: true });
    throw e;
  }
}

/** Start `file` from a foreign cwd with a throwaway home — never the
 *  developer's data, config or temp dir. */
async function launch(
  file: string,
  args: string[],
  env: Record<string, string> | ((box: string) => Record<string, string>),
  /** A package that must be unpacked first: answers the program to start. */
  unpack?: (file: string, into: string) => Promise<string>,
): Promise<Running> {
  const box = await Deno.makeTempDir({ prefix: "aio-smoke-" });
  for (const d of ["home", "tmp", "cwd", "config"]) {
    await Deno.mkdir(join(box, d));
  }
  if (unpack) {
    try {
      file = await unpack(file, join(box, "app"));
    } catch (e) {
      await Deno.remove(box, { recursive: true });
      throw e;
    }
  }
  const proc = spawnOrDrop(box, () =>
    new Deno.Command(file, {
      args,
      cwd: join(box, "cwd"),
      env: {
        // The throwaway home for anything that reads the OS's own idea of
        // it (a library's `~/.cache`, a dotfile): a browser or cli run set
        // only aio's variables and wrote into the developer's. Before the
        // target's env, which knows where its OS keeps a window's profile.
        HOME: join(box, "config"),
        USERPROFILE: join(box, "config"),
        ...(typeof env === "function" ? env(box) : env),
        AIO_APPS_DIR: join(box, "home"),
        XDG_CONFIG_HOME: join(box, "config"),
        TMPDIR: join(box, "tmp"),
        TEMP: join(box, "tmp"),
        TMP: join(box, "tmp"),
        // Never a browser tab, and never an app that outlives a killed build.
        AIO_NO_OPEN: "1",
        AIO_PARENT_PID: String(Deno.pid),
      },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn());
  let text = "";
  let done = false;
  const dec = new TextDecoder();
  const drain = async (s: ReadableStream<Uint8Array>) => {
    for await (const c of s) text += dec.decode(c, { stream: true });
  };
  const drained = Promise.all([drain(proc.stdout), drain(proc.stderr)]);
  proc.status.then(() => drained).catch(() => {
    // aio-ok: a pipe that broke as the process died — what was read is kept
  }).finally(() => done = true);
  return { proc, exited: () => done, output: () => text, box };
}

/** The app's log files, as far as it wrote them. */
function appLogs(box: string): string {
  let t = "";
  try {
    for (const e of Deno.readDirSync(join(box, "home"))) {
      try {
        t += Deno.readTextFileSync(
          join(box, "home", e.name, "logs", "app.log"),
        );
      } catch {
        // aio-ok: not an app home (the lock dir), or no log yet
      }
    }
  } catch {
    // aio-ok: the app never created its home — its console output says why
  }
  return t;
}

/** Every descendant of `pid` in a `[pid, parent, born]` table, shallowest
 *  first. `born` is the process's creation time (any unit, one clock).
 *
 *  A parent pid alone is not a family tie on Windows: a child keeps the pid
 *  of a parent that DIED, and that number is handed out again. So a process
 *  is a child only when it was created at or after the process now holding
 *  its parent's pid — applied at every level. Without it a long-lived
 *  program of the user's whose dead parent once had the app's pid was
 *  counted as the app's, failed the build ("left N process(es)") and was
 *  KILLED. An unknown creation time proves nothing, so it ties nobody. Pure. */
export function descendantsIn(
  pid: number,
  table: readonly (readonly [number, number, number])[],
): number[] {
  const born = new Map(table.map(([p, , at]) => [p, at]));
  const out: number[] = [];
  for (let at = [pid]; at.length;) {
    at = table.filter(([p, parent, b]) =>
      at.includes(parent) && !out.includes(p) && p !== pid &&
      b >= born.get(parent)! // false for NaN on either side
    ).map(([p]) => p);
    out.push(...at);
  }
  return out;
}

/** The app's process tree, asked while it is up. `pgrep` where there is one;
 *  on Windows — where there is none, and "left N process(es) running" was
 *  therefore never checked — the system's own process table. */
async function descendants(pid: number): Promise<number[]> {
  if (Deno.build.os !== "windows") return await descendantPids(pid);
  const o = await new Deno.Command("powershell", {
    args: [
      "-NoProfile",
      "-Command",
      'Get-CimInstance Win32_Process | % { "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.Ticks)" }',
    ],
    stdout: "piped",
    stderr: "null",
  }).output();
  return descendantsIn(pid, processRows(new TextDecoder().decode(o.stdout)));
}

/** `<pid> <parent pid> <creation ticks>` lines → rows. A process with no
 *  creation time (the idle and system processes) gets NaN. Pure. */
export function processRows(listing: string): [number, number, number][] {
  return listing.split("\n")
    .map((l) => l.trim().split(/\s+/))
    .map(([p, parent, born]) =>
      [Number(p), Number(parent), born ? Number(born) : NaN] as [
        number,
        number,
        number,
      ]
    )
    .filter(([p, parent]) => p > 0 && parent > 0);
}

/** `CFBundleExecutable` of a bundle's `Info.plist`, or null. Pure. */
export function plistExecutable(plist: string): string | null {
  return /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/
    .exec(plist)?.[1]?.trim() ?? null;
}

/** Unpack a desktop package into `into` and answer the program to start:
 *  the one `.exe` at the top of a Windows zip, or — in the one `.app` of a
 *  macOS tarball — the program its `Info.plist` names, in `Contents/MacOS`.
 *  `tar` on both (bsdtar there reads a zip and a tarball alike). Throws with
 *  what it found when the package is not that shape. */
export async function unpackDesktop(
  file: string,
  into: string,
  os: string = Deno.build.os,
): Promise<string> {
  await Deno.mkdir(into, { recursive: true });
  const o = await new Deno.Command("tar", {
    args: ["-xf", file, "-C", into],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!o.success) {
    throw new Error(
      `could not unpack ${file}: ${new TextDecoder().decode(o.stderr).trim()}`,
    );
  }
  const top = [...Deno.readDirSync(into)].map((e) => e.name).sort();
  const sole = (re: RegExp, what: string) => {
    const hit = top.filter((n) => re.test(n));
    if (hit.length !== 1) {
      throw new Error(
        `${file} holds ${hit.length} ${what} at its top (${
          top.join(", ") || "nothing"
        }) — expected exactly one`,
      );
    }
    return hit[0]!;
  };
  if (os !== "darwin") return join(into, sole(/\.exe$/i, ".exe file(s)"));
  const app = join(into, sole(/\.app$/, ".app bundle(s)"));
  const exe = plistExecutable(
    await Deno.readTextFile(join(app, "Contents", "Info.plist")),
  );
  if (!exe) {
    throw new Error(`${app}: its Info.plist names no CFBundleExecutable`);
  }
  return join(app, "Contents", "MacOS", exe);
}

/** What a desktop package is started with besides the throwaway home, per
 *  host OS — everything that keeps the run out of the developer's own
 *  profile. Pure.
 *
 *  - Linux: the AppImage unpacks itself (no FUSE needed);
 *  - Windows: Electron keeps the window's profile under the roaming folder
 *    the shell expands from `%USERPROFILE%` — measured on Windows 11 with
 *    Electron 44: `%APPDATA%` alone does NOT move it. So the profile root
 *    moves, and the two variables aio and others read agree with it;
 *  - macOS: under `~/Library/Application Support` — so the home is the
 *    throwaway one — and a bundle outside `/Applications` offers to move
 *    itself there once it is up: never, for a smoke run. */
export function desktopEnv(os: string, box: string): Record<string, string> {
  const config = join(box, "config");
  if (os === "windows") {
    return {
      USERPROFILE: config,
      APPDATA: join(config, "AppData", "Roaming"),
      LOCALAPPDATA: join(config, "AppData", "Local"),
    };
  }
  if (os === "darwin") {
    return {
      HOME: config,
      CFFIXED_USER_HOME: config,
      AIO_MOVE_TO_APPLICATIONS: "never",
    };
  }
  return { APPIMAGE_EXTRACT_AND_RUN: "1" };
}

/** The descendants still alive once the app has had `ms` to finish exiting.
 *
 *  Polled, not read once: an Electron package's helpers (zygote, GPU,
 *  utility) exit a few milliseconds AFTER the main process, so a single look
 *  right behind `await proc.status` failed a healthy build with "left N
 *  process(es) running". Returns as soon as none is left. `alive`/`wait` are
 *  test seams. */
export async function leftRunning(
  kids: readonly number[],
  ms = 3000,
  alive: (pid: number) => boolean = isProcessAlive,
  wait: (ms: number) => Promise<void> = delay,
): Promise<number[]> {
  let left = kids.filter(alive);
  for (let waited = 0; left.length && waited < ms; waited += 100) {
    await wait(100);
    left = left.filter(alive);
  }
  return left;
}

/** After the stop: nothing running, nothing left in the temp dir, and the
 *  throwaway dir removed. Appends what it finds to `fails`. */
async function settle(
  run: Running,
  kids: number[],
  fails: string[],
  stopped: boolean,
): Promise<void> {
  if (!stopped) {
    fails.push(
      `did not stop within ${STOP_MS / 1000}s of being asked — killed`,
    );
    try {
      run.proc.kill("SIGKILL");
    } catch {
      // aio-ok: exited between the wait and the kill
    }
  }
  await run.proc.status;
  const alive = await leftRunning(kids);
  if (alive.length) {
    fails.push(
      `left ${alive.length} process(es) running 3s after it exited: ${
        alive.join(", ")
      }`,
    );
    for (const pid of alive.reverse()) {
      try {
        Deno.kill(pid, "SIGKILL");
      } catch {
        // aio-ok: gone since the check
      }
    }
  }
  // Not the app's: `deno-compile-*` is the runtime's own extraction cache,
  // kept by design, and `appimage_extracted_*` is this smoke's own launch
  // mode (APPIMAGE_EXTRACT_AND_RUN — no FUSE needed). `.aio-roots` is the
  // lock-dir registry aio keeps beside its lock dir (where the temp dir
  // holds it — no XDG_RUNTIME_DIR, Windows), which outlives an app by design.
  const left = [...Deno.readDirSync(join(run.box, "tmp"))]
    .map((e) => e.name)
    .filter((n) =>
      !/^(?:deno-compile-|appimage_extracted_|\.aio-roots$)/.test(n)
    );
  if (left.length && stopped) {
    fails.push(`left in its temp dir after stopping: ${left.join(", ")}`);
  }
  try {
    await Deno.remove(run.box, { recursive: true });
  } catch (e) {
    fails.push(`its throwaway dir could not be removed (${run.box}): ${e}`);
  }
}

async function waitExit(run: Running, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until && !run.exited()) await delay(100);
  return run.exited();
}

const tail = (s: string) => s.trim().split("\n").slice(-6).join("\n      ");

/** Boot a compiled server binary, fetch what its page names, read its log,
 *  stop it. Returns the failure lines — empty is a pass. */
export async function smokeServer(opts: {
  file: string;
  /** False for a headless server: health only. */
  page: boolean;
  /** Does this URL path exist in the app's SOURCE dir (so dev serves it)? */
  inSource?: (urlPath: string) => boolean;
}): Promise<string[]> {
  const fails: string[] = [];
  const port = freePort();
  const run = await launch(opts.file, [`--port=${port}`], {});
  const base = `http://127.0.0.1:${port}`;
  let appId = "";
  let kids: number[] = [];
  let stopped = false;
  try {
    const until = Date.now() + BOOT_MS;
    let up = false;
    while (Date.now() < until && !run.exited() && !up) {
      try {
        const r = await fetch(`${base}/__aio/health`, {
          signal: AbortSignal.timeout(3000),
        });
        const body = await r.text();
        up = true;
        if (r.ok) appId = String(JSON.parse(body).appId ?? "");
        else fails.push(`GET /__aio/health → ${r.status}`);
      } catch {
        await delay(200); // aio-ok: not listening yet — the loop's deadline is the verdict
      }
    }
    if (!up) {
      fails.push(
        run.exited()
          ? `exited before it served anything:\n      ${tail(run.output())}`
          : `never answered ${base}/__aio/health within ${BOOT_MS / 1000}s:` +
            `\n      ${tail(run.output())}`,
      );
      return fails;
    }
    kids = await descendants(run.proc.pid);
    if (opts.page) {
      const get = async (path: string) => {
        const r = await fetch(base + path, {
          signal: AbortSignal.timeout(15_000),
        });
        return { status: r.status, text: await r.text() };
      };
      const shell = await get("/");
      if (shell.status !== 200) fails.push(`GET / → ${shell.status}`);
      else {
        // The bundle is loaded by the shell's inline module script, so it
        // is asked for by name; the stylesheet only when the shell names it
        // (an app on the generated theme ships none).
        let bundle = shell.text;
        const named = new Set([`/${BUNDLE_JS}`, ...shellUrls(shell.text)]);
        if (shell.text.includes(APP_STYLE)) named.add(`/${APP_STYLE}`);
        for (const u of named) {
          const r = await get(u);
          if (r.status !== 200) fails.push(`GET ${u} → ${r.status}`);
          else if (/\.(?:js|css)(?:\?|$)/.test(u)) bundle += r.text;
        }
        // The browser workers the bundle starts, and theirs: no tag names
        // one, and a worker that is not there is only an `error` event.
        const workers = new Set(workerBundlesIn(bundle));
        for (const w of workers) {
          const r = await get(`/${w}`);
          if (r.status !== 200) {
            fails.push(`GET /${w} → ${r.status} (a worker the bundle starts)`);
          } else for (const n of workerBundlesIn(r.text)) workers.add(n);
        }
        // The asset list of the artifact's OWN bundle — `assetUrlsIn`, the
        // decider the compile's warning uses. A URL the source tree cannot
        // answer either is a 404 in dev too: said, not failed (a literal is
        // a heuristic, and such a path may be a route).
        for (const u of assetUrlsIn(bundle)) {
          const r = await get(u);
          if (r.status === 200) continue;
          if (opts.inSource?.(u) === false) {
            console.warn(
              `${HEY} smoke: the bundle names ${u} (→ ${r.status}) and the ` +
                `source tree has no such file — not counted`,
            );
          } else {fails.push(
              `GET ${u} → ${r.status} (the page's bundle names it)`,
            );}
        }
      }
    }
    // Stop it the way `am stop` does — the one request that is graceful on
    // every OS — and let it finish its own teardown.
    try {
      const key = (await Deno.readTextFile(
        join(run.box, "home", appId, "data", "control.key"),
      )).trim();
      const r = await fetch(`${base}/__aio/trojan/shutdown`, {
        method: "POST",
        headers: { "X-AIO": "1", "X-Aio-Control": key },
        signal: AbortSignal.timeout(5000),
      });
      await r.body?.cancel();
      if (!r.ok) fails.push(`the stop request was answered ${r.status}`);
    } catch (e) {
      fails.push(
        `could not ask it to stop: ${e instanceof Error ? e.message : e}`,
      );
    }
    stopped = await waitExit(run, STOP_MS);
    for (const p of logProblems(run.output() + "\n" + appLogs(run.box))) {
      fails.push(`its log: ${p}`);
    }
    return fails;
  } finally {
    await settle(run, kids, fails, stopped || run.exited());
  }
}

/** A `cli` binary: `--help` from a foreign cwd with a throwaway home must
 *  exit 0 and log no error. (Its program is the app's own — `--help` is the
 *  one flag aio can promise it answers; see `smokeRunArtifact`.) */
export async function smokeCli(file: string): Promise<string[]> {
  const fails: string[] = [];
  const run = await launch(file, ["--help"], {});
  const done = await waitExit(run, 60_000);
  if (done) {
    const st = await run.proc.status;
    if (!st.success) {
      fails.push(`\`--help\` exited ${st.code}:\n      ${tail(run.output())}`);
    }
    // aio's help text says "REFUSED" as prose; a refused `--help` exits
    // non-zero, which the status check above already fails.
    const text = run.output() + "\n" + appLogs(run.box);
    for (const p of logProblems(text, { refused: false })) {
      fails.push(`its log: ${p}`);
    }
  }
  await settle(run, [], fails, done);
  return fails;
}

/** The contained display a smoke-tested window opens on, or null when there
 *  is none: a nested X server owned by this user (started once, left
 *  running — `nested-display.ts`). Never the session's own display: a build
 *  must not put a window on the desktop of whoever is working there. */
export function smokeDisplayEnv(
  named: string | undefined = Deno.env.get("AIO_AM_DISPLAY"),
): Record<string, string> | null {
  // `AIO_AM_DISPLAY=:N` — a display the developer named (a GPU lab, an Xvfb),
  // as `am start` honours it: the window opens there and no Xephyr is started.
  // A Xephyr is itself a window on the real desktop, drawn through its display
  // driver — on the box where an NVIDIA X driver crashed (feedback/critical.md)
  // that is the one thing a run must be able to keep off it.
  if (named && /^:\d+$/.test(named)) {
    if (!displayIsUp(named)) return null;
    const auth = Deno.env.get("XAUTHORITY");
    return auth ? { DISPLAY: named, XAUTHORITY: auth } : { DISPLAY: named };
  }
  const pick = pickNestedDisplay();
  if (!pick) return null;
  if (!pick.up && !startXephyr(pick.display)) return null;
  return displayIsUp(pick.display) ? nestedDisplayEnv(pick.display) : null;
}

/** The guest preloads the shell says it can attach — its startup line
 *  (`tmplGuestPreloads`), written after its own resolver (`__aioGuestPreload`,
 *  the one a `<webview>` attach asks) went through each. Pure. */
export function shellGuestPreloads(log: string): string[] {
  const m = /\[aio:electron\] guest preloads present in .*?: ([^\n]*)/.exec(
    log,
  );
  return m ? m[1]!.replace(/\s+\([\w.-]+:\d+\)$/, "").split(", ") : [];
}

/** The declared guest preloads the packaged shell cannot attach, as failure
 *  lines. A package holds only what was staged into it, so a file lost
 *  after staging is simply not there — the declaration is what knows it
 *  should be. Pure. */
export function missingGuestPreloads(
  declared: readonly string[],
  log: string,
): string[] {
  const has = shellGuestPreloads(log);
  return declared.filter((d) => !has.includes(d)).map((d) =>
    `guest preload REFUSED in the package: ${d} is declared in deno.json ` +
    `build.guestPreloads and the packaged shell cannot attach it (it has: ${
      has.join(", ") || "none"
    })`
  );
}

/** Launch the packaged desktop app on the contained display, wait for its
 *  page, check what the page names and what the shell says about its
 *  declared guest preloads, close it. Returns the failure lines, or
 *  `{ skip }` when there is no display to run it on. */
export async function smokeElectron(opts: {
  file: string;
  /** deno.json `build.guestPreloads` — each must resolve in the package. */
  guestPreloads: readonly string[];
}): Promise<string[] | { skip: string }> {
  const os = Deno.build.os;
  // Linux has a contained display to open the window on. Windows and macOS
  // have none: there the window opens on this desktop for the seconds the
  // check takes — said, because a build that puts a window up should not be
  // a surprise.
  const display = os === "linux" ? smokeDisplayEnv() : {};
  if (!display) {
    return {
      skip: `not smoke-tested: no display (a nested X display keeps the ` +
        `window off your desktop — ${XEPHYR_INSTALL_HINT})`,
    };
  }
  if (os !== "linux") {
    console.log(
      `smoke: ${os} has no nested display — the window opens on this ` +
        `desktop until the check is done`,
    );
  }
  const fails: string[] = [];
  const cdpPort = freePort();
  const run = await launch(
    opts.file,
    [`--cdp=${cdpPort}`],
    (box) => ({ ...display, ...desktopEnv(os, box) }),
    os === "linux" ? undefined : unpackDesktop,
  );
  let kids: number[] = [];
  let stopped = false;
  try {
    // The app's own page: `aio://…` in the packaged shell.
    let wsUrl = "";
    const until = Date.now() + BOOT_MS;
    while (Date.now() < until && !run.exited() && !wsUrl) {
      try {
        const r = await fetch(`http://127.0.0.1:${cdpPort}/json`, {
          signal: AbortSignal.timeout(3000),
        });
        const targets = await r.json() as Array<
          { type: string; url: string; webSocketDebuggerUrl: string }
        >;
        wsUrl = targets.find((t) =>
          t.type === "page" && t.url.startsWith("aio://")
        )?.webSocketDebuggerUrl ?? "";
      } catch {
        // aio-ok: the shell is not up yet — the loop's deadline is the verdict
      }
      if (!wsUrl) await delay(300);
    }
    if (!wsUrl) {
      fails.push(
        (run.exited()
          ? `exited before its window opened:`
          : `no app window within ${BOOT_MS / 1000}s:`) +
          `\n      ${tail(run.output())}`,
      );
      return fails;
    }
    kids = await descendants(run.proc.pid);
    const cdp = await cdpConnect(wsUrl, 10_000);
    const evaluate = async (expression: string): Promise<unknown> => {
      const r = await cdp.call("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      }) as { result?: { value?: unknown }; exceptionDetails?: unknown };
      if (r.exceptionDetails) {
        throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
      }
      return r.result?.value;
    };
    try {
      const loadBy = Date.now() + 30_000;
      let loaded = false;
      while (Date.now() < loadBy && !loaded) {
        loaded = await evaluate(
          `document.readyState === "complete" && !!document.body && ` +
            `document.body.childElementCount > 0`,
        ).catch(() => false) === true;
        if (!loaded) await delay(300);
      }
      if (!loaded) fails.push("its page never finished loading (30s)");
      else {
        // Every file the page names, asked of the shell that serves it.
        const statuses = await evaluate(`Promise.all(
  [...document.querySelectorAll("script[src],link[href],img[src]")]
    .map((e) => e.src || e.href).filter((u) => u.startsWith(location.origin))
    .map((u) => fetch(u).then((r) => [u, r.status], (e) => [u, String(e)])))`) as Array<
          [string, number | string]
        >;
        for (const [u, s] of statuses ?? []) {
          if (s !== 200) fails.push(`the page's ${u} → ${s}`);
        }
        // …and the browser workers its bundle starts, which no tag names.
        const bundle = await evaluate(
          `fetch("/${BUNDLE_JS}").then((r) => r.text())`,
        ) as string;
        const workers = await evaluate(
          `Promise.all(${
            JSON.stringify(workerBundlesIn(bundle ?? ""))
          }.map((w) => fetch("/" + w).then((r) => [w, r.status], (e) => [w, String(e)])))`,
        ) as Array<
          [string, number | string]
        >;
        for (const [w, s] of workers ?? []) {
          if (s !== 200) fails.push(`the page's worker ${w} → ${s}`);
        }
      }
      // The window closed is how a person quits a desktop app.
      await cdp.call("Browser.close").catch(() => {
        // aio-ok: the socket closes WITH the browser — no reply is the normal
        // outcome, and "did it stop" is judged by the process exit below
      });
    } finally {
      await cdp.close().catch(() => {
        // aio-ok: already closed by Browser.close
      });
    }
    stopped = await waitExit(run, STOP_MS);
    const log = run.output() + "\n" + appLogs(run.box);
    for (const p of logProblems(log)) fails.push(`its log: ${p}`);
    // Positive evidence, never "no refusal seen": what the shell itself
    // says it can attach, against what the app declares.
    fails.push(...missingGuestPreloads(opts.guestPreloads, log));
    return fails;
  } finally {
    await settle(run, kids, fails, stopped || run.exited());
  }
}

/** One built target, as the fleet knows it. */
export type SmokeTarget = {
  target: string;
  kind: string;
  platform: string;
  /** Root-relative entry module of this target. */
  entry: string;
  files: readonly string[];
  binary?: string;
};

type SmokeRun = Exclude<ReturnType<typeof smokePlan>, { skip: string }>;

/** Run one planned artifact: its failure lines, or why it could not run. */
async function smokeOne(
  root: string,
  outDir: string,
  t: SmokeTarget,
  plan: SmokeRun,
  cfg: Parameters<typeof declaredGuestPreloads>[0],
): Promise<string[] | { skip: string }> {
  const file = join(outDir, plan.file);
  // A program is made runnable; a package that is unpacked first is not one.
  if (Deno.build.os !== "windows" && !/\.tar\.gz$/i.test(file)) {
    await Deno.chmod(file, 0o755);
  }
  const appDir = join(root, dirname(t.entry));
  return plan.run === "electron"
    ? await smokeElectron({ file, guestPreloads: declaredGuestPreloads(cfg) })
    : plan.run === "cli"
    ? await smokeCli(file)
    : await smokeServer({
      file,
      page: plan.page,
      inSource: (u) => {
        try {
          Deno.statSync(join(appDir, u.slice(1)));
          return true;
        } catch {
          return false;
        }
      },
    });
}

/** Smoke-test every built target, print the table, return the exit code.
 *
 *  Each target on its own: a runner that THROWS (a fetch refused mid-boot, a
 *  CDP socket that closed, an artifact that is not there) is that target's
 *  FAILED row — it used to escape with no table and no row for the targets
 *  after it. `run` is the test seam for exactly that. */
export async function smokeBuild(opts: {
  root: string;
  outDir: string;
  mode: SmokeMode;
  hostPlatform: string;
  /** The build host's OS — a test seam; `Deno.build.os`. */
  hostOs?: string;
  targets: readonly SmokeTarget[];
  run?: (
    t: SmokeTarget,
    plan: SmokeRun,
  ) => Promise<string[] | { skip: string }>;
}): Promise<number> {
  const rows: SmokeRow[] = [];
  const cfg = (await readDenoJson(opts.root))?.config;
  for (const t of opts.targets) {
    const plan = smokePlan({
      ...t,
      hostPlatform: opts.hostPlatform,
      hostOs: opts.hostOs ?? Deno.build.os,
      window: smokeWindow(opts.mode),
    });
    if ("skip" in plan) {
      rows.push({
        target: t.target,
        artifact: t.files.join(", ") || "—",
        status: "not smoke-tested",
        lines: [plan.skip],
      });
      continue;
    }
    console.log(`smoke: starting ${plan.file} (${t.target})`);
    let res: string[] | { skip: string };
    try {
      res = await (opts.run?.(t, plan) ??
        smokeOne(opts.root, opts.outDir, t, plan, cfg));
    } catch (e) {
      res = [
        `the smoke run itself threw: ${
          e instanceof Error ? e.stack ?? e.message : String(e)
        }`,
      ];
    }
    rows.push(
      "skip" in res
        ? {
          target: t.target,
          artifact: plan.file,
          status: "not smoke-tested",
          lines: [res.skip],
        }
        : {
          target: t.target,
          artifact: plan.file,
          status: res.length ? "FAILED" : "passed",
          lines: res,
        },
    );
  }
  const code = smokeExit(rows, opts.mode);
  console.log(`\nsmoke`);
  for (const l of smokeTable(rows)) console.log(l);
  const skipped = rows.filter((r) => r.status === "not smoke-tested").length;
  if (skipped && opts.mode !== "strict") {
    console.warn(
      `${HEY} ${skipped} artifact(s) were NOT smoke-tested on this host — ` +
        `--smoke=strict makes that a failure`,
    );
  }
  if (code) {
    console.error(
      `${NO} smoke failed — the artifact(s) above are built and do not come up clean`,
    );
  }
  return code;
}
