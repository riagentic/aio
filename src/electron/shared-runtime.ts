/**
 * @module
 * The SHARED Electron runtime: `"build": { "electronRuntime": "online" }`.
 *
 * A bundled desktop app carries its own ~250 MB Electron. A shared-runtime app
 * carries none: on start it looks in ONE per-user store for the Electron its
 * build pinned, and when that version is not there yet it downloads it (with
 * a progress window — runtime-dialog.ts) before the window opens. Every
 * shared-runtime app on the machine that pins the same Electron starts from
 * the same copy, so the download and the update are the app alone.
 *
 * The store is application DATA, not a cache — an app cannot start without
 * it — so it lives where each OS keeps per-user app data, never under
 * `~/.cache` (which cleaners empty) or a dot-folder in the home directory:
 *
 *   Linux    $XDG_DATA_HOME/aio/electron     (~/.local/share/aio/electron)
 *   macOS    ~/Library/Application Support/aio/electron
 *   Windows  %LOCALAPPDATA%\aio\electron     (Local: never roams 250 MB)
 *
 * `$AIO_SHARED_ELECTRON_DIR` overrides it (tests, a managed machine).
 *
 *   <root>/<version>-<slug>/        one runtime, fused like a bundled one
 *   <root>/apps/<key>.json          which installed app needs which runtime
 *   <root>/windows/<bundle id>/     macOS only: each app's window bundle
 *
 * The `apps/` records are what makes deleting a runtime safe: `am prune`
 * keeps every runtime an installed app still names, whatever its age.
 *
 * Why macOS needs a window bundle: a signed `.app` cannot hold a link out of
 * itself (`codesign --verify --strict`: "invalid destination for symbolic
 * link in bundle", measured on macOS 14), and the window takes its name and
 * Dock icon from the bundle it is started from. So each app gets its own
 * bundle in the store: a clone of the shared `Electron.app` (APFS clones
 * cost no disk space) stamped with the app's identity — the same stamp a
 * bundled build puts on its nested runtime — and signed ad hoc on the Mac.
 */
import { neutralCwd } from "../server/no-console.ts";
import { renameOver } from "../diagnostics/rename-over.ts";
import { basename, dirname, join, resolve } from "@std/path";
import { homedir } from "../server/paths.ts";
import {
  DownloadError,
  electronBinIn,
  electronOsFromSlug,
  ensureElectronRuntime,
  renameWithRetry,
  runtimeUsable,
  sha256Hex,
  touchRuntimeUse,
} from "./electron-runtime-fetch.ts";
import {
  stampElectronIdentity,
  stripElectronBranding,
} from "./mac-identity.ts";
import {
  type DialogBackend,
  dialogBackend,
  downloadDetail,
  type ProgressDialog,
} from "./runtime-dialog.ts";

/** Beside the launcher of a shared-runtime package (the Windows folder, the
 *  AppImage's AppDir): what says "an Electron install" where a bundled one
 *  has its `electron/` folder — the updater's `installDir` reads it. */
export const SHARED_RUNTIME_MARKER = "electron-shared.json";

/** Exported by a shared-runtime AppImage's AppRun, standing in for the
 *  `ELECTRON_PATH` a bundled one exports (the updater's `classifyTarget`). */
export const SHARED_RUNTIME_ENV = "AIO_ELECTRON_RUNTIME";

/** The env var that moves the store. */
export const SHARED_ELECTRON_DIR_ENV = "AIO_SHARED_ELECTRON_DIR";

/** Where the store is. Pure over its inputs. */
export function sharedElectronRoot(
  opts: {
    os?: string;
    env?: (k: string) => string | undefined;
    home?: () => string;
  } = {},
): string {
  const env = opts.env ?? ((k: string) => Deno.env.get(k));
  const os = opts.os ?? Deno.build.os;
  const home = opts.home ?? homedir;
  // Absolute, always: a relative store would move with the working directory
  // (and `codesign` reads an argument that starts with digits as a pid).
  const override = env(SHARED_ELECTRON_DIR_ENV);
  if (override) return resolve(override);
  const nonEmpty = (v: string | undefined) => v && v.length > 0 ? v : null;
  if (os === "windows") {
    return join(
      nonEmpty(env("LOCALAPPDATA")) ?? join(home(), "AppData", "Local"),
      "aio",
      "electron",
    );
  }
  if (os === "darwin") {
    return join(home(), "Library", "Application Support", "aio", "electron");
  }
  return join(
    nonEmpty(env("XDG_DATA_HOME")) ?? join(home(), ".local", "share"),
    "aio",
    "electron",
  );
}

/** One runtime's directory in the store. Pure. */
export function sharedElectronDir(
  version: string,
  slug: string,
  root: string = sharedElectronRoot(),
): string {
  const v = version.startsWith("v") ? version.slice(1) : version;
  return join(root, `${v}-${slug}`);
}

/** Is this runtime already in the store, complete? */
export function sharedElectronReady(
  version: string,
  slug: string,
  root?: string,
): Promise<boolean> {
  return runtimeUsable(sharedElectronDir(version, slug, root), slug);
}

/** Put a runtime in the store (download, verify, unpack, fuse), or find it
 *  there. The cache's installer, pointed at the store: one lock, one
 *  integrity check, one rename into place. */
export async function ensureSharedElectron(
  version: string,
  slug: string,
  opts: {
    log?: (msg: string) => void;
    warn?: (msg: string) => void;
    onBytes?: (got: number, total: number) => void;
    fetch?: typeof fetch;
    root?: string;
    signal?: AbortSignal;
    /** macOS tools (tests). */
    run?: RunTool;
    /** The zip's SHA-256 as the app's build pinned it. */
    sha256?: string;
  } = {},
): Promise<string> {
  const dir = sharedElectronDir(version, slug, opts.root);
  if (await runtimeUsable(dir, slug)) {
    await touchRuntimeUse(dir);
    return dir;
  }
  const run = opts.run ?? runTool;
  return await ensureElectronRuntime(version, slug, {
    log: opts.log,
    warn: opts.warn,
    fetch: opts.fetch,
    onBytes: opts.onBytes,
    signal: opts.signal,
    sha256: opts.sha256,
    into: dir,
    // macOS: the fuses changed the framework, so the runtime is signed again,
    // ad hoc, ONCE, here — each app's window bundle then re-signs only its
    // own small parts and shares the 180 MB framework's blocks with this copy
    // (a re-signed file is a new file, which no clone can share).
    finish: electronOsFromSlug(slug) === "darwin" && Deno.build.os === "darwin"
      ? async (stage) => {
        const signed = await run("/usr/bin/codesign", [
          "--force",
          "--deep",
          "--sign",
          "-",
          join(stage, "Electron.app"),
        ]);
        if (!signed.ok) {
          throw new Error(
            `could not sign the Electron runtime (codesign: ` +
              `${signed.stderr.trim().split("\n").at(-1)})`,
          );
        }
      }
      : undefined,
  });
}

/** What an installed app records about the runtime it starts from. */
export type SharedUse = {
  /** The installed app's executable — the record is stale once it is gone. */
  exe: string;
  version: string;
  slug: string;
  /** macOS: the app's window bundle folder in the store (`windows/<id>`). */
  window?: string;
  /** Written by an update before its swap: the app does not start from it
   *  YET. A start of that version rewrites it without the flag. */
  pending?: true;
  /** ISO time of the last start (or update) that wrote it. */
  at: string;
};

/** The record's file-name prefix: one per installed executable. Pure. */
export async function sharedUseKey(exe: string): Promise<string> {
  const hex = await sha256Hex(new TextEncoder().encode(exe));
  return hex.slice(0, 16);
}

/** How many runtimes one installed app keeps protected by its STARTS: the
 *  one it starts from and the one before it (a rollback starts that again).
 *  Plus, apart from these, the newest an update fetched before its swap
 *  (`pending`) — so updates that never swapped can never push out the
 *  runtime the installed version still starts from. */
export const USES_PER_APP = 2;

/** Note that the app at `exe` starts from `version`/`slug`. One record per
 *  (app, Electron version), written on every start and by an update before
 *  its swap; the {@linkcode USES_PER_APP} newest of an app are kept. Never
 *  fatal: a store that cannot take the note still runs the app — the record
 *  only protects the runtime from `am prune`. */
export async function recordSharedUse(
  use: Omit<SharedUse, "at">,
  opts: { root?: string; warn?: (m: string) => void } = {},
): Promise<void> {
  const dir = join(opts.root ?? sharedElectronRoot(), "apps");
  const key = await sharedUseKey(use.exe);
  const v = use.version.replace(/^v/, "").replace(/[^0-9A-Za-z._-]/g, "_");
  const file = join(dir, `${key}-${v}.json`);
  const rec: SharedUse = { ...use, at: new Date().toISOString() };
  try {
    await Deno.mkdir(dir, { recursive: true });
    // An update's note never demotes a version this app already starts from.
    if (use.pending) {
      const was = await Deno.readTextFile(file).then(
        (t) => JSON.parse(t) as Partial<SharedUse>,
        () => null,
      );
      if (was && !was.pending) return;
    }
    const tmp = `${file}.${Deno.pid}.tmp`;
    await Deno.writeTextFile(tmp, JSON.stringify(rec) + "\n");
    await renameOver(tmp, file);
    // This app's started records past the newest USES_PER_APP, and every
    // pending one but the newest: what they named is no longer started by
    // it, nor its rollback, nor its next update.
    const mine: Array<{ file: string; at: string; pending: boolean }> = [];
    for await (const e of Deno.readDir(dir)) {
      if (!e.isFile || !e.name.startsWith(`${key}-`)) continue;
      if (!e.name.endsWith(".json")) continue;
      const f = join(dir, e.name);
      const got = await Deno.readTextFile(f).then(
        (t) => JSON.parse(t) as Partial<SharedUse>,
        () => null,
      );
      // Unreadable: kept, and `am prune` shows it.
      if (got) {
        mine.push({
          file: f,
          at: String(got.at ?? ""),
          pending: !!got.pending,
        });
      }
    }
    mine.sort((a, b) => b.at.localeCompare(a.at));
    const stale = [
      ...mine.filter((m) => !m.pending).slice(USES_PER_APP),
      ...mine.filter((m) => m.pending).slice(1),
    ];
    for (const old of stale) {
      await Deno.remove(old.file).catch((e) => {
        // Another start of this app trimmed it first.
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      });
    }
  } catch (e) {
    opts.warn?.(
      `could not record that this app uses Electron ${use.version} in ` +
        `${dir} (${e instanceof Error ? e.message : e}) — \`am prune\` may ` +
        `then offer to delete it`,
    );
  }
}

/** Every record in the store, each with whether its app is still installed.
 *  A record that does not parse is reported as such, never dropped silently:
 *  it is shown by `am prune`, which keeps what it cannot read. */
export async function readSharedUses(
  root: string = sharedElectronRoot(),
): Promise<Array<{ file: string; use: SharedUse | null; live: boolean }>> {
  const dir = join(root, "apps");
  const out: Array<{ file: string; use: SharedUse | null; live: boolean }> = [];
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(dir));
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return out;
    throw e;
  }
  for (const e of entries) {
    if (!e.isFile || !e.name.endsWith(".json")) continue;
    const file = join(dir, e.name);
    let use: SharedUse | null = null;
    try {
      const v = JSON.parse(await Deno.readTextFile(file));
      if (
        typeof v?.exe === "string" && typeof v.version === "string" &&
        typeof v.slug === "string" &&
        (v.window === undefined || typeof v.window === "string")
      ) use = v as SharedUse;
    } catch {
      use = null; // aio-ok: reported below as unreadable, kept by prune
    }
    let live = use === null; // unreadable: assume it is needed
    if (use) {
      live = await Deno.stat(use.exe).then(() => true, () => false);
    }
    out.push({ file, use, live });
  }
  return out;
}

// ── macOS: the app's window bundle ─────────────────────────────────────────

/** A top-level string value of an XML plist, or null. Pure. */
export function plistString(plist: string, key: string): string | null {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`<key>\\s*${esc}\\s*</key>\\s*<string>([^<]*)</string>`)
    .exec(plist);
  if (!m) return null;
  return m[1]!
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"').replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

/** The installed `.app` a compiled binary runs from — `<x>.app` when the
 *  executable is `<x>.app/Contents/MacOS/<bin>` — or null. Pure. */
export function enclosingMacApp(execPath: string): string | null {
  const macos = dirname(execPath);
  const contents = dirname(macos);
  const app = dirname(contents);
  return basename(macos) === "MacOS" && basename(contents) === "Contents" &&
      app.endsWith(".app")
    ? app
    : null;
}

/** The identity of an installed `.app`, read from its own `Info.plist` —
 *  what its window bundle is stamped with. */
export type MacAppIdentity = {
  name: string;
  identifier: string;
  version: string;
  /** The `.icns` the bundle declares, or null. */
  icon: string | null;
  /** Hash of the plist and icon: a different install (or an update) of the
   *  app re-stamps its window bundle. */
  digest: string;
};

/** Read {@linkcode MacAppIdentity} from an installed `.app`. */
export async function readMacAppIdentity(app: string): Promise<MacAppIdentity> {
  const plist = await Deno.readTextFile(join(app, "Contents", "Info.plist"));
  const identifier = plistString(plist, "CFBundleIdentifier");
  if (!identifier) {
    throw new Error(
      `${app}/Contents/Info.plist has no CFBundleIdentifier — the app's ` +
        `bundle is damaged; install it again.`,
    );
  }
  const name = plistString(plist, "CFBundleName") ??
    basename(app).replace(/\.app$/, "");
  const version = plistString(plist, "CFBundleShortVersionString") ?? "0.0.0";
  const iconFile = plistString(plist, "CFBundleIconFile");
  let icon: string | null = null;
  let iconBytes = new Uint8Array(0);
  if (iconFile) {
    const p = join(
      app,
      "Contents",
      "Resources",
      iconFile.endsWith(".icns") ? iconFile : `${iconFile}.icns`,
    );
    try {
      iconBytes = await Deno.readFile(p);
      icon = p;
    } catch {
      icon = null; // aio-ok: no icon file → Electron's own stays stripped
    }
  }
  const all = new Uint8Array(
    new TextEncoder().encode(plist).length + iconBytes.length,
  );
  all.set(new TextEncoder().encode(plist));
  all.set(iconBytes, all.length - iconBytes.length);
  return {
    name,
    identifier,
    version,
    icon,
    digest: await sha256Hex(all),
  };
}

/** A bundle id as a directory name: ids are reverse-DNS (`[A-Za-z0-9.-]`),
 *  anything else becomes `_`. Pure. */
export function windowDirName(identifier: string): string {
  const safe = identifier.replace(/[^A-Za-z0-9.-]/g, "_");
  return /^\.*$/.test(safe) ? "_" : safe;
}

/** What a window bundle was made from — written beside it, compared on every
 *  start. */
type WindowStamp = { runtime: string; app: string };

const WINDOW_STAMP = ".aio-window.json";

/** Runs a command and reports its stderr on failure (macOS tools). */
export type RunTool = (
  cmd: string,
  args: string[],
) => Promise<{ ok: boolean; stderr: string }>;

const runTool: RunTool = async (cmd, args) => {
  try {
    const r = await new Deno.Command(cmd, {
      cwd: neutralCwd(),
      args,
      stdin: "null",
      stdout: "null",
      stderr: "piped",
    }).output();
    return { ok: r.success, stderr: new TextDecoder().decode(r.stderr) };
  } catch (e) {
    return { ok: false, stderr: e instanceof Error ? e.message : String(e) };
  }
};

/** The window bundle of the installed `app`, made from the shared runtime at
 *  `runtimeDir` — re-made when the runtime or the app's identity changed.
 *  Returns the executable to start the window from.
 *
 *  Made in a stage beside it and renamed into place, so a start killed
 *  half-way never leaves a bundle that looks finished. */
export async function macWindowBundle(opts: {
  runtimeDir: string;
  app: string;
  root?: string;
  log?: (m: string) => void;
  run?: RunTool;
}): Promise<string> {
  const run = opts.run ?? runTool;
  const id = await readMacAppIdentity(opts.app);
  const home = join(
    opts.root ?? sharedElectronRoot(),
    "windows",
    windowDirName(id.identifier),
  );
  const bundle = join(home, "Electron.app");
  const exe = join(bundle, "Contents", "MacOS", "Electron");
  const want: WindowStamp = {
    runtime: basename(opts.runtimeDir),
    app: id.digest,
  };
  try {
    const have = JSON.parse(
      await Deno.readTextFile(join(home, WINDOW_STAMP)),
    ) as WindowStamp;
    if (
      have.runtime === want.runtime && have.app === want.app &&
      (await Deno.stat(exe)).isFile
    ) return exe;
  } catch {
    // aio-ok: no (or another) window bundle yet — made below
  }

  opts.log?.(`preparing the window for ${id.name}…`);
  await Deno.mkdir(home, { recursive: true });
  const stage = join(home, `.stage-${Deno.pid}`);
  await Deno.remove(stage, { recursive: true }).catch(() => {
    // aio-ok: absent normally; a real failure surfaces in the mkdir
  });
  await Deno.mkdir(stage);
  try {
    const staged = join(stage, "Electron.app");
    // `cp -c`: an APFS clone — the copy shares the runtime's blocks, so 250 MB
    // costs nothing. A volume that cannot clone gets a plain copy.
    const src = join(opts.runtimeDir, "Electron.app");
    let cp = await run("/bin/cp", ["-c", "-R", "-P", src, staged]);
    if (!cp.ok) {
      await Deno.remove(staged, { recursive: true }).catch(() => {
        // aio-ok: absent normally; a real failure surfaces in the copy
      });
      cp = await run("/bin/cp", ["-R", "-P", src, staged]);
    }
    if (!cp.ok) {
      throw new Error(
        `could not copy the Electron runtime into ${stage}: ${cp.stderr.trim()}`,
      );
    }
    // The app's icon in place of Electron's; an app that declares none keeps
    // Electron's rather than showing a blank one.
    const iconName = "AppIcon";
    if (id.icon) {
      await stripElectronBranding(staged);
      await Deno.copyFile(
        id.icon,
        join(staged, "Contents", "Resources", `${iconName}.icns`),
      );
    }
    await stampElectronIdentity(staged, {
      name: id.name,
      identifier: id.identifier,
      iconFile: id.icon ? iconName : "electron.icns",
      version: id.version,
    });
    // The stamp changed the plists of the bundle and its helper apps: those
    // are signed again, ad hoc (Apple Silicon runs nothing unsigned) — and
    // ONLY those. The framework was signed once in the store and is not
    // touched, so it stays a clone of the store's copy and costs no disk.
    const sign = async (path: string) => {
      const r = await run("/usr/bin/codesign", [
        "--force",
        "--sign",
        "-",
        path,
      ]);
      if (!r.ok) {
        throw new Error(
          `could not sign the window of ${id.name} (codesign: ` +
            `${r.stderr.trim().split("\n").at(-1)})`,
        );
      }
    };
    const frameworks = join(staged, "Contents", "Frameworks");
    for (
      const e of await Array.fromAsync(Deno.readDir(frameworks)).catch(() =>
        [] as Deno.DirEntry[]
      )
    ) {
      if (e.isDirectory && e.name.endsWith(".app")) {
        await sign(join(frameworks, e.name));
      }
    }
    await sign(staged);
    await Deno.remove(bundle, { recursive: true }).catch(() => {
      // aio-ok: absent on a first make; a real failure surfaces in the rename
    });
    await renameWithRetry(staged, bundle);
    await Deno.writeTextFile(
      join(home, WINDOW_STAMP),
      JSON.stringify(want) + "\n",
    );
  } finally {
    await Deno.remove(stage, { recursive: true }).catch(() => {});
  }
  return exe;
}

/** The executable a shared-runtime app starts its window from, once the
 *  runtime is in the store: the runtime's own on Linux and Windows, the
 *  app's window bundle on macOS. */
export async function sharedWindowExecutable(opts: {
  runtimeDir: string;
  slug: string;
  execPath: string;
  root?: string;
  log?: (m: string) => void;
  run?: RunTool;
}): Promise<string> {
  const os = electronOsFromSlug(opts.slug);
  if (os !== "darwin") return electronBinIn(opts.runtimeDir, os);
  const app = enclosingMacApp(opts.execPath);
  if (!app) {
    // A bare compiled binary (not inside a .app): no identity to stamp, so the
    // window is the runtime's own — named "Electron" in the Dock.
    return electronBinIn(opts.runtimeDir, os);
  }
  return await macWindowBundle({
    runtimeDir: opts.runtimeDir,
    app,
    root: opts.root,
    log: opts.log,
    run: opts.run,
  });
}

// ── the start: find it, or fetch it with a progress window ─────────────────

/** The heading the progress window shows. */
export const RESOLVING_HEADING = "Resolving dependencies";

/** Thrown inside {@linkcode sharedRuntimeForStart} when the user closed the
 *  progress window. */
class Cancelled extends Error {}

/** The question asked when the runtime could not be had. Pure. */
export function sharedFailureMessage(
  title: string,
  version: string,
  reason: string,
  /** The download failed (a {@linkcode DownloadError}) — not the disk, the
   *  unpacking or the window. Only then is the connection the advice. */
  download = true,
): string {
  // The first line of the reason is the one that names the cause; the rest
  // (URLs, hints for a developer) is in the log.
  const why = reason.split("\n")[0]!.trim();
  return download
    ? `${title} needs Electron ${version} to open its window, and it ` +
      `could not be downloaded.\n\n${why}\n\nCheck the internet ` +
      `connection, then Retry.`
    : `${title} needs Electron ${version} to open its window, and it ` +
      `could not be prepared.\n\n${why}\n\nFix the cause above, then Retry.`;
}

/** How long a cancelled start waits for its own download's cleanup. */
const CANCEL_CLEANUP_MS = 5_000;

/** `p` settled, or `ms` passed — whichever is first; the timer is cleared. */
async function settledWithin(p: Promise<unknown>, ms: number): Promise<void> {
  let t: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    p.then(() => {}, () => {}),
    new Promise<void>((r) => (t = setTimeout(r, ms))),
  ]);
  clearTimeout(t);
}

/** The executable a shared-runtime app's window starts from: found in the
 *  store, or downloaded into it while a progress window says so. On a
 *  failure the user is asked Retry / Quit; with no desktop to ask on, the
 *  failure is final. Returns null when there is no runtime to start (quit,
 *  cancelled, or failed headless) — the caller ends the start, loudly. */
export async function sharedRuntimeForStart(opts: {
  version: string;
  slug: string;
  /** The app's own executable (on macOS, inside its bundle). */
  execPath: string;
  /** What the use record names: the installed artifact (an AppImage's
   *  file, not its mount). Defaults to `execPath`. */
  installed?: string;
  /** The app's title, for the window. */
  title: string;
  log: { info: (m: string) => void; error: (m: string) => void };
  signal?: AbortSignal;
  root?: string;
  fetch?: typeof fetch;
  /** Injected in tests; undefined = this machine's. null = no desktop. */
  dialog?: DialogBackend | null;
  run?: RunTool;
  /** The SHA-256 this app's build pinned for the runtime zip. A real start
   *  passes what the binary carries; `null` — a build that pinned none — is
   *  refused rather than trusting the network's checksum list. */
  sha256?: string | null;
}): Promise<string | null> {
  const { version, slug, log } = opts;
  const root = opts.root ?? sharedElectronRoot();
  const dir = sharedElectronDir(version, slug, root);
  const macIcon = async () => {
    const app = enclosingMacApp(opts.execPath);
    if (!app) return null;
    return (await readMacAppIdentity(app).catch(() => null))?.icon ?? null;
  };
  let backend: DialogBackend | null | undefined = opts.dialog;
  const ui = async () =>
    backend === undefined
      ? (backend = await dialogBackend({ icon: await macIcon() }))
      : backend;
  while (true) {
    if (opts.signal?.aborted) return null;
    let win: ProgressDialog | null = null;
    try {
      if (!(await runtimeUsable(dir, slug))) {
        log.info(
          `electron: ${version} is not in the shared store (${root}) yet — ` +
            `downloading it`,
        );
        const b = await ui();
        win = b
          ? await b.progress(opts.title, RESOLVING_HEADING).catch((e) => {
            log.error(
              `electron: no progress window (${
                e instanceof Error ? e.message : e
              }) — the log carries the progress`,
            );
            return null;
          })
          : null;
        win?.update(null, `Looking for Electron ${version}…`);
        // Closing the window (or the app stopping) ENDS the download — the
        // stage is removed and the lock released before this returns (up to
        // CANCEL_CLEANUP_MS; see the catch below).
        const ctl = new AbortController();
        let cancelled = false;
        const onCancel = () => {
          cancelled = true;
          ctl.abort();
        };
        win?.cancelled.then(onCancel);
        // A window that could not be shown is not a cancel: the download goes
        // on, and the log is where its progress is.
        win?.lost.then((why) =>
          log.error(
            `electron: the progress window could not be shown (${why}) — ` +
              `downloading without it; the log carries the progress`,
          )
        );
        if (opts.sha256 === null) {
          throw new Error(
            `this build of ${opts.title} carries no checksum for Electron ` +
              `${version} on ${slug}, so a download could not be told from a ` +
              `forgery — rebuild the app (its build pins one), or use ` +
              `"electronRuntime": "offline"`,
          );
        }
        if (opts.signal?.aborted) onCancel();
        opts.signal?.addEventListener("abort", onCancel, { once: true });
        let finishing = false;
        let pending: Promise<unknown> | undefined;
        try {
          const got = pending = ensureSharedElectron(version, slug, {
            root,
            sha256: opts.sha256 ?? undefined,
            fetch: opts.fetch,
            signal: ctl.signal,
            log: log.info,
            warn: log.error,
            onBytes: (got, total) => {
              if (finishing) return;
              if (total > 0 && got >= total) {
                finishing = true;
                win?.update(
                  null,
                  `Verifying and unpacking Electron ${version}…`,
                );
                return;
              }
              win?.update(
                total > 0 ? got / total : null,
                downloadDetail(version, got, total),
              );
            },
          });
          // A cancel ends the start NOW — also while this start waits on
          // another's download (the lock), which the abort cannot cut short.
          // That wait then ends on its own; its outcome is not this start's.
          got.catch(() => {
            // aio-ok: once cancelled, the outcome is reported by nothing
          });
          const stop = new Promise<never>((_, reject) => {
            if (cancelled) reject(new Cancelled());
            win?.cancelled.then(() => reject(new Cancelled()));
            opts.signal?.addEventListener(
              "abort",
              () => reject(new Cancelled()),
              { once: true },
            );
          });
          stop.catch(() => {
            // aio-ok: observed by the race below
          });
          await Promise.race([got, stop]);
          if (cancelled) throw new Cancelled();
        } catch (e) {
          if (cancelled && pending) {
            // The aborted download is still removing its stage and releasing
            // the lock: returning at once let an app that exits on the cancel
            // leave both behind (seen on Windows under load, where the test's
            // temp dir was removed under that cleanup). Bounded — a wait on
            // ANOTHER start's lock, which the abort cannot cut short, still
            // ends the start promptly; the window closes first.
            await win?.close();
            win = null;
            await settledWithin(pending, CANCEL_CLEANUP_MS);
          }
          throw cancelled ? new Cancelled() : e;
        } finally {
          opts.signal?.removeEventListener("abort", onCancel);
        }
      }
      // Recorded BEFORE the window is made, so a prune meanwhile keeps the
      // runtime; and the runtime marked used now, so a prune that read the
      // records before this one was written still keeps it.
      const installed = opts.installed ?? opts.execPath;
      await recordSharedUse({ exe: installed, version, slug }, {
        root,
        warn: log.error,
      });
      await touchRuntimeUse(dir);
      if (electronOsFromSlug(slug) === "darwin") {
        win?.update(null, "Preparing the window…");
      }
      const exe = await sharedWindowExecutable({
        runtimeDir: dir,
        slug,
        execPath: opts.execPath,
        root,
        log: log.info,
        run: opts.run,
      });
      const windowsDir = join(root, "windows");
      const windowHome = dirname(dirname(dirname(dirname(exe))));
      if (dirname(windowHome) === windowsDir) {
        await recordSharedUse(
          { exe: installed, version, slug, window: windowHome },
          { root, warn: log.error },
        );
      }
      await win?.close();
      return exe;
    } catch (e) {
      await win?.close();
      if (e instanceof Cancelled) {
        log.error(
          `electron: the start was cancelled while Electron ${version} was ` +
            `downloading — nothing was installed; starting the app again ` +
            `downloads it`,
        );
        return null;
      }
      const reason = e instanceof Error ? e.message : String(e);
      log.error(`electron: could not get Electron ${version}: ${reason}`);
      const b = await ui();
      if (!b) return null;
      const answer = await b.ask(
        opts.title,
        sharedFailureMessage(
          opts.title,
          version,
          reason,
          e instanceof DownloadError,
        ),
      ).catch(() => "quit" as const);
      if (answer === "quit") return null;
      log.info("electron: retrying");
    }
  }
}
