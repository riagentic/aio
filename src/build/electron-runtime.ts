/**
 * @module
 * The Electron runtime for a platform that is NOT this machine.
 *
 * `compile:electron` took its runtime from `node_modules/electron/dist` — which
 * is whatever npm downloaded for THIS host, because the `electron` package
 * fetches exactly one build at install time. So a desktop app for three
 * platforms needed three machines, and the build said so:
 *
 *   "Electron targets bundle a per-OS Electron runtime … build them on that OS"
 *
 * That conflated two different things. The PACKAGING for Windows and macOS is a
 * directory, a launcher script and a zip — no OS-specific tooling anywhere. What
 * genuinely needs the target OS is SIGNING (Apple notarization, a `.dmg`), and
 * an unsigned zip is exactly what we already ship. The only real blocker was
 * that we never fetched the other platforms' runtimes, and Electron publishes
 * every one of them as a plain zip on its releases page.
 *
 * Linux stays host-only, and for a different reason: its package is an AppImage,
 * and `appimagetool` runs on Linux. That is a tool constraint, not a runtime one
 * — see `crossCompileBlocker`.
 */
import { join } from "@std/path";
import { readDenoJson } from "../server/deno-json.ts";
import {
  DEFAULT_ELECTRON_VERSION,
  electronRuntimeDir,
  electronSlug,
  electronZipUrlFor,
  ensureElectronRuntime,
} from "../electron/electron-runtime-fetch.ts";
import { PLATFORMS } from "./platforms.ts";

export { unzipInto } from "../electron/electron-runtime-fetch.ts";
// THE version, re-exported through the build's runtime module so `am create`
// can pin the scaffold's import map to it. `am` may import `build` (matrix) but
// not `electron`, and a second literal in the scaffold is exactly how the
// framework default and a new app's pin drifted apart before.
export { DEFAULT_ELECTRON_VERSION } from "../electron/electron-runtime-fetch.ts";

/** Electron's own name for a platform, as it appears in its release assets:
 *  `electron-v28.3.3-win32-x64.zip`. Ours is the aio platform name. */
export function electronAssetSlug(platform: string): string | null {
  const spec = PLATFORMS[platform];
  if (!spec) return null;
  return electronSlug(spec);
}

/** The URL Electron publishes that build at. Pure, so the whole mapping is a
 *  unit test rather than a download nobody runs twice. */
export function electronZipUrl(
  version: string,
  platform: string,
): string | null {
  const slug = electronAssetSlug(platform);
  return slug ? electronZipUrlFor(version, slug) : null;
}

/** Where a fetched runtime lives — the SAME directory the launcher of a
 *  compiled binary downloads into, so a machine that built an app and a
 *  machine that runs one each hold one copy per version, not one per use. */
export function electronCacheDir(version: string, platform: string): string {
  const slug = electronAssetSlug(platform) ?? platform;
  return electronRuntimeDir(version, slug);
}

/** The Electron runtime installed under `root` (unpacked), or null — THE
 *  reader lives with the launcher (`installedRuntimeVersion`). */
export async function installedElectronVersion(
  root = ".",
): Promise<string | null> {
  const { installedRuntimeVersion } = await import(
    "../electron/electron-spawn.ts"
  );
  return await installedRuntimeVersion(root);
}

/** The Electron runtime directory for `platform`, downloading it once.
 *  Delegates to the launcher's fetch (`electron/electron-runtime-fetch.ts`) —
 *  one implementation for "get me Electron <version> for <platform>". */
export async function ensureElectronDist(
  version: string,
  platform: string,
  opts: { log?: (msg: string) => void } = {},
): Promise<string> {
  const slug = electronAssetSlug(platform);
  if (!slug) throw new Error(`unknown platform "${platform}"`);
  return await ensureElectronRuntime(version, slug, opts);
}

/** A local `node_modules` Electron `dist/` directory, but ONLY when its
 *  `package.json` version is exactly `version`. Lets an offline build reuse an
 *  installed runtime without ever mixing two Electrons in one package — the
 *  bug that made a Windows zip ship 44.4.1 while the self-contained exe baked
 *  43.0.0 (real Windows 11, 2026-09-17). */
export async function localElectronDistFor(
  version: string,
  root = ".",
): Promise<string | null> {
  const { electronDistDir } = await import("../electron/electron-spawn.ts");
  const dir = await electronDistDir(root);
  if (dir === null) return null;
  try {
    const pkg = JSON.parse(
      await Deno.readTextFile(join(dir, "..", "package.json")),
    ) as { version?: string };
    return pkg.version === version ? dir : null;
  } catch {
    return null;
  }
}

/** The Electron version THIS app is built against: the one this aio is
 *  tested with (`DEFAULT_ELECTRON_VERSION`) — always. One decider for the
 *  build and (via `dist/electron.json`) the compiled binary's launcher.
 *
 *  It used to be the APP's choice (installed runtime > import-map spec >
 *  default), so an app scaffolded by an older aio shipped that aio's Electron
 *  forever: `am pin` moved the framework and left the Chromium under it on a
 *  version this aio never ran. The app's spec and runtime are now copies aio
 *  keeps in line (`am pin`, `am fix`, the dev launcher); a stale copy is
 *  REPORTED (`electronDrift`), never shipped. `root` is kept for callers. */
export function resolveElectronVersion(_root = "."): Promise<string> {
  return Promise.resolve(DEFAULT_ELECTRON_VERSION);
}

/** What an app's Electron copies say, against the tested version. */
export type ElectronDrift = {
  tested: string;
  /** `imports.electron` in the app's deno.json, as written (null: none). */
  declared: string | null;
  /** The unpacked runtime in node_modules (null: none). */
  installed: string | null;
};

/** Read the app's two copies of its Electron version. */
export async function electronDrift(root = "."): Promise<ElectronDrift> {
  let declared: string | null = null;
  try {
    const cfg = ((await readDenoJson(root))?.config ?? {}) as {
      imports?: Record<string, string>;
    };
    declared = cfg.imports?.["electron"] ?? null;
  } catch { /* no deno.json — nothing declared */ }
  return {
    tested: DEFAULT_ELECTRON_VERSION,
    declared,
    installed: await installedElectronVersion(root),
  };
}

/** The one line a build prints when the app's copies disagree with the
 *  version it ships, or null when they agree. Pure. */
export function electronDriftNote(d: ElectronDrift): string | null {
  const want = `npm:electron@${d.tested}`;
  const off = [
    d.declared !== null && d.declared !== want
      ? `deno.json says "${d.declared}"`
      : null,
    d.installed !== null && d.installed !== d.tested
      ? `node_modules has ${d.installed}`
      : null,
  ].filter((x): x is string => x !== null);
  return off.length === 0 ? null : `Electron ${d.tested} ships (the version ` +
    `this aio is tested with), but ${
      off.join(" and ")
    } — \`am fix\` aligns them`;
}

/** THE Electron runtime this HOST has, installing it once if it has none.
 *
 *  Every packaging target needs the same three things and must not each grow
 *  its own answer to them:
 *
 *   1. WHERE the runtime is — `electronDistDir`, which knows both node_modules
 *      layouts. `build-client.ts` checked `node_modules/electron/dist` and
 *      nothing else, which is the exact bug `electronDistDir`'s own doc
 *      comment describes as fixed: the build auto-installs Electron, fails to
 *      find what it just installed, and tells the user to run
 *      `deno task install:electron` — which installs it to the same place the
 *      build is still not looking. It was fixed for `--electron` and left
 *      standing for `--client`, one function away.
 *   2. INSTALLING it when absent, rather than refusing a first build.
 *   3. Saying so when `deno install npm:electron` REWRITES the app's config,
 *      because a build silently editing the file it builds from is how a pin
 *      moves with nobody looking. That report now lives in the INSTALLER
 *      (`electronConfigNotes`), so every caller of it inherits the same
 *      lines — this was the only path that had them.
 *
 *  Returns the `dist` directory, or null when the runtime could not be
 *  obtained (the caller prints its own target-flavoured refusal). */
export async function ensureHostElectronDist(
  root: string,
  log: { warn: (m: string) => void; error: (m: string) => void } = console,
): Promise<string | null> {
  const { autoInstallElectron, electronDistDir } = await import(
    "../electron/electron-spawn.ts"
  );
  const found = await electronDistDir(root);
  if (found !== null) return found;

  // The rewrite is REPORTED by the installer itself (`electronConfigNotes`),
  // for every caller and not just this one: `deno task install:electron` and
  // the dev launcher run the same `deno install`, and used to edit an app's
  // pin with no line of output at all (a field report). One decider, one
  // place — this function used to hold a second copy of the before/after
  // check and was the only path that said anything.
  const installed = await autoInstallElectron(
    { error: log.error, warn: log.warn },
    undefined,
    undefined,
    undefined,
    root,
  );
  return installed ? await electronDistDir(root) : null;
}

/** The one sentence every target prints when the host has no Electron runtime
 *  and could not get one. Names BOTH layouts, because "not found" that names
 *  only one of them is what sent people round the install loop. */
export function electronMissingHint(): string {
  return "the Electron runtime is not installed and could not be installed " +
    "automatically. Install it by hand:\n" +
    "      deno task install:electron\n" +
    "  (looked in node_modules/electron/dist and " +
    "node_modules/.deno/electron@*/node_modules/electron/dist)";
}

const _driftSaid = new Set<string>();

/** Say `electronDriftNote` once per app root per process — the compile step
 *  and the package step both resolve the version, and one build is one line. */
export async function reportElectronDrift(
  root: string,
  warn: (msg: string) => void,
): Promise<void> {
  if (_driftSaid.has(root)) return;
  _driftSaid.add(root);
  const note = electronDriftNote(await electronDrift(root));
  if (note) warn(note);
}
