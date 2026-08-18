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
import { toolCacheDir } from "./build-helpers.ts";
import { PLATFORMS } from "./platforms.ts";

/** Electron's own name for a platform, as it appears in its release assets:
 *  `electron-v28.3.3-win32-x64.zip`. Ours is the aio platform name. */
export function electronAssetSlug(platform: string): string | null {
  const spec = PLATFORMS[platform];
  if (!spec) return null;
  const os = spec.os === "windows"
    ? "win32"
    : spec.os === "darwin"
    ? "darwin"
    : "linux";
  const arch = spec.arch === "aarch64" ? "arm64" : "x64";
  return `${os}-${arch}`;
}

/** The URL Electron publishes that build at. Pure, so the whole mapping is a
 *  unit test rather than a download nobody runs twice. */
export function electronZipUrl(
  version: string,
  platform: string,
): string | null {
  const slug = electronAssetSlug(platform);
  if (!slug) return null;
  const v = version.startsWith("v") ? version : `v${version}`;
  return `https://github.com/electron/electron/releases/download/${v}/electron-${v}-${slug}.zip`;
}

/** Where a fetched runtime lives. One directory per version+platform, so two
 *  targets of the same build share one download and a second build costs
 *  nothing. */
export function electronCacheDir(version: string, platform: string): string {
  return join(toolCacheDir(), "electron", `${version}-${platform}`);
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

/** Unpack `zip` into `dir`.
 *
 *  Deno has no zip reader, so this shells out — and the tool it needs is the
 *  one a minimal image most often lacks (the fresh-Ubuntu lab exists because
 *  `deno`'s own installer assumed `unzip`). Three candidates are tried and the
 *  failure names the package to install, rather than arriving as "command not
 *  found" from a program the developer never invoked.
 *
 *  `unzip` and `bsdtar` both preserve the symlinks and exec bits inside
 *  Electron.app; python's zipfile does not preserve exec bits, so it is the
 *  last resort and says what it cost. */
export async function unzipInto(zip: string, dir: string): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  const tries: [string, string[]][] = [
    ["unzip", ["-q", "-o", zip, "-d", dir]],
    ["bsdtar", ["-xf", zip, "-C", dir]],
    ["python3", ["-m", "zipfile", "-e", zip, dir]],
  ];
  const missing: string[] = [];
  for (const [cmd, args] of tries) {
    let out;
    try {
      out = await new Deno.Command(cmd, {
        args,
        stdout: "null",
        stderr: "piped",
      }).output();
    } catch {
      missing.push(cmd);
      continue; // not installed — try the next
    }
    if (out.success) {
      if (cmd === "python3") {
        console.warn(
          "[electron] ⚠ unpacked with python's zipfile, which drops " +
            "executable bits — install `unzip` for a package that runs " +
            "without a chmod",
        );
      }
      return;
    }
    throw new Error(
      `${cmd} failed to unpack ${zip}: ${
        new TextDecoder().decode(out.stderr).trim().split("\n")[0] ?? ""
      }`,
    );
  }
  throw new Error(
    `no unzip tool found (tried ${missing.join(", ")}) — install one:\n` +
      "    Debian/Ubuntu: sudo apt install unzip\n" +
      "    Fedora:        sudo dnf install unzip\n" +
      "    macOS:         unzip ships with the system",
  );
}

/** The Electron runtime directory for `platform`, downloading it once.
 *
 *  Returns the directory to copy into the package — the same shape
 *  `node_modules/electron/dist` has, because it IS that: the zip Electron
 *  publishes is the dist directory. */
export async function ensureElectronDist(
  version: string,
  platform: string,
  opts: { log?: (msg: string) => void } = {},
): Promise<string> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const dir = electronCacheDir(version, platform);
  // A marker rather than "the directory exists": an interrupted download left
  // a half-unpacked runtime that looked complete and produced a package that
  // could not start.
  const stamp = join(dir, ".aio-complete");
  try {
    await Deno.stat(stamp);
    log(`[electron] ✓ runtime ${version} (${platform}) — cached`);
    return dir;
  } catch { /* not cached, or not finished */ }

  const url = electronZipUrl(version, platform);
  if (!url) throw new Error(`unknown platform "${platform}"`);
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  await Deno.mkdir(dir, { recursive: true });

  log(`[electron] downloading runtime ${version} for ${platform}…`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `could not download the Electron runtime for ${platform}: ` +
        `${res.status} ${res.statusText}\n  ${url}\n` +
        `  (is ${version} a real Electron release?)`,
    );
  }
  const zip = join(dir, "electron.zip");
  await Deno.writeFile(zip, new Uint8Array(await res.arrayBuffer()));
  await unzipInto(zip, dir);
  await Deno.remove(zip).catch(() => {});
  await Deno.writeTextFile(stamp, `${url}\n`);
  log(`[electron] ✓ runtime ${version} (${platform}) ready`);
  return dir;
}
