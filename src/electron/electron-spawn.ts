// Electron binary resolution and process spawning

import { basename, dirname, fromFileUrl, join } from "@std/path";
import {
  type AioMeta,
  type Log,
  type ShellConfig,
  shellProfileName,
} from "./electron-shared.ts";
import { electronMainScript } from "./electron-scripts.ts";
import {
  CLIENT_PROFILE,
  electronClientScript,
} from "./electron-client-script.ts";
import { electronMainScriptUDS } from "./electron-uds.ts";
import { log } from "../diagnostics/logger-api.ts";
import { classifyElectronLine } from "./electron-renderer-log.ts";
import { appImageOwner, isCompiled } from "../server/paths.ts";
import { isProcessAlive } from "../server/single-instance-lock.ts";
import { DENO_JSON_NAMES, parseDenoJson } from "../server/deno-json.ts";
import { HEY } from "../diagnostics/fmt.ts";
import { redactUrlToken } from "../diagnostics/redact.ts";
import { neutralCwd, spawnInheritingOrNull } from "../server/no-console.ts";
import {
  bakedElectronVersion,
  bakedEmbeddedRuntime,
  DEFAULT_ELECTRON_VERSION,
  electronBinIn,
  electronSlug,
  electronZipName,
  ensureElectronRuntime,
  MAC_WINDOW_LINK,
} from "./electron-runtime-fetch.ts";

/** The runtime a SHIPPED package carries beside its executable.
 *
 *  `build-electron.ts` puts the whole Electron dist in `./electron/` next to
 *  the binary, and the Linux AppRun / `run.bat` / `run.sh` launchers export
 *  `$ELECTRON_PATH` at it. Nothing looked for it directly — so the Windows
 *  README's own instruction ("double-click myapp.exe") skipped the launcher,
 *  found no candidate, and fell through to a ~100 MB download of the runtime
 *  that was sitting in the same folder. Offline it printed "Electron is not
 *  available on this machine", with Electron right there.
 *
 *  Resolved against the EXECUTABLE, never the cwd: a packaged app is started
 *  from wherever its user happens to be. (In dev `Deno.execPath()` is `deno`
 *  itself, so this simply never matches — one candidate that stats and fails,
 *  before the node_modules rung that dev actually uses.)
 *
 *  This replaces three hardcoded `dist/{mac,win-unpacked,linux-unpacked}/…`
 *  paths — the electron-builder layout, which this repo has not produced for a
 *  long time. They stat'd relative to the CWD and could never match anything
 *  aio builds. */
export function packagedElectronCandidates(
  execPath?: string,
  os: string = Deno.build.os,
): string[] {
  try {
    const dir = dirname(execPath ?? Deno.execPath());
    return [
      // A macOS bundle's own link to that runtime FIRST: the window must be
      // started through it to be the app the user installed (see
      // MAC_WINDOW_LINK). A bundle assembled before the link existed has
      // none, and falls through to the nested path it always used.
      ...(os === "darwin" ? [join(dir, MAC_WINDOW_LINK)] : []),
      electronBinIn(join(dir, "electron"), os),
    ];
  } catch {
    return [];
  }
}

/** What is at the macOS bundle's window link.
 *
 *  `usable`: the link with its target in place, or an executable file.
 *  `flattened`: a plain file that cannot be executed — what an archive tool
 *  that does not keep symbolic links leaves (the target's path, as text).
 *  `absent`: nothing there (a bundle assembled before the link existed), or a
 *  link whose target is gone — the runtime itself is missing, and the nested
 *  candidate says so by not being there either. */
export async function macWindowLinkState(
  path: string,
): Promise<"absent" | "usable" | "flattened"> {
  try {
    const at = await Deno.lstat(path);
    const s = at.isSymlink ? await Deno.stat(path) : at; // dangling: throws
    if (!s.isFile) return "absent";
    if (at.isSymlink || ((s.mode ?? 0o111) & 0o111) !== 0) return "usable";
    return "flattened";
  } catch {
    return "absent"; // aio-ok: the answer IS the result — nothing to start here
  }
}

/** How the launcher may obtain a runtime it cannot find. Injected so the
 *  resolution ORDER — the part that was wrong — is a unit test, not a 100 MB
 *  download and a display. */
export type FindElectronOpts = {
  /** The embedded/on-disk dist/ carrying `electron.json` (compiled binaries). */
  distDir?: string;
  /** Running as a compiled binary — `Deno.execPath()` is the app, not deno. */
  compiled?: boolean;
  /** The executable to resolve the shipped-runtime candidate against.
   *  Injected in tests; defaults to `Deno.execPath()`. */
  execPath?: string;
  /** The OS whose package layout is looked for (tests); the host's. */
  os?: string;
  /** The fetch-into-cache step (`ensureElectronRuntime`). */
  fetchRuntime?: (
    version: string,
    slug: string,
    log: Log,
  ) => Promise<string>;
  /** The embedded-runtime unpack step (tests). */
  unpackEmbedded?: (log: Log) => Promise<string>;
  /** The dev-only `deno install` step (`autoInstallElectron`). */
  denoInstall?: (log: Log) => Promise<boolean>;
  /** Aborted when the app starts shutting down: an installer still running
   *  is killed (its whole process group) instead of outliving the app. */
  signal?: AbortSignal;
};

/** Resolves an Electron binary — $ELECTRON_PATH > packaged dist > node_modules
 *  dev > (compiled: fetched runtime cache | dev: deno install, then the cache).
 *
 *  The last rung is the one a COMPILED desktop app used to lack. Its runtime
 *  was looked up under the current directory and, failing that, "installed" by
 *  running `Deno.execPath() install npm:electron` — which inside a compiled
 *  binary runs the app itself. So an app installed by the one-liner opened
 *  nothing, and the message told its user to run `deno task
 *  install:electron` in a checkout they had not been handed. A binary now
 *  fetches the runtime its build baked (`dist/electron.json`) into the
 *  per-user cache, once, and runs it from there — no npm, no deno, no cwd. */
export async function findElectronBin(
  log: Log,
  opts: FindElectronOpts = {},
): Promise<string | null> {
  // 1. ELECTRON_PATH env var (AppImage / custom deployment)
  let envPath = Deno.env.get("ELECTRON_PATH");
  // An Electron AppImage's AppRun exports it into its own mount, and every
  // child inherits it: an app started from that AppImage's terminal would run
  // the HOST's Electron, from a mount that vanishes when the host exits.
  const appDir = Deno.env.get("APPDIR");
  if (
    // aio-ok: path-split — APPDIR is an AppImage mount — Linux only
    envPath && appDir && envPath.startsWith(appDir + "/") &&
    appImageOwner(
        opts.execPath ?? Deno.execPath(),
        Deno.env.get("APPIMAGE"),
        appDir,
      ) === "foreign"
  ) {
    log.error(
      `$ELECTRON_PATH (${envPath}) is inherited from the AppImage that ` +
        `started this app (${appDir}) — ignored`,
    );
    envPath = undefined;
  }
  if (envPath) {
    try {
      await Deno.stat(envPath);
      return envPath;
    } catch {
      log.error(`$ELECTRON_PATH set but not found: ${envPath}`);
    }
  }

  // 2. The runtime this package SHIPS, beside the executable.
  const os = opts.os ?? Deno.build.os;
  for (const cand of packagedElectronCandidates(opts.execPath, os)) {
    // The macOS bundle's link is taken only when it can be STARTED. An
    // archive tool that does not keep symbolic links writes it as a small
    // text file holding the target: a file, so it used to be taken, the
    // spawn failed with PermissionDenied and the app ran on with no window.
    // The runtime it pointed at is still there — one candidate further.
    if (os === "darwin" && basename(cand) === MAC_WINDOW_LINK) {
      const link = await macWindowLinkState(cand);
      if (link === "usable") return cand;
      if (link === "flattened") {
        log.error(
          `electron: ${cand} is not the link this app was built with — the ` +
            `bundle was unpacked by a tool that does not keep symbolic ` +
            `links. Starting the window from the runtime inside the bundle ` +
            `instead: the app works, but macOS will not see a re-opened app ` +
            `as this one (quitting it by its id can then fail). Unpack the ` +
            `download again with Archive Utility, \`ditto\` or \`unzip\` ` +
            `to repair it.`,
        );
      }
      continue;
    }
    try {
      if ((await Deno.stat(cand)).isFile) return cand;
    } catch { /* not this layout */ }
  }

  // 3. node_modules dev binary
  const electronBin = Deno.build.os === "windows"
    ? "node_modules\\.bin\\electron.cmd"
    : "node_modules/.bin/electron";
  const compiled = opts.compiled ?? isCompiled();
  const denoInstall = opts.denoInstall ??
    ((l: Log) =>
      autoInstallElectron(
        l,
        opts.signal
          ? (v) => runInstaller(electronInstallArgs(v), undefined, opts.signal)
          : undefined,
        undefined,
        undefined,
        undefined,
        opts.signal,
      ));
  // A compiled binary never takes it: started from inside a dev tree it used
  // to run THAT tree's Electron instead of the one it was built with (review
  // pass, 2026-09-18). node_modules is a dev-time thing.
  const noInstall = compiled ? null : await installRefusal();
  if (!compiled && await electronBinReady(electronBin)) {
    // aio decides the Electron, not whatever node_modules happens to hold: the
    // build ships DEFAULT_ELECTRON_VERSION (the one this aio is tested with),
    // so dev running another one is a dev/prod split. An app scaffolded by an
    // older aio keeps its old runtime across `am pin` unless something moves
    // it — this is the dev half of that (`am pin` / `am fix` the other).
    // Moved once, loudly; offline, the old runtime still runs (said so).
    const have = await installedRuntimeVersion();
    if (have === null || have === DEFAULT_ELECTRON_VERSION) return electronBin;
    if (noInstall === null) {
      log.error(
        `electron: node_modules has Electron ${have}; this aio is tested ` +
          `with ${DEFAULT_ELECTRON_VERSION} (the one a build ships) — ` +
          `installing it`,
      );
      if (
        await denoInstall(log) &&
        await installedRuntimeVersion() === DEFAULT_ELECTRON_VERSION
      ) return electronBin;
      log.error(
        `electron: could not install ${DEFAULT_ELECTRON_VERSION} — running ` +
          `${have} for now. \`am fix\` retries; a build ships ` +
          `${DEFAULT_ELECTRON_VERSION} regardless.`,
      );
      return electronBin;
    }
    // Nowhere to install the tested one: it comes from the cache (below).
    log.error(
      `electron: node_modules has Electron ${have}; this aio is tested with ` +
        `${DEFAULT_ELECTRON_VERSION} (the one a build ships)`,
    );
  }

  const fetchRuntime = opts.fetchRuntime ??
    ((v: string, slug: string, l: Log) =>
      ensureElectronRuntime(v, slug, { log: l.info, warn: l.error }));

  // 4. Dev only — auto-install on first run: `deno install` FORCE-adds
  //    electron (positional `npm:electron`) so `deno task dev` works no matter
  //    what — even if the app never declared electron as a dep.
  //    `--allow-scripts=npm:electron` runs the postinstall that downloads the
  //    real binary. Loud progress. Skipped in a compiled binary: there is no
  //    deno to run and no project to install into.
  //    Skipped, too, when the current directory is not a project: `deno
  //    install` CREATES a `deno.json` (and a lock) wherever it runs, so an
  //    app started from somewhere else — a login item starts in the home
  //    directory — left a config there on every launch, installed nothing it
  //    could find afterwards, and turned that directory into "a project" for
  //    every tool that looks upward for one.
  //    And never into the framework's own checkout — `installRefusal`.
  if (!compiled) {
    if (noInstall !== null) {
      log.info(
        `electron: ${Deno.cwd()} ${noInstall} — not installing into it; ` +
          `using the cached runtime`,
      );
    } else if (await denoInstall(log)) {
      if (await electronBinReady(electronBin)) return electronBin;
    }
  }
  // Stopping: no 100 MB fetch for a window nobody will see.
  if (opts.signal?.aborted) return null;

  const version = (await bakedElectronVersion(opts.distDir)) ??
    DEFAULT_ELECTRON_VERSION;
  const slug = electronSlug();

  // 5. The runtime this binary CARRIES (a self-contained Windows exe): the
  //    same install as a download — lock, integrity check, unpack into the
  //    per-user cache — fed from the embedded zip. Never the network: a
  //    self-contained app that cannot unpack says why instead of quietly
  //    fetching 100 MB it was built not to need.
  if (compiled) {
    try {
      const rt = await bakedEmbeddedRuntime(opts.distDir);
      if (rt) {
        if (rt.name !== electronZipName(version, slug)) {
          throw new Error(
            `this binary carries ${rt.name}, but this machine needs ` +
              `${electronZipName(version, slug)} — it was built for another ` +
              `platform.`,
          );
        }
        const unpack = opts.unpackEmbedded ??
          ((l: Log) =>
            ensureElectronRuntime(version, slug, {
              log: l.info,
              warn: l.error,
              embedded: rt,
            }));
        const bin = electronBinIn(await unpack(log));
        await Deno.stat(bin);
        return bin;
      }
    } catch (e) {
      log.error(
        `the Electron runtime inside this app could not be unpacked: ${
          e instanceof Error ? e.message : e
        }`,
      );
      return null;
    }
  }

  // 6. The runtime Electron publishes, into the per-user cache. THE path for a
  //    compiled binary built without one; the last resort for dev (offline
  //    npm, a proxy that blocks the lifecycle script — the zip may still be
  //    reachable).
  try {
    const dir = await fetchRuntime(version, slug, log);
    const bin = electronBinIn(dir);
    await Deno.stat(bin);
    return bin;
  } catch (e) {
    log.error(
      `Electron ${version} (${slug}) could not be fetched: ${
        e instanceof Error ? e.message : e
      }`,
    );
  }
  log.error(
    compiled
      ? "Electron is not available on this machine and could not be " +
        "downloaded. Check the network (github.com/electron/electron " +
        "releases), or point $ELECTRON_PATH at an Electron you already have."
      : "Electron could not be installed automatically. Check your network, " +
        "then retry `deno task dev` — or run `deno task install:electron`, " +
        "which downloads the runtime directly (a bare `deno install` can " +
        "skip the lifecycle script and exit 0 with nothing installed)",
  );

  return null;
}

/** True when the electron launcher exists AND its real binary is downloaded.
 *  `.bin/electron` is created by `deno install` BEFORE the postinstall
 *  downloads the ~100MB binary, so the launcher can exist while the binary is
 *  still missing (a broken launch). We check the launcher resolves to a real
 *  electron dist binary via its `path.txt`. */
async function electronBinReady(launcher: string): Promise<boolean> {
  try {
    await Deno.stat(launcher);
  } catch {
    return false;
  }
  // Find the electron package dir the launcher points into and confirm the
  // downloaded binary exists (path.txt names it, inside dist/).
  // "no path.txt anywhere" and "path.txt present, the binary it names is
  // missing" used to be the same answer: both fell through to `return true`.
  // The second is precisely the broken install this check exists to catch —
  // reading an existing path.txt succeeds, so the outer catch never fires — and
  // returning true there handed back a launcher that cannot start Electron.
  let sawPathTxt = false;
  try {
    for (
      const base of [
        "node_modules/electron",
        ...(await denoElectronDirs()),
      ]
    ) {
      let rel: string;
      try {
        rel = (await Deno.readTextFile(`${base}/path.txt`)).trim();
      } catch {
        continue; // no manifest here — try the next candidate
      }
      sawPathTxt = true;
      try {
        await Deno.stat(`${base}/dist/${rel}`);
        return true; // real binary present
      } catch { /* named binary missing — keep looking, but remember */ }
    }
  } catch { /* fall through */ }
  // A path.txt existed and named a binary that is not there: the install is
  // broken, and saying so is the whole point of this function.
  if (sawPathTxt) return false;
  // No path.txt found at all (older layout) — trust the launcher's existence.
  return true;
}

/** Electron package dirs under Deno's `.deno` npm cache (node_modules/.deno/
 *  electron@<ver>/node_modules/electron). */
async function denoElectronDirs(root = "."): Promise<string[]> {
  const dirs: string[] = [];
  try {
    for await (const e of Deno.readDir(`${root}/node_modules/.deno`)) {
      if (e.isDirectory && e.name.startsWith("electron@")) {
        dirs.push(`${root}/node_modules/.deno/${e.name}/node_modules/electron`);
      }
    }
  } catch { /* no .deno dir */ }
  return dirs;
}

/** WHERE the installed Electron runtime actually is — `<pkg>/dist`, or null.
 *
 *  THE resolver, for the runtime and the build alike. It exists because there
 *  were two: this file has always known that Deno's node_modules layout puts
 *  the package under `node_modules/.deno/electron@<ver>/node_modules/electron`
 *  (with `node_modules/electron` sometimes a symlink and sometimes absent),
 *  while `build-electron.ts` checked `node_modules/electron/dist` and nothing
 *  else. So `deno task compile --electron` auto-installed Electron
 *  successfully, failed to find what it had just installed, and told the user
 *  to run `deno task install:electron` — which installs it to the same place
 *  the build would still not look. That is the bug a user reported as "the
 *  one-line command doesn't start the app; I had to run install:electron
 *  first", and it could only be fixed by making both sides read one rule. */
export async function electronDistDir(root = "."): Promise<string | null> {
  for (const base of await electronPkgDirs(root)) {
    try {
      const info = await Deno.stat(`${base}/dist`);
      if (info.isDirectory) return `${base}/dist`;
    } catch { /* not here — try the next layout */ }
  }
  return null;
}

/** The version of the Electron runtime installed under `root`, or null.
 *
 *  Counts only when the runtime is UNPACKED: a `package.json` outlives a
 *  deleted `dist/` (and `deno install` rewrites it before the lifecycle script
 *  downloads anything), so reading it alone reported a version nothing on
 *  this machine could run — the build baked 43.0.0 into the self-contained
 *  exe while auto-install put 44.4.1 in the zip (real Windows 11,
 *  2026-09-17). THE reader: the build, the dev launcher and `am fix` (via
 *  `electron-install.ts --version`) all ask it. */
export async function installedRuntimeVersion(
  root = ".",
): Promise<string | null> {
  for (const base of await electronPkgDirs(root)) {
    try {
      if (!(await Deno.stat(join(base, "dist"))).isDirectory) continue;
    } catch {
      continue;
    }
    try {
      const pkg = JSON.parse(
        await Deno.readTextFile(join(base, "package.json")),
      ) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch { /* not this layout — try the next */ }
  }
  return null;
}

/** Every place the electron PACKAGE itself may live (both node_modules
 *  layouts). `electronDistDir` and the installer recovery below read the same
 *  list, so "where is electron" has one answer. */
export async function electronPkgDirs(root = "."): Promise<string[]> {
  return [`${root}/node_modules/electron`, ...(await denoElectronDirs(root))];
}

/** Every config file an app may keep its Electron pin in, with the text it
 *  held before an install. Missing files are simply absent. */
async function readDenoConfigTexts(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const name of DENO_JSON_NAMES) {
    const text = await Deno.readTextFile(join(root, name)).catch(() => null);
    if (text !== null) out.set(name, text);
  }
  return out;
}

/** The framework's own package name — what its `deno.json` is called. */
const FRAMEWORK_PACKAGE = "@riagentic/aio";

/** {@linkcode installRefusal}'s answer for the framework's own checkout. */
export const FRAMEWORK_CHECKOUT =
  "is the aio framework's own checkout (an install would edit its " +
  "deno.json and deno.lock)";

/** The directory THIS copy of the framework lives in, when it is on disk
 *  (a checkout, or an app's `dep/aio`); null when it was loaded over the
 *  network. `src/electron/` is two levels below it. */
function frameworkRoot(): string | null {
  try {
    return fromFileUrl(new URL("../../", import.meta.url));
  } catch {
    return null; // aio-ok: not a file: URL — there is no checkout to protect
  }
}

/** Why `deno install` must NOT run in `root` — the words the log line
 *  carries — or null when it may. ONE decider for "is this a place to install
 *  Electron into":
 *
 *  - not a project: no deno config and no `package.json`. `deno install`
 *    would CREATE them there.
 *  - the framework's own checkout: an install EDITS its tracked `deno.json`
 *    (an `electron` import) and `deno.lock` — a clean clone was dirty after
 *    one `deno task amui`, which is what `am upgrade` refuses to run over.
 *    Known by identity, not by guess: `root` IS the directory this module was
 *    loaded from, or its config carries the framework's package name (one
 *    checkout run from inside another). An app that vendors the framework
 *    under `dep/aio` is neither — its cwd is the app — and installs as before.
 */
export async function installRefusal(
  root = ".",
  own: string | null = frameworkRoot(),
): Promise<string | null> {
  if (own !== null) {
    try {
      if (await Deno.realPath(root) === await Deno.realPath(own)) {
        return FRAMEWORK_CHECKOUT;
      }
    } catch { /* aio-ok: a root that cannot be resolved is not the checkout */ }
  }
  let project = false;
  for (const name of [...DENO_JSON_NAMES, "package.json"]) {
    let text: string;
    try {
      text = await Deno.readTextFile(join(root, name));
    } catch {
      continue; // aio-ok: absent is the answer being asked for
    }
    project = true;
    try {
      if (parseDenoJson(text, name).name === FRAMEWORK_PACKAGE) {
        return FRAMEWORK_CHECKOUT;
      }
    } catch {
      /* aio-ok: unreadable is still a project — the install says so */
    }
  }
  return project ? null : "is not a project (no deno.json or package.json)";
}

/** `imports.electron` as a config TEXT spells it, or null. Pure; tolerant —
 *  an unparseable file answers null rather than throwing, because this is
 *  only ever used to REPORT what an install did. */
export function electronImportSpec(text: string, file: string): string | null {
  try {
    const cfg = parseDenoJson(text, file) as {
      imports?: Record<string, string>;
    };
    const spec = cfg?.imports?.["electron"];
    return typeof spec === "string" ? spec : null;
  } catch {
    // aio-ok(silent-catch): a config this installer cannot parse is the app's
    // own problem, reported by every command that actually reads it; a
    // post-install NOTE must never be the thing that throws.
    return null;
  }
}

/** Every `npm:electron@x.y.z` a config text names, in order, deduped. Pure.
 *  An app keeps more than one copy of the choice — the import map, a task
 *  spelling `--allow-scripts=npm:electron@…` — and the whole §12 defect is the
 *  copies silently DISAGREEING after an install. */
export function electronSpecsInText(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/npm:\/?electron@(\d+\.\d+\.\d+[^"'\s,]*)/g)) {
    if (!out.includes(m[1]!)) out.push(m[1]!);
  }
  return out;
}

/** What the app's author must be TOLD about their config after an install.
 *
 *  `deno install --allow-scripts=npm:electron npm:electron@<v>` takes a
 *  POSITIONAL package, so deno rewrites `imports.electron` to `<v>`. aio is
 *  tested with ONE Electron and a build ships exactly that one, so `<v>` is
 *  aio's — the version choice is policy (`am pin` / `am fix` keep an app's
 *  copies on it). Editing somebody's `deno.json` in SILENCE is not: a field
 *  report found an app whose pin had been rewritten with no line of output,
 *  and another copy of the version left behind, so the file disagreed with
 *  itself. Both are said here, once, at the install that caused them.
 *
 *  Pure: the two texts in, the lines out (empty when nothing moved). */
export function electronConfigNotes(
  file: string,
  before: string,
  after: string,
  installed: string,
): string[] {
  const notes: string[] = [];
  const was = electronImportSpec(before, file);
  const now = electronImportSpec(after, file);
  if (was !== now) {
    notes.push(
      `${HEY} the Electron pin in ${file} was rewritten by \`deno install\`: ` +
        `${was === null ? "(none)" : `"${was}"`} → ${
          now === null ? "(none)" : `"${now}"`
        }. aio is tested with ONE Electron and a build ships exactly that one, ` +
        `so the install asks for it BY VERSION — and a positional package ` +
        `rewrites the import map. Review the diff and commit it deliberately; ` +
        `\`am fix\` is what keeps an app's copies aligned.`,
    );
  }
  const stale = electronSpecsInText(after).filter((v) => v !== installed);
  if (stale.length > 0) {
    notes.push(
      `${HEY} ${file} still names npm:electron@${
        stale.join(", npm:electron@")
      } while the installed runtime is ${installed} — the app's copies of its ` +
        `Electron version DISAGREE. Align them (\`am fix\`), or the next ` +
        `command that reads the other copy runs a different Chromium.`,
    );
  }
  return notes;
}

/** Force-install electron in the app cwd so `dev:electron` / `compile:electron`
 *  work OUT OF THE BOX — even when the app didn't declare electron as a dep.
 *  The positional `npm:electron` adds + installs it; `--allow-scripts` runs its
 *  postinstall (downloads the binary). Returns true when the command succeeded.
 *  `run` is the command seam (injected in tests; real `deno install` here). */
export async function autoInstallElectron(
  log: {
    info?: (m: string) => void;
    warn?: (m: string) => void;
    error: (m: string) => void;
  },
  run: (version: string) => Promise<{ success: boolean }> = (v: string) =>
    runInstaller(electronInstallArgs(v)),
  // "Is the runtime actually there?" — the ONLY question whose answer this
  // function may return. It used to return `run().success`, i.e. whether the
  // installer EXITED ZERO, and that is the defect: `deno install` exits zero
  // having skipped the lifecycle script, so a caller was told "installed" and
  // then could not find a binary. Injected so the contract can be tested
  // without a 100MB download.
  isInstalled: () => Promise<boolean> = () =>
    electronDistDir().then((d) => d !== null),
  /** The exact version to install — aio's tested one unless `am fix` asks
   *  for the one the app's PINNED aio is tested with. */
  version: string = DEFAULT_ELECTRON_VERSION,
  /** Where the app's config lives — the file `deno install` REWRITES, read
   *  before and after so the rewrite is reported rather than silent. */
  root = ".",
  /** Aborted when the app starts shutting down — see `runInstaller`. */
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false;
  (log.info ?? console.log)(
    `electron: not installed — auto-installing (deno install ` +
      `--allow-scripts=npm:electron npm:electron@${version})… ` +
      `first run downloads the Electron binary (~100MB), this can take a minute.`,
  );
  const before = await readDenoConfigTexts(root);
  const report = async () => {
    const say = log.warn ?? log.error;
    for (const [file, text] of before) {
      const after = await Deno.readTextFile(join(root, file)).catch(() => null);
      if (after === null) continue;
      for (const note of electronConfigNotes(file, text, after, version)) {
        say(note);
      }
    }
  };
  try {
    await run(version);
    await report();
    if (await isInstalled()) return true;
    // The install "succeeded" and the runtime is NOT there.
    //
    // `--allow-scripts` only PERMITS the lifecycle script; whether it actually
    // RUNS depends on what deno already had cached and on whether the package
    // counts as newly added — conditions an app cannot see or control. When it
    // is skipped, `deno install` exits 0 with a package that has no `dist/`,
    // and every later step reports the confusing half of the truth: "electron
    // is not installed — run deno task install:electron", advice that runs the
    // same command and skips the same script. A user hit exactly that loop and
    // could only get out of it by accident.
    //
    // So run the package's OWN installer, which downloads and unpacks the
    // platform binary. It is CommonJS; `--unstable-detect-cjs` is what lets
    // deno load it. This is the step that makes `--target=electron` work on a
    // machine that has never seen Electron.
    for (const pkg of await electronPkgDirs()) {
      if (signal?.aborted) return false;
      try {
        await Deno.stat(`${pkg}/install.js`);
      } catch {
        continue;
      }
      (log.info ?? console.log)(
        `electron: the lifecycle script did not run — invoking ${pkg}/install.js directly`,
      );
      const r = await runInstaller(
        ["run", "-A", "--unstable-detect-cjs", "install.js"],
        pkg,
        signal,
      );
      if (r.success && await isInstalled()) return true;
    }
    return await isInstalled();
  } catch {
    return false;
  }
}

/** `deno install` of the ONE pinned Electron. PINNED to the framework's
 *  version, not bare `npm:electron`: bare resolves to whatever is latest at
 *  INSTALL time, so a dev tree could run one Electron while the build's floor
 *  is another — the drift `tests/electron-version-consistency.test.ts` gates.
 *  The pin lives in this folder (`electron-runtime-fetch.ts`), so no boundary
 *  is crossed to read it. */
function electronInstallArgs(v: string): string[] {
  return ["install", "--allow-scripts=npm:electron", `npm:electron@${v}`];
}

/** How an installer started with an abort signal is ended — as a whole
 *  TREE, because `install.js` (and whatever `deno install`'s lifecycle step
 *  spawns) is a grandchild, and killing the direct child alone orphans it:
 *  - POSIX: the child leads its own process group (`detached`) → signal the
 *    group;
 *  - Windows: there are no process groups to signal, and ending a process
 *    never ends its children → `taskkill /T /F /PID <pid>` (tree, forced).
 *  Pure — pinned by its test, since Windows cannot run here.
 *  @internal exported for its test only. */
export function installerKillPlan(
  os: typeof Deno.build.os,
  pid: number,
):
  | { kind: "group"; pgid: number }
  | { kind: "tree"; cmd: string; args: string[] } {
  return os === "windows"
    ? { kind: "tree", cmd: "taskkill", args: ["/T", "/F", "/PID", String(pid)] }
    : { kind: "group", pgid: pid };
}

/** End one installer tree per its plan. Synchronous: it also runs from
 *  `unload`, where nothing async completes. */
function killInstallerTree(
  pid: number,
  plan: ReturnType<typeof installerKillPlan>,
): void {
  try {
    if (plan.kind === "group") {
      Deno.kill(-plan.pgid, "SIGTERM");
      return;
    }
    const r = new Deno.Command(plan.cmd, {
      args: plan.args,
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).outputSync();
    // taskkill missing or refused: at least the direct child goes.
    if (!r.success) Deno.kill(pid, "SIGKILL");
  } catch { /* aio-ok: the installer already exited — nothing to kill */ }
}

/** Installers started with a signal and still running → how to end each.
 *  Killed on ANY process exit. */
const _installerTrees = new Map<
  number,
  ReturnType<typeof installerKillPlan>
>();
let _unloadArmed = false;
function killInstallerGroups(): void {
  for (const [pid, plan] of _installerTrees) killInstallerTree(pid, plan);
  _installerTrees.clear();
}

/** Run a `deno` installer step, killable by `signal`.
 *
 *  The dev launcher installs Electron DURING boot, and a SIGTERM there used to
 *  leave the installer running: the app exited, `deno install` and the
 *  `install.js` it spawns kept downloading 100 MB as orphans. With a signal the
 *  step is killed as a whole TREE on abort ({@linkcode installerKillPlan}: its
 *  own process group on POSIX, `taskkill /T` on Windows) — `install.js` is a
 *  grandchild, so killing the direct child alone would still orphan it.
 *  Without a signal (`deno task install:electron`, a build) it is an ordinary
 *  foreground child, exactly as before.
 *
 *  On POSIX its own session also means a closed terminal's SIGHUP no longer
 *  reaches it, so the tree is killed on every other way out too — on every
 *  OS: SIGHUP is a stop for an Electron app (`aio-lifecycle.ts`, which aborts
 *  `signal`), and the exits that skip the abort are covered by listeners
 *  armed below: `unload` for `Deno.exit` and a normal end — but NOT for an
 *  uncaught error or an unhandled rejection, which on Deno 2.9 end the
 *  process without `unload` (measured), hence the `error` /
 *  `unhandledrejection` listeners. Those never `preventDefault()` (the
 *  process still dies as it would have) and stand down when an earlier
 *  listener — an app's crash handler — already prevented it, because then
 *  the process lives on and so may its install.
 *  @internal exported for its test only. */
export async function runInstaller(
  args: string[],
  cwd?: string,
  signal?: AbortSignal,
): Promise<{ success: boolean }> {
  if (signal?.aborted) return { success: false };
  const tracked = !!signal;
  const group = tracked && Deno.build.os !== "windows";
  const child = new Deno.Command(Deno.execPath(), {
    args,
    cwd,
    stdin: tracked ? "null" : "inherit",
    stdout: "inherit",
    stderr: "inherit",
    detached: group,
  }).spawn();
  const plan = installerKillPlan(Deno.build.os, child.pid);
  if (tracked) {
    _installerTrees.set(child.pid, plan);
    if (!_unloadArmed) {
      _unloadArmed = true;
      globalThis.addEventListener("unload", killInstallerGroups);
      const onFatal = (e: Event) => {
        if (!e.defaultPrevented) killInstallerGroups();
      };
      globalThis.addEventListener("error", onFatal);
      globalThis.addEventListener("unhandledrejection", onFatal);
    }
  }
  const kill = () => killInstallerTree(child.pid, plan);
  signal?.addEventListener("abort", kill, { once: true });
  try {
    return await child.status;
  } finally {
    _installerTrees.delete(child.pid);
    signal?.removeEventListener("abort", kill);
  }
}

/** How many of the window's last stderr lines a crash report quotes. */
const STDERR_TAIL_LINES = 8;

/** Per launched window: its last stderr lines (GPU-probe noise excluded) and
 *  when the stream ended. Read by {@linkcode electronStderrTail}. */
const _stderrTails = new WeakMap<
  Deno.ChildProcess,
  { lines: string[]; done: Promise<void> }
>();

/** The last stderr lines of a window this module launched — what a crash
 *  report quotes ("Authorization required", a Chromium FATAL). Waits up to
 *  `waitMs` for the stream to end, since the exit status can resolve before
 *  the pipe is drained. Empty for a process not launched here. */
export async function electronStderrTail(
  proc: Deno.ChildProcess,
  waitMs = 500,
): Promise<string[]> {
  const t = _stderrTails.get(proc);
  if (!t) return [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    t.done,
    new Promise<void>((r) => timer = setTimeout(r, waitMs)),
  ]).finally(() => clearTimeout(timer));
  return [...t.lines];
}

/** Route the Electron child's stderr: renderer lines the shell tagged go to
 *  the framework logger at their level (so a page that throws lands in the
 *  app log and `am logs`, not only on a terminal nobody is watching), and so
 *  do the main process's own tagged warnings/errors (category `electron`); GPU
 *  device-probe noise is dropped and counted; everything else passes through
 *  untouched. The sorting is `classifyElectronLine` — pure, unit-tested. */
export function forwardStderr(proc: Deno.ChildProcess): void {
  let dropped = 0;
  let reported = false;
  const tail: string[] = [];
  let finished!: () => void;
  _stderrTails.set(proc, {
    lines: tail,
    done: new Promise<void>((r) => finished = r),
  });
  void (async () => {
    const enc = new TextEncoder();
    let carry = "";
    const route = async (line: string) => {
      const r = classifyElectronLine(line);
      if (r.route !== "drop" && r.text.trim() !== "") {
        tail.push(r.text);
        if (tail.length > STDERR_TAIL_LINES) tail.shift();
      }
      switch (r.route) {
        case "drop":
          dropped++;
          // Say it once, so the lines are accounted for rather than vanished.
          if (!reported) {
            reported = true;
            await Deno.stderr.write(enc.encode(
              "[aio] suppressing GPU device-probe messages from Electron " +
                "(harmless: a GPU with no Mesa driver, probed and skipped)\n",
            )).catch(() => {});
          }
          return;
        case "error":
          log.error(r.from, r.text);
          return;
        case "warn":
          log.warn(r.from, r.text);
          return;
        case "info":
          log.info(r.from, r.text);
          return;
        case "raw":
          await Deno.stderr.write(enc.encode(r.text + "\n")).catch(() => {});
      }
    };
    try {
      for await (
        const chunk of proc.stderr.pipeThrough(new TextDecoderStream())
      ) {
        const lines = (carry + chunk).split("\n");
        carry = lines.pop() ?? "";
        for (const line of lines) await route(line);
      }
      if (carry !== "") await route(carry);
    } catch { /* child gone — nothing left to forward */ }
    finished();
    if (dropped > 0) {
      await Deno.stderr.write(enc.encode(
        `[aio] suppressed ${dropped} GPU device-probe line(s)\n`,
      )).catch(() => {});
    }
  })();
}

/** The project root a `node_modules/.bin/electron` launcher belongs to, or
 *  null when `bin` is not that launcher (a real binary: $ELECTRON_PATH, the
 *  shipped `./electron/`, the fetched runtime). Pure — both path separators,
 *  the Windows `.cmd` spelling, relative and absolute. */
export function electronShimRoot(bin: string): string | null {
  const m = /^(.*?)node_modules[\/\\]\.bin[\/\\]electron(?:\.cmd)?$/.exec(bin);
  if (!m) return null;
  const root = m[1]!.replace(/[\/\\]+$/, "");
  return root === "" || root === "." ? "." : root;
}

/** The executable `bin` actually RUNS. The dev launcher is a Node shim
 *  (`cli.js`) that spawns `<pkg>/dist/<path.txt>` — the same file
 *  `electronBinReady` checks for — and everything that judges the runtime by
 *  its neighbours (the sandbox helper, below) has to look there, not beside
 *  the shim. A real binary, or a shim whose package names no binary, is
 *  returned as given. */
export async function realElectronBin(
  bin: string,
  overrideDist = Deno.env.get("ELECTRON_OVERRIDE_DIST_PATH"),
): Promise<string> {
  const root = electronShimRoot(bin);
  if (root === null) return bin;
  for (const pkg of await electronPkgDirs(root)) {
    try {
      // path.txt names the binary inside dist/; a package without one names
      // none.
      const named = (await Deno.readTextFile(`${pkg}/path.txt`)
        .catch(() => "")).trim();
      // The shim's own rule (electron/index.js): `$ELECTRON_OVERRIDE_DIST_PATH`
      // replaces the package's dist/ and keeps path.txt's file name —
      // `electron` when there is no path.txt, the layout an override is for.
      const real = overrideDist
        ? join(overrideDist, named || "electron")
        : named && `${pkg}/dist/${named}`;
      if (real && (await Deno.stat(real)).isFile) return real;
    } catch { /* not this layout — try the next */ }
  }
  return bin;
}

/** Chromium's SUID helper lives beside the REAL binary. Pure. */
export function chromeSandboxPath(realBin: string): string {
  // aio-ok: path-split — chrome-sandbox exists on Linux only
  return realBin.replace(/\/[^/]+$/, "/chrome-sandbox");
}

/** Can THIS process create an unprivileged user namespace — the sandbox
 *  Chromium prefers, and the one it silently uses whenever it can, without
 *  ever looking at the SUID helper?
 *
 *  Decided the way Chromium decides it, not the way a distro is named:
 *  restricted when a sysctl says so (Ubuntu 23.10+'s
 *  `apparmor_restrict_unprivileged_userns`, Debian's
 *  `unprivileged_userns_clone`, a `max_user_namespaces` of 0), or when the
 *  syscall itself is refused — a container's seccomp profile blocks
 *  CLONE_NEWUSER while every sysctl reads "allowed". The AppArmor sysctl is
 *  read BEFORE the probe on purpose: Ubuntu confines `unshare` under a profile
 *  that is allowed namespaces, so the probe passes there while an unconfined
 *  Electron is refused. `read`/`probe` are injected so the decision table is
 *  a unit test, not a fleet of VMs. */
export async function usernsAvailable(
  read: (p: string) => Promise<string> = (p) => Deno.readTextFile(p),
  probe: () => Promise<boolean> = unshareProbe,
): Promise<boolean> {
  const sysctl = async (p: string) => (await read(p).catch(() => "")).trim();
  if (
    await sysctl("/proc/sys/kernel/apparmor_restrict_unprivileged_userns") ===
      "1"
  ) return false;
  if (await sysctl("/proc/sys/kernel/unprivileged_userns_clone") === "0") {
    return false;
  }
  if (await sysctl("/proc/sys/user/max_user_namespaces") === "0") return false;
  return await probe();
}

/** `unshare -U true`: the same clone(CLONE_NEWUSER) Chromium's zygote tries.
 *  No `unshare` on this box says nothing about the kernel — assume allowed,
 *  which is the pre-existing behaviour. */
async function unshareProbe(): Promise<boolean> {
  try {
    const r = await new Deno.Command("unshare", {
      args: ["-U", "--", "true"],
      stdout: "null",
      stderr: "null",
    }).output();
    return r.success;
  } catch {
    return true;
  }
}

/** Can Chromium's SUID sandbox helper actually be used here?
 *
 *  Electron's `chrome-sandbox` must be owned by root with mode 4755. An
 *  npm/deno install cannot do that — it has no root — so the file lands
 *  unprivileged, and Chromium REFUSES TO START rather than run unsandboxed:
 *
 *    FATAL:setuid_sandbox_host.cc(166)] The SUID sandbox helper binary was
 *    found, but is not configured correctly …
 *    electron exited with signal SIGTRAP
 *
 *  Historically this did not bite, because Chromium falls back to the
 *  namespace sandbox when unprivileged user namespaces are allowed. Ubuntu
 *  24.04 (and every distro that followed it, Mint 22 included) restricts those
 *  by default — and every container does — so the fallback is gone and the
 *  default client of this framework simply does not start. A user hit exactly
 *  this and had to go find `deno task install:electron` themselves, which does
 *  not even address it.
 *
 *  So: when the helper is present but not setuid-root, we say so and start
 *  Electron with `--no-sandbox`. That is a real (small) reduction in isolation
 *  for a process that loads THIS APP'S OWN local UI, weighed against a
 *  framework whose default target cannot launch. It is announced every time,
 *  never silent, and `AIO_ELECTRON_SANDBOX=1` forces the strict behaviour for
 *  anyone who has configured the helper properly. */
export async function sandboxUsable(
  bin: string,
  stat: (p: string) => Promise<Deno.FileInfo> = Deno.stat,
  /** Injected in tests — see `usernsAvailable`. */
  userns: () => Promise<boolean> = usernsAvailable,
): Promise<boolean> {
  if (Deno.build.os !== "linux") return true; // only Linux has this helper
  if (Deno.env.get("AIO_ELECTRON_SANDBOX") === "1") return true;
  // With user namespaces available Chromium sandboxes through THEM and never
  // consults the helper, whatever its mode — that is every stock Debian,
  // Fedora, Arch and Ubuntu ≤ 23.04, and it is why this problem "historically
  // did not bite". `--no-sandbox` there would be a real loss of isolation for
  // nothing; the helper only decides once the namespace route is closed.
  if (await userns()) return true;
  // Beside the binary Chromium RUNS. In dev `bin` is `node_modules/.bin/
  // electron` — a Node shim — and the helper derived from it was
  // `node_modules/.bin/chrome-sandbox`, which does not exist. "No helper,
  // nothing to misconfigure" was the verdict, no `--no-sandbox` went out, and
  // on exactly the machines this check was written for (Ubuntu 24.04+,
  // containers) `deno task dev` opened no window: FATAL:setuid_sandbox_host
  // … SIGTRAP. The packaged binary, a real path, was handled all along.
  const helper = chromeSandboxPath(await realElectronBin(bin));
  try {
    const info = await stat(helper);
    // uid 0 AND the setuid bit — anything else and Chromium aborts.
    const setuid = ((info.mode ?? 0) & 0o4000) !== 0;
    return info.uid === 0 && setuid;
  } catch {
    // No helper at all: nothing to misconfigure, Chromium picks another
    // sandbox. Leave it alone.
    return true;
  }
}

/** The Chromium switches `AIO_ELECTRON_ARGS` may carry — an ALLOW-list, by
 *  switch name (everything left of the `=`).
 *
 *  This is the display, GPU, locale and logging vocabulary a headless host, a
 *  VM or a GPU-less display actually needs, and nothing else. Deny-listing
 *  Chromium is a game nobody wins: there are hundreds of switches and the set
 *  changes every release, so the one flag that matters is always the one
 *  nobody thought to forbid.
 *
 *  Every name here is inert with respect to the app's defences: it changes how
 *  pixels are produced, not who may reach the renderer, what code runs in it,
 *  or where its traffic goes. `tests/electron-args-env.test.ts` holds that as a
 *  property (no name may read like an escalation) and pins every switch the
 *  docs hand out to this set, so a documented remedy the code refuses is a red
 *  test rather than a person copying a line that does nothing. */
export const ELECTRON_ARGS_ALLOWED: ReadonlySet<string> = new Set([
  // GPU / rendering — the documented headless and VM remedies.
  "disable-gpu",
  "disable-gpu-compositing",
  "disable-software-rasterizer",
  "disable-accelerated-2d-canvas",
  "disable-accelerated-video-decode",
  "enable-unsafe-swiftshader",
  "use-gl",
  "use-angle",
  "force-device-scale-factor",
  "force-color-profile",
  "disable-lcd-text",
  "disable-smooth-scrolling",
  // Shared memory: most container images give /dev/shm 64 MB, and without
  // this the renderer dies with a bare "Out of memory" that names nothing.
  "disable-dev-shm-usage",
  // Which display server this window talks to.
  "ozone-platform",
  "ozone-platform-hint",
  // A window nobody is watching must not be throttled into looking hung.
  "disable-background-timer-throttling",
  "disable-backgrounding-occluded-windows",
  "disable-renderer-backgrounding",
  // Locale and diagnostics.
  "lang",
  "enable-logging",
  "log-level",
]);

/** Why a switch is refused, when the reason is worth more than "not in the
 *  set" — each of these is something an operator might reasonably reach for,
 *  and each has a supported route that is not this variable. Names only; the
 *  value is irrelevant to the verdict. */
const ELECTRON_ARGS_REFUSED: Record<string, string> = {
  "remote-debugging-port":
    "it opens an unauthenticated DevTools endpoint against this app's renderer — i.e. arbitrary JavaScript in the page. aio opens one deliberately with --cdp[=N] when you ask for it",
  "remote-debugging-pipe":
    "it opens the DevTools protocol on a pipe — i.e. arbitrary JavaScript in the page. aio opens one deliberately with --cdp[=N] when you ask for it",
  "remote-allow-origins":
    "it widens who may attach to the DevTools protocol; aio opens one deliberately with --cdp[=N] when you ask for it",
  "inspect": "it opens a debugger on the MAIN process; use --cdp[=N]",
  "inspect-brk": "it opens a debugger on the MAIN process; use --cdp[=N]",
  "disable-web-security":
    "it switches off the same-origin rules this app's page relies on",
  "allow-running-insecure-content":
    "it lets a page mix in content from another, insecure origin",
  "ignore-certificate-errors":
    "it trusts any certificate — the origin of everything this app fetches stops meaning anything",
  "unsafely-treat-insecure-origin-as-secure":
    "it grants an insecure origin the powers of a secure one",
  "allow-file-access-from-files":
    "it lets a file:// document read the local filesystem across origins",
  "js-flags":
    "it hands arbitrary V8 flags to the renderer, up to and including turning language-level protections off",
  "no-sandbox":
    "aio decides the Chromium sandbox itself, after measuring the kernel and the helper; electron: { requireSandbox: true } is the app's own control over it",
  "disable-setuid-sandbox":
    "aio decides the Chromium sandbox itself, after measuring the kernel and the helper; electron: { requireSandbox: true } is the app's own control over it",
  "disable-gpu-sandbox":
    "it removes the GPU process's sandbox; electron: { requireSandbox: true } is the app's control over sandbox policy",
  "single-process":
    "it collapses the renderer into the browser process, which is the sandbox",
  "no-zygote":
    "it disables the zygote the sandbox is built on; electron: { requireSandbox: true } is the app's control over sandbox policy",
  "disable-features":
    "it can switch off Chromium's own security mitigations by name (site isolation among them)",
  "enable-features":
    "it turns on unreviewed Chromium behaviour; the display switches you are probably after are --ozone-platform and --use-gl",
  "load-extension": "it loads someone else's code into this app",
  "disable-extensions-except": "it loads someone else's code into this app",
  "user-data-dir":
    "it moves this app's Chromium profile — the cookies, storage and cache aio keys to the app's own identity",
  "proxy-server": "it redirects this app's traffic through another host",
  "host-rules": "it redirects this app's traffic to another host",
  "host-resolver-rules": "it redirects this app's traffic to another host",
  "gpu-launcher": "it runs an arbitrary program as a child of this app",
  "renderer-cmd-prefix": "it runs an arbitrary program as a child of this app",
  "utility-cmd-prefix": "it runs an arbitrary program as a child of this app",
  "browser-subprocess-path":
    "it runs an arbitrary program in place of Chromium's own child processes",
};

/** Chromium switches from `AIO_ELECTRON_ARGS`, validated.
 *
 *  A headless or VM host sometimes needs one to start at all: a field report's
 *  console crash-looped on a GPU abort every ~90 s until the machine got
 *  `LIBGL_ALWAYS_SOFTWARE=1` (report 2 §7, §9.7), and the switch half of that
 *  vocabulary — `--disable-gpu`, `--disable-dev-shm-usage` — had no way in at
 *  all. Environment variables already reach Electron (the spawn merges the
 *  inherited environment); switches did not.
 *
 *  VALIDATED, not passed through, and against TWO questions now. The first was
 *  always here: this ends up in `argv`, never in a shell, so a token that is
 *  not a `--switch` is a typo Chromium ignores in silence, on the one host
 *  where the person cannot see the window to tell — refused with the value
 *  quoted back, because "I set the flag and nothing changed" is the failure
 *  this variable exists to end.
 *
 *  The second is the one an audit (§7) found missing. These switches are
 *  appended LAST, so they override aio's own, and the variable took anything
 *  shaped like a switch: whoever controls the launch environment — a .desktop
 *  file, a shell profile, a wrapper script — could add
 *  `--remote-debugging-port=9222` and hold unauthenticated CDP against a
 *  renderer full of the app's secrets. So the set is an ALLOW-list
 *  ({@linkcode ELECTRON_ARGS_ALLOWED}), in dev and in prod alike: one
 *  behaviour, because a variable that works on a developer's machine and is
 *  ignored in the shipped app is the divergence class this project refuses.
 *  A switch outside the set is refused with a reason, and the ones an operator
 *  might reasonably reach for name their supported route instead.
 *
 *  Splitting is on whitespace, so a switch whose value contains a space is not
 *  expressible here. That is a deliberate floor: the alternative is a quoting
 *  grammar of our own, and every switch in the documented sets is a bare flag
 *  or a simple `--key=value`. */
/** Does this token carry a C0 control character or DEL? Written with char
 *  codes rather than a regex literal: the class is unreadable as an escape and
 *  invisible as a literal, and one of those two is what ends up in the file. */
function hasControlChar(tok: string): boolean {
  for (const ch of tok) {
    const c = ch.charCodeAt(0);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** Environment variables that turn the app's own Electron into something
 *  else, and the sentence said when one is present.
 *
 *  `AIO_ELECTRON_ARGS` is an allow-list because the environment is not a
 *  trusted input — a `.desktop` file, a shell profile or a wrapper script
 *  decides it, not the app. Screening that variable while INHERITING these is
 *  the same door, wider: measured against the shipped runtime,
 *  `ELECTRON_RUN_AS_NODE=1` makes the binary report `v24.21.0` and run plain
 *  Node instead of the app, and `NODE_OPTIONS=--require=…` then loads any
 *  file into it.
 *
 *  Dropping them is a PARTIAL mitigation and says so: whoever writes the
 *  environment usually also writes `PATH` and `LD_PRELOAD`, which nothing
 *  here can take away. It is kept anyway because the inconsistency is the
 *  indefensible part — an allow-list beside an open door reads as protection
 *  that is not there. Only these keys are removed; the rest of the
 *  environment is inherited exactly as before, so no app loses a variable it
 *  set on purpose. */
export const ELECTRON_ENV_REFUSED: Readonly<Record<string, string>> = {
  ELECTRON_RUN_AS_NODE:
    "it makes the Electron binary run as plain Node — the app's window never " +
    "opens and its main script is replaced by whatever is passed instead",
  NODE_OPTIONS:
    "it injects flags (--require=<file>, --inspect) into the runtime before " +
    "the app's own code runs",
};

/** The child's environment overrides: the parent-pid watch, plus an empty
 *  value for each hijacking variable that is actually SET. `Deno.Command`'s
 *  `env` merges into the inherited environment, so an empty string is how a
 *  key is taken away there; Electron and Node both treat unset and empty
 *  alike for these two. Pure — the caller passes what it read. */
export function electronChildEnv(
  parentPid: number,
  read: (k: string) => string | undefined,
): { env: Record<string, string>; dropped: { key: string; why: string }[] } {
  const env: Record<string, string> = { AIO_PARENT_PID: String(parentPid) };
  const dropped: { key: string; why: string }[] = [];
  for (const [key, why] of Object.entries(ELECTRON_ENV_REFUSED)) {
    if (!read(key)) continue;
    env[key] = "";
    dropped.push({ key, why });
  }
  return { env, dropped };
}

export function electronArgsFromEnv(
  raw: string | undefined,
): { args: string[]; refused: { tok: string; why: string }[] } {
  const args: string[] = [];
  const refused: { tok: string; why: string }[] = [];
  for (const tok of (raw ?? "").split(/\s+/).filter(Boolean)) {
    // A control character in the VALUE, before anything else is asked about
    // it. The allow-list screens the NAME, and the value was `[^\s]*`, which
    // takes every control byte there is — NUL included. Measured: an argv
    // entry with a NUL makes `Deno.Command` throw `nul byte found in provided
    // data` out of `spawnElectron`, so the window never opens and the message
    // names neither this variable nor the token; and everything after the NUL
    // is a string Chromium is never going to see. Refuse it here, by name,
    // which is the whole reason this function exists.
    if (hasControlChar(tok)) {
      refused.push({
        tok,
        why:
          "it carries a control character — an argv entry with one cannot be " +
          "spawned at all (a NUL ends the string the kernel copies), so " +
          "whatever follows it would reach nothing",
      });
      continue;
    }
    if (!/^--[A-Za-z0-9][A-Za-z0-9-]*(=[^\s]*)?$/.test(tok)) {
      refused.push({
        tok,
        why:
          "not a Chromium switch — one looks like --disable-gpu or --key=value",
      });
      continue;
    }
    const name = tok.slice(2).split("=")[0]!;
    if (ELECTRON_ARGS_ALLOWED.has(name)) {
      args.push(tok);
      continue;
    }
    // `hasOwn`, not a bare lookup: `REFUSED[name]` also answers for every key
    // on `Object.prototype`, so `--toString` was refused (correctly) and then
    // explained by V8 — "function toString() { [native code] } (…)". A reason
    // nobody wrote is a reason nobody can act on.
    const why = Object.hasOwn(ELECTRON_ARGS_REFUSED, name)
      ? ELECTRON_ARGS_REFUSED[name]
      : undefined;
    refused.push({
      tok,
      why: why
        ? `${why} (AIO_ELECTRON_ARGS carries display and GPU switches only — docs/clients/electron.md)`
        : "not one of the switches AIO_ELECTRON_ARGS carries — it is the display, GPU, locale and logging set a headless or VM host needs, listed in docs/clients/electron.md",
    });
  }
  return { args, refused };
}

// THE no-console rule lives in the server runtime (the update relaunch needs
// it too); re-exported so existing importers keep one name.
export { isInvalidHandleError } from "../server/no-console.ts";

/** The app refused this launch itself — `electron: { requireSandbox: true }`
 *  on a host where Chromium's sandbox is not usable.
 *
 *  A TYPE rather than a message anyone has to recognise, because the caller
 *  has to tell it apart from every other reason a window does not open (no
 *  Electron, a bad binary, no display). Those leave the server running and say
 *  where it is; this one is the app saying it would rather not run at all, and
 *  answering it with "open it in a browser instead" is the same downgrade one
 *  step later. See `electronLaunchFailurePlan` in aio-lifecycle.ts. */
export class SandboxRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxRefusal";
  }
}

/** THE decision about Chromium's sandbox for this launch: the switches to add,
 *  and what to say about them — or a throw, when the app refused the downgrade.
 *
 *  aio adds `--no-sandbox` by itself, and only after MEASURING that the kernel
 *  restricts unprivileged user namespaces and that `chrome-sandbox` is not
 *  setuid-root — the two conditions under which Chromium aborts rather than
 *  starts. That default stands: the alternative is a framework whose default
 *  target does not launch on Ubuntu 24.04 or in any container.
 *
 *  What it was missing is the app's side of it. It was log-only, and an audit
 *  (§6) named the shape: a security downgrade the app cannot refuse. An app
 *  that holds secrets says `electron: { requireSandbox: true }` and this
 *  REFUSES the launch instead — with the two lines that make the sandbox usable
 *  here, because a refusal that does not say how to satisfy it is a wall.
 *
 *  The measurement is injected (as in `sandboxUsable`/`usernsAvailable`), so
 *  the decision table is a unit test rather than a fleet of VMs. */
export async function sandboxSwitches(
  bin: string,
  requireSandbox: boolean,
  usable: (b: string) => Promise<boolean> = sandboxUsable,
  realBin: (b: string) => Promise<string> = realElectronBin,
): Promise<{ args: string[]; warn?: string }> {
  if (await usable(bin)) return { args: [] };
  // Name the helper that IS there — through the dev shim that is
  // `<pkg>/dist/chrome-sandbox`, not a file beside `.bin/electron`.
  const helper = chromeSandboxPath(await realBin(bin));
  const measured =
    "this kernel restricts unprivileged user namespaces (measured: the " +
    "sysctls / a clone(CLONE_NEWUSER) probe), and chrome-sandbox is not " +
    "setuid-root (an npm install cannot make it so) — Chromium would abort " +
    "instead of starting";
  const remedy = "To use the sandbox instead:\n" +
    `      sudo chown root:root ${helper} && sudo chmod 4755 ${helper}\n` +
    "      then set AIO_ELECTRON_SANDBOX=1";
  if (requireSandbox) {
    throw new SandboxRefusal(
      `electron: { requireSandbox: true } — and the sandbox is not usable ` +
        `here. ${measured}, and aio would normally launch it with ` +
        `--no-sandbox. This app asked not to run that way, so no window is ` +
        `opened. ${remedy}\n      …or drop requireSandbox to accept ` +
        `--no-sandbox on hosts like this one.`,
    );
  }
  return {
    args: ["--no-sandbox"],
    warn: `[aio] electron: ${measured}. Launching with --no-sandbox. ` +
      `${remedy}\n      Set electron: { requireSandbox: true } to refuse ` +
      `the launch instead of running unsandboxed.`,
  };
}

/** The first line of every main script this module writes: the script
 *  removes its own file as soon as Electron has loaded it.
 *
 *  The file is needed for the instant between its write and that load, and
 *  it used to stay for the whole run, removed by THIS process when the window
 *  exited — so a run that was SIGKILLed (the OOM killer, a crash, a forced
 *  stop) left ~120 KB in the temp directory for good, one more per crash,
 *  each holding the app's launch URL. Nothing can sweep them safely from
 *  outside: the names are random, in a directory shared with everything else
 *  on the machine. Removed from the inside there is nothing left to sweep —
 *  and no file of another app or another running instance is ever looked at.
 *  The removals below (window exit, unload) stay for a window that never got
 *  as far as running its script. */
export const MAIN_SCRIPT_SELF_REMOVE =
  "try { require('fs').unlinkSync(__filename); } catch {}\n";

/** The working directory of an installed app's window: `neutral`
 *  (`neutralCwd()`), and the inherited one for a run from source.
 *
 *  Windows cannot move a folder that is some process's working directory, and
 *  an installed app's is its install folder. The window inherited it — and so
 *  did every program the window opened (a browser for an external link, the
 *  viewer of a file): one of those left open made the next update fail with
 *  "the running version could not be moved aside". The main script never
 *  reads its own working directory; it is told the app's (AIO_APP_CWD).
 *  A source run keeps its directory: nothing is installed there to move.
 *  Pure. */
export function packagedCwd(
  neutral: string | undefined,
  compiled: boolean = isCompiled(),
): string | undefined {
  return compiled ? neutral : undefined;
}

/** Electron's `userData` directory for a window whose `app.name` is
 *  `profile` — where the window keeps its own files (`aio-preload/`, the
 *  window state) — or null where the platform's base directory is not known
 *  from the environment. Mirrors Electron's rule: `$XDG_CONFIG_HOME` or
 *  `~/.config` on Linux, `~/Library/Application Support` on macOS, `%APPDATA%`
 *  on Windows. Pure. */
export function electronProfileDir(
  profile: string,
  os: string = Deno.build.os,
  env: (k: string) => string | undefined = (k) => Deno.env.get(k),
): string | null {
  const base = os === "windows"
    ? env("APPDATA")
    : os === "darwin"
    ? env("HOME") && join(env("HOME")!, "Library", "Application Support")
    : env("XDG_CONFIG_HOME") || (env("HOME") && join(env("HOME")!, ".config"));
  return base ? join(base, profile) : null;
}

/** The directory, inside the window's profile, its main script is written to. */
export const MAIN_SCRIPT_DIR = "aio-main";

/** Write the generated main script where Electron will load it from, and
 *  answer its path.
 *
 *  The script removes its own file as soon as it is loaded
 *  ({@linkcode MAIN_SCRIPT_SELF_REMOVE}) and the launcher removes it when the
 *  window exits — but a run whose server AND window are both SIGKILLed before
 *  Electron has loaded it leaves the file (measured: 2 in 60 random kills),
 *  and it carries the launch URL. In the temp directory under a random name
 *  nothing ever came back for it. So it lives in the window's own profile, in
 *  `aio-main/` (0700), as `<pid>-<random>.cjs` (0600) — the pid is the
 *  launcher's — and every launch first removes the files there whose process
 *  is gone: the same home and the same rule as the preload.
 *
 *  Where the profile directory is not known or cannot be written (no HOME /
 *  APPDATA, a read-only home), the temp directory is used as before, and that
 *  is said: there the residual stands. */
export async function writeMainScript(
  profile: string | undefined,
  text: string,
): Promise<string> {
  const dir = profile ? electronProfileDir(profile) : null;
  // Twice: another launch on this profile may prune the directory (below)
  // between this one's mkdir and its write.
  for (let attempt = 0; dir !== null && attempt < 2; attempt++) {
    try {
      const home = join(dir, MAIN_SCRIPT_DIR);
      await Deno.mkdir(home, { recursive: true, mode: 0o700 });
      for await (const e of Deno.readDir(home)) {
        const pid = Number(e.name.split("-")[0]);
        if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) continue;
        await Deno.remove(join(home, e.name), { recursive: true });
      }
      const file = join(
        home,
        `${Deno.pid}-${crypto.randomUUID().slice(0, 8)}.cjs`,
      );
      await Deno.writeTextFile(file, text, { mode: 0o600, createNew: true });
      return file;
    } catch (e) {
      if (attempt === 0 && e instanceof Deno.errors.NotFound) continue;
      log.warn(
        "electron",
        `the window's main script could not be written into the app's ` +
          `profile (${dir}) — ${e}. Using the temp directory instead; a run ` +
          `killed before Electron has loaded it leaves that file behind.`,
      );
      break;
    }
  }
  const tmpFile = await Deno.makeTempFile({ suffix: ".cjs" });
  await Deno.writeTextFile(tmpFile, text);
  return tmpFile;
}

/** Writes the main script, spawns Electron, cleans up after exit or process unload */
async function spawnElectron(
  launcher: string,
  script: string,
  extraArgs: string[] = [],
  opts: {
    requireSandbox?: boolean;
    /** The window's `app.name` — where its main script is written. */
    profile?: string;
  } = {},
): Promise<Deno.ChildProcess> {
  // Spawn ELECTRON, not the thing that spawns it. `node_modules/.bin/electron`
  // is npm's shim — a `node` process whose CHILD is the window — so the pid
  // this returns was the shim's: a signal sent to it went to node, and the
  // production local-peer gate, armed with it, refused the app's own window
  // forever (a blank window on every `--prod` run from source). The shim adds
  // nothing aio needs; the binary it would start is started directly. A real
  // binary ($ELECTRON_PATH, a packaged or fetched runtime) is returned as is.
  const bin = await realElectronBin(launcher);
  // DECIDED BEFORE the temp file exists: a refusal must not leave the script
  // it would have run behind in /tmp.
  const sandbox = await sandboxSwitches(bin, !!opts.requireSandbox);
  if (sandbox.warn) log.warn(sandbox.warn);
  const sandboxArgs = sandbox.args;
  const tmpFile = await writeMainScript(
    opts.profile,
    MAIN_SCRIPT_SELF_REMOVE + script,
  );
  // The caller's switches go LAST: Chromium takes the last occurrence of a
  // repeated switch, so an operator who has to override one of aio's own can.
  const envArgs = electronArgsFromEnv(Deno.env.get("AIO_ELECTRON_ARGS"));
  if (envArgs.refused.length) {
    const n = envArgs.refused.length;
    log.warn(
      `[aio] electron: AIO_ELECTRON_ARGS — ${n} ` +
        `entr${n === 1 ? "y was" : "ies were"} NOT passed to Chromium:\n` +
        envArgs.refused
          .map((r) => `      ${JSON.stringify(r.tok)}: ${r.why}`)
          .join("\n"),
    );
  }
  // The environment is not a trusted input either — the same reason
  // AIO_ELECTRON_ARGS is an allow-list. Screening that one while inheriting
  // ELECTRON_RUN_AS_NODE is the same door, wider.
  const childEnv = electronChildEnv(Deno.pid, (k) => Deno.env.get(k));
  for (const d of childEnv.dropped) {
    log.warn(
      "electron",
      `${d.key} was set and has been REMOVED for this window — ${d.why}. ` +
        `(Partial: an environment you do not control can also set PATH or ` +
        `LD_PRELOAD, which nothing here can take away.)`,
    );
  }
  // stdout is inherited so the app's own console output passes through
  // untouched — EXCEPT when this process has no console to inherit from. A
  // `--no-terminal` GUI exe opened by double-click gives `inherit` no valid
  // handle and `spawn()` throws `Invalid handle`; retry with the std handles
  // discarded. stderr is PIPED either way, so the graphics-stack probe noise is
  // still kept out of the app's own log (see forwardStderr).
  const command = (stdio: "inherit" | "null") =>
    new Deno.Command(bin, {
      args: [tmpFile, ...sandboxArgs, ...extraArgs, ...envArgs.args],
      // The window dies with this process — see tmplParentWatch. Merged into
      // the inherited environment, so the shim passes it through to Electron.
      // AIO_APP_CWD: the app's working directory, for the main script — the
      // window's own may be another one (`packagedCwd`).
      env: { ...childEnv.env, AIO_APP_CWD: Deno.cwd() },
      cwd: packagedCwd(neutralCwd()),
      ...(stdio === "inherit"
        ? { stdout: "inherit" as const }
        : { stdin: "null" as const, stdout: "null" as const }),
      stderr: "piped",
    });
  // SYNC on purpose: an `unload` listener cannot await, so an async remove
  // there never finished — the file outlived the process it belonged to.
  const cleanup = () => {
    try {
      Deno.removeSync(tmpFile);
    } catch {
      // aio-ok: the other path (exit / unload) already removed it
    }
    // …and the directories made for it, when nothing else is in them: a
    // window that never ran (no Electron, a stub in a test) must not leave an
    // empty profile behind. A real profile is not empty and stays.
    if (basename(dirname(tmpFile)) === MAIN_SCRIPT_DIR) {
      for (const d of [dirname(tmpFile), dirname(dirname(tmpFile))]) {
        try {
          Deno.removeSync(d);
        } catch {
          break; // aio-ok: not empty (in use) or already gone — both fine
        }
      }
    }
  };
  // Backup cleanup: covers SIGKILL / host process crash where proc.status
  // never resolves. Registered BEFORE the spawn: a spawn that throws (a
  // binary that cannot be executed) must not leave the script — the launch
  // URL is in it — behind.
  addEventListener("unload", cleanup);
  let proc: Deno.ChildProcess;
  try {
    proc = spawnInheritingOrNull(command);
  } catch (e) {
    cleanup();
    removeEventListener("unload", cleanup);
    throw e;
  }
  forwardStderr(proc);
  // Primary cleanup: after Electron exits normally
  proc.status.then(cleanup);
  proc.status.then(() => removeEventListener("unload", cleanup));
  return proc;
}

/** The Chromium switch that opens the DevTools Protocol — or nothing.
 *
 *  Pure, and the ONLY place the switch is spelled: `--cdp` is opt-in, so an
 *  app that did not ask must launch with an argv identical to before (a bound
 *  debugging port is a port, and "zero ports" is a promise). Chromium binds
 *  `--remote-debugging-port` to 127.0.0.1 only. */
export function cdpSwitches(port: number | undefined): string[] {
  return port ? [`--remote-debugging-port=${port}`] : [];
}

/** WHICH rung of {@linkcode findElectronBin} the binary came from — what the
 *  "launching Electron (…)" line names.
 *
 *  Decided from what was actually consulted, never from how the path looks.
 *  It used to be read off the path — "has `dist` in it" meant packaged, and
 *  whatever matched nothing was called `$ELECTRON_PATH` — so a macOS bundle
 *  and a double-clicked Windows exe, which set no such variable and run the
 *  runtime they ship, logged `$ELECTRON_PATH`; and any runtime under a
 *  directory that happened to be called `dist` logged "packaged". Pure. */
export function electronSource(
  bin: string,
  envPath: string | undefined,
  packaged: readonly string[],
): "$ELECTRON_PATH" | "packaged" | "dev" | "cache" {
  if (envPath && bin === envPath) return "$ELECTRON_PATH";
  if (packaged.includes(bin)) return "packaged";
  if (electronShimRoot(bin) !== null) return "dev";
  return "cache";
}

/** Spawns Electron with the main app script */
export async function launchElectron(
  url: string,
  log: Log,
  meta?: AioMeta,
  /** THE declaration for what reaches the generated main script. Read it as
   *  the one list: the call below is a mechanical passthrough (`...rest`), so
   *  a key added here is wired by the fact of being declared.
   *
   *  It used to be a hand-copied literal, and this is the same shape the
   *  config bridge documents dropping keys six times over
   *  (`TransportConfig`, aio-server.ts). It did it again here: the socket that
   *  lets a zero-port app serve its own page was declared, threaded through
   *  four files, and then quietly not copied into this object — so the window
   *  fell back to `http://localhost:<port>` and opened on
   *  ERR_CONNECTION_REFUSED, with nothing in the chain wrong except a missing
   *  line in a literal. */
  uds?: {
    socketPath: string;
    baseDir?: string;
    title?: string;
    hasCSS?: boolean;
    /** Dev icon dir — the server's resolved baseDir (WYSIDIWYSIP). */
    iconDir?: string;
    /** Base64 PNG used when the app ships no `icon.png`. */
    defaultIcon?: string;
    shell?: ShellConfig;
    /** The app's HTTP handler on a socket — set when it binds no TCP port. */
    httpSocketPath?: string;
    /** `AIO_ELECTRON_PROTOCOL=1`: dev window over aio:// (test what you ship). */
    forceProtocol?: boolean;
  },
  /** The dist/ carrying the baked Electron version (compiled binaries). */
  distDir?: string,
  /** `--cdp`: open the DevTools Protocol on this loopback port (`am shot`). */
  cdpPort?: number,
  /** Aborted when the app starts shutting down. The lookup can take minutes
   *  (a first-run install), and a stop that lands meanwhile must not be
   *  followed by a window: once aborted this returns null and spawns nothing. */
  signal?: AbortSignal,
): Promise<Deno.ChildProcess | null> {
  if (signal?.aborted) return null;
  const bin = await findElectronBin(log, { distDir, signal });
  if (!bin || signal?.aborted) return null;
  // The cache holds both a downloaded runtime and one unpacked from the exe
  // itself (under a `-fused` name); whether this binary CARRIES one is the
  // decider, not the path.
  const source = electronSource(
    bin,
    Deno.env.get("ELECTRON_PATH"),
    packagedElectronCandidates(),
  );
  const mode = source !== "cache"
    ? source
    : await bakedEmbeddedRuntime(distDir).catch(() => null)
    ? "runtime carried by this app"
    : "fetched runtime";
  const transport = uds ? "UDS" : "WS";
  log.info(
    `launching Electron (${mode}, ${transport}${
      cdpPort ? `, cdp 127.0.0.1:${cdpPort}` : ""
    })`,
  );
  // `childWindows` is served by the UDS shell's PRELOAD (`__aioIPC.openWindow`,
  // and the `<webview>` gate that rides with it). The WebSocket shell — taken
  // whenever the app has a TCP port (`--expose`, `--port=N`, `transport:
  // "ws"`) — has no preload, so `__aioIPC` is simply not there and the app's
  // own `openWindow` call dies in the renderer as `undefined is not an
  // object`, a long way from the config that caused it. Say it here, where the
  // decision is actually made.
  if (!uds && meta?.childWindows) {
    log.error(
      "childWindows: true, but this window is on the WebSocket transport " +
        "(this app has a TCP port), where the IPC preload that provides " +
        "`__aioIPC.openWindow` is not installed — openWindow and <webview> " +
        "will not work. Drop --expose/--port so the local window uses its " +
        'own socket, or set transport: "uds".',
    );
  }
  // Mechanical passthrough — `socketPath` is positional, everything else the
  // caller declared rides across untouched. Never re-list the keys here.
  const { socketPath: _sock, ...udsOpts } = uds ?? { socketPath: "" };
  const script = uds
    ? electronMainScriptUDS(url, uds.socketPath, { ...udsOpts, meta })
    : electronMainScript(url, meta);
  // `requireSandbox` rides on the meta this window was described by — the app
  // said it, and this is where the app's window is actually launched.
  return spawnElectron(bin, script, cdpSwitches(cdpPort), {
    requireSandbox: meta?.requireSandbox,
    profile: shellProfileName(meta, uds?.title),
  });
}

/** Launches Electron with the client connect-page script (no server needed) */
export async function launchElectronClient(
  log: Log,
  url?: string,
): Promise<Deno.ChildProcess | null> {
  const bin = await findElectronBin(log);
  if (!bin) return null;
  const args = url ? [`--server-url=${url}`] : [];
  // argv carries the URL as given (it is the user's own input, and the client
  // needs it); the LOG line does not carry its token.
  log.info(`launching aio client${url ? ` → ${redactUrlToken(url)}` : ""}`);
  return spawnElectron(bin, electronClientScript(), args, {
    profile: CLIENT_PROFILE,
  });
}
