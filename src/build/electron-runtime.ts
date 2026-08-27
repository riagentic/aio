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
import { DENO_JSON_NAMES, readDenoJson } from "../server/deno-json.ts";
import {
  DEFAULT_ELECTRON_VERSION,
  electronRuntimeDir,
  electronSlug,
  electronZipUrlFor,
  ensureElectronRuntime,
} from "../electron/electron-runtime-fetch.ts";
import { PLATFORMS } from "./platforms.ts";

export { unzipInto } from "../electron/electron-runtime-fetch.ts";

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

/** The Electron version this app builds against — read from the runtime it
 *  already has, so the cross-built package and the local one are never two
 *  different Electrons. */
export async function installedElectronVersion(
  root = ".",
): Promise<string | null> {
  const { electronPkgDirs } = await import("../electron/electron-spawn.ts");
  for (const base of await electronPkgDirs(root)) {
    try {
      const pkg = JSON.parse(
        await Deno.readTextFile(join(base, "package.json")),
      ) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch { /* not this layout — try the next */ }
  }
  return null;
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

/** The Electron version THIS app is built against — one decider for the
 *  build and (via `dist/electron.json`) the compiled binary's launcher:
 *   1. the runtime already installed in node_modules (what dev runs);
 *   2. an exact-enough spec in the import map (`npm:electron@^43.4.1`);
 *   3. the framework default.
 *  Never null: a compiled desktop app has to know which Electron to fetch. */
export async function resolveElectronVersion(root = "."): Promise<string> {
  const installed = await installedElectronVersion(root);
  if (installed) return installed;
  try {
    const cfg = ((await readDenoJson(root))?.config ?? {}) as {
      imports?: Record<string, string>;
    };
    const spec = cfg.imports?.["electron"];
    const m = spec && /^npm:electron@[\^~]?(\d+\.\d+\.\d+)$/.exec(spec);
    if (m) return m[1]!;
  } catch { /* no deno.json here — the default below */ }
  return DEFAULT_ELECTRON_VERSION;
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
 *      moves with nobody looking.
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

  // BOTH config names: an app on `deno.jsonc` would otherwise never be told
  // its config had been rewritten (`readDenoJson`'s list is the decider).
  const before = new Map<string, string>();
  for (const name of DENO_JSON_NAMES) {
    const text = await Deno.readTextFile(join(root, name)).catch(() => null);
    if (text !== null) before.set(name, text);
  }
  const installed = await autoInstallElectron({ error: log.error });
  for (const [name, text] of before) {
    const after = await Deno.readTextFile(join(root, name)).catch(() => null);
    if (after !== null && after !== text) {
      log.warn(
        `[electron] \u26a0 ${join(root, name)} was MODIFIED by ` +
          `\`deno install npm:electron\` (auto-install of the Electron ` +
          `runtime). Review the diff and commit it deliberately — the next ` +
          `build reads its pins from this file.`,
      );
    }
  }
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
