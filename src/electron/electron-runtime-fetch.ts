/**
 * @module
 * The Electron runtime, fetched from Electron's own releases — for a machine
 * that has no `node_modules/electron` and no `deno` to install one with.
 *
 * A COMPILED aio binary whose client is Electron used to resolve the runtime
 * in exactly one place: `node_modules/.bin/electron` under the CURRENT
 * DIRECTORY, and when that was missing it "auto-installed" by running
 * `Deno.execPath() install --allow-scripts=npm:electron npm:electron`. Inside a
 * compiled binary `Deno.execPath()` is the app itself, so that command was
 * `<app> install …` — it can never have worked. The message that
 * followed said "run `deno task install:electron`", which is advice for a
 * checkout, aimed at someone who was handed a binary. That is the field
 * report behind this file: a desktop app installed by the one-liner opened
 * nothing until its user went back to the source tree, installed Electron by
 * hand, and launched the binary FROM that directory.
 *
 * Electron publishes every platform's runtime as a plain zip; the cross-build
 * path has fetched those for a while. This module is that fetch, made usable
 * from the launcher: download once into the per-user aio cache, verify the
 * unpack finished, hand back the binary. No npm, no deno, no cwd. The build
 * bakes the version (`dist/electron.json`) so a binary and the checkout it was
 * built from never run two different Electrons.
 *
 * Lives in `electron/` (not `build/`) because the LAUNCHER needs it and the
 * boundary matrix lets build → electron, never the reverse. The build-side
 * wrappers in `build/electron-runtime.ts` delegate here.
 */
import { join } from "@std/path";
import { log as flog } from "../diagnostics/logger-api.ts";

/** The Electron version a build falls back to when the app declares no exact
 *  one and none is installed. ONE decider — the scaffold's import map says
 *  `npm:electron` (latest at install time), so a version has to come from
 *  somewhere when nothing has been installed yet. */
export const DEFAULT_ELECTRON_VERSION = "43.4.1";

/** `dist/electron.json` — written by the build, read by the launcher of a
 *  compiled binary. The file name is the contract between the two. */
export const ELECTRON_VERSION_FILE = "electron.json";

/** aio's per-user tool cache (appimagetool, Electron runtimes, run tmp).
 *  `$XDG_CACHE_HOME/aio/tools` or `~/.cache/aio/tools`. */
export function toolCacheDir(): string {
  const xdg = Deno.env.get("XDG_CACHE_HOME");
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
  return join(
    xdg && xdg.length > 0 ? xdg : join(home, ".cache"),
    "aio",
    "tools",
  );
}

/** Electron's own name for an os/arch pair, as it appears in its release
 *  assets: `electron-v28.3.3-win32-x64.zip`. Pure. */
export function electronSlug(
  build: { os: string; arch: string } = Deno.build,
): string {
  const os = build.os === "windows"
    ? "win32"
    : build.os === "darwin"
    ? "darwin"
    : "linux";
  const arch = build.arch === "aarch64" ? "arm64" : "x64";
  return `${os}-${arch}`;
}

/** The URL Electron publishes `version` for `slug` at. Pure. */
export function electronZipUrlFor(version: string, slug: string): string {
  const v = version.startsWith("v") ? version : `v${version}`;
  return `https://github.com/electron/electron/releases/download/${v}/electron-${v}-${slug}.zip`;
}

/** Where a fetched runtime lives: one directory per version+slug, shared by
 *  the launcher and every build on this machine, so a runtime is downloaded
 *  once per user rather than once per app. */
export function electronRuntimeDir(version: string, slug: string): string {
  const v = version.startsWith("v") ? version.slice(1) : version;
  return join(toolCacheDir(), "electron", `${v}-${slug}`);
}

/** The executable inside an unpacked runtime directory. Pure. */
export function electronBinIn(dir: string, os: string = Deno.build.os): string {
  switch (os) {
    case "darwin":
      return join(dir, "Electron.app", "Contents", "MacOS", "Electron");
    case "windows":
      return join(dir, "electron.exe");
    default:
      return join(dir, "electron");
  }
}

/** Read the baked version from `<distDir>/electron.json`, or null. Pure in
 *  effect: no download, no guess — a caller decides what null means. */
export async function bakedElectronVersion(
  distDir: string | undefined,
): Promise<string | null> {
  if (!distDir) return null;
  try {
    const rec = JSON.parse(
      await Deno.readTextFile(join(distDir, ELECTRON_VERSION_FILE)),
    ) as { version?: unknown };
    return typeof rec.version === "string" && rec.version.length > 0
      ? rec.version
      : null;
  } catch {
    return null;
  }
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
 *  last resort and the bits are restored by hand for the one file that must
 *  have them. */
export async function unzipInto(
  zip: string,
  dir: string,
  warn: (msg: string) => void = console.warn,
): Promise<void> {
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
        warn(
          "[electron] ⚠ unpacked with python's zipfile, which drops " +
            "executable bits — install `unzip` for a package that runs " +
            "without a chmod",
        );
        if (Deno.build.os !== "windows") {
          await Deno.chmod(electronBinIn(dir), 0o755).catch(() => {});
        }
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

/** The unpacked Electron runtime for `version`+`slug`, downloading it once.
 *
 *  Returns the directory (the same shape `node_modules/electron/dist` has,
 *  because it IS that: the zip Electron publishes is the dist directory).
 *  A marker file, not "the directory exists", says the download finished: an
 *  interrupted one left a half-unpacked runtime that looked complete and
 *  produced a package that could not start. */
export async function ensureElectronRuntime(
  version: string,
  slug: string,
  opts: {
    log?: (msg: string) => void;
    warn?: (msg: string) => void;
    /** Injected in tests — the real one downloads ~100 MB. */
    fetch?: typeof fetch;
  } = {},
): Promise<string> {
  const log = opts.log ?? ((m: string) => flog.info(m));
  const dir = electronRuntimeDir(version, slug);
  const stamp = join(dir, ".aio-complete");
  try {
    await Deno.stat(stamp);
    log(`[electron] ✓ runtime ${version} (${slug}) — cached`);
    return dir;
  } catch { /* not cached, or not finished */ }

  const url = electronZipUrlFor(version, slug);
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  await Deno.mkdir(dir, { recursive: true });

  log(
    `[electron] downloading runtime ${version} for ${slug} (~100 MB, once per machine)…`,
  );
  const res = await (opts.fetch ?? fetch)(url);
  if (!res.ok) {
    throw new Error(
      `could not download the Electron runtime for ${slug}: ` +
        `${res.status} ${res.statusText}\n  ${url}\n` +
        `  (is ${version} a real Electron release? set ELECTRON_MIRROR-free ` +
        `access to github.com, or point $ELECTRON_PATH at an Electron you have)`,
    );
  }
  const zip = join(dir, "electron.zip");
  await Deno.writeFile(zip, new Uint8Array(await res.arrayBuffer()));
  await unzipInto(zip, dir, opts.warn);
  await Deno.remove(zip).catch(() => {});
  await Deno.writeTextFile(stamp, `${url}\n`);
  log(`[electron] ✓ runtime ${version} (${slug}) ready`);
  return dir;
}
