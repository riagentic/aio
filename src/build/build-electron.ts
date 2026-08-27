/**
 * @module
 * Build Electron — packages the compiled Deno binary + Electron runtime into
 * a platform-native distributable (AppImage on Linux, zip on Windows/macOS).
 */
import { join } from "@std/path";
import {
  appimageEnv,
  chmodIfSupported,
  copyDir,
  ensureAppimagetool,
  formatMb,
  misplacedIconHint,
  resolveAppIcon,
  toolCacheDir,
  writeDefaultIcon,
} from "./build-helpers.ts";
import type { BuildConfig } from "./build-config.ts";
import { isHostPlatform } from "./platforms.ts";
import {
  electronMissingHint,
  ensureElectronDist,
  ensureHostElectronDist,
  installedElectronVersion,
} from "./electron-runtime.ts";
import {
  APP_ICON,
  APP_STYLE,
  BUNDLE_JS,
  DIST_DIR,
} from "../server/app-files.ts";

/** Zip a directory's CONTENTS, portably.
 *
 *  `zip -y` keeps symlinks as links, which matters for macOS: Electron.app's
 *  Frameworks are a web of them, and a package that resolved them into copies
 *  is both enormous and subtly broken. PowerShell's Compress-Archive is the
 *  fallback (Windows hosts without `zip`), and it is no longer the only way —
 *  that was what made a Windows package a Windows-only act. */
async function zipDir(dir: string, out: string): Promise<boolean> {
  const attempts: [string, string[]][] = [
    ["zip", ["-r", "-y", "-q", out, "."]],
    ["powershell", [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path "${dir}/*" -DestinationPath "${out}" -Force`,
    ]],
  ];
  for (const [cmd, args] of attempts) {
    try {
      const r = await new Deno.Command(cmd, {
        args,
        cwd: cmd === "zip" ? dir : undefined,
        stdout: "null",
        stderr: "piped",
      }).output();
      if (r.success) return true;
      console.error(
        `[electron] ⚠ ${cmd}: ${
          new TextDecoder().decode(r.stderr).trim().split("\n")[0] ?? ""
        }`,
      );
    } catch { /* not installed — try the next */ }
  }
  console.error(
    "[electron] ✗ neither `zip` nor PowerShell could pack it — install zip " +
      "(Debian/Ubuntu: sudo apt install zip)",
  );
  return false;
}

/** Package the Electron app for the current platform. Exits process on completion or error. */
export async function buildElectron(cfg: BuildConfig): Promise<void> {
  const { root, dist, binaryName, appTitle, os, arch, archStr } = cfg;

  const appDir = join(dist, "AppDir");

  // Copy dist/ assets into AppDir/dist/ (Electron can't read Deno's embedded VFS)
  const appDirDist = join(appDir, DIST_DIR);
  await Deno.mkdir(appDirDist, { recursive: true });
  for (const name of [BUNDLE_JS, APP_STYLE, APP_ICON]) {
    // A file that EXISTS in dist/ must land in the package — a swallowed copy
    // here is how a packaged app silently loses its stylesheet and stops
    // looking like dev (WYSIDIWYSIP). Only true absence is optional (and
    // app.js can never be absent: the bundle step just wrote it).
    let exists = true;
    try {
      await Deno.stat(join(dist, name));
    } catch {
      exists = false;
    }
    if (name === BUNDLE_JS && !exists) {
      console.error(
        `[electron] ✗ ${
          join(dist, name)
        } missing — bundle step did not produce it`,
      );
      Deno.exit(1);
    }
    if (exists) await Deno.copyFile(join(dist, name), join(appDirDist, name));
  }
  console.log("[electron] \u2713 dist/ assets copied to AppDir/dist/");

  // Copy Electron runtime — auto-install on first build so `--electron` works
  // OUT OF THE BOX; loud manual fallback if it fails. WHERE it lives, and the
  // install, are `ensureHostElectronDist`: one decider, shared with the
  // `--client` target (electron-runtime.ts says why).
  let electronSrc = await ensureHostElectronDist(root);

  // Cross-building: the runtime in node_modules is THIS host's. Electron
  // publishes every platform's build as a zip, so fetch the one this package
  // is for — the version comes from the runtime already installed here, so a
  // cross-built package and a local one are never two different Electrons.
  if (!isHostPlatform(cfg.platform)) {
    const version = await installedElectronVersion(root);
    if (!version) {
      console.error(
        "[electron] ✗ cannot tell which Electron version to fetch for " +
          `${cfg.platform} — install it once here so the version is pinned:\n` +
          "      deno task install:electron",
      );
      Deno.exit(1);
    }
    try {
      electronSrc = await ensureElectronDist(version, cfg.platform);
    } catch (e) {
      console.error(`[electron] ✗ ${e instanceof Error ? e.message : e}`);
      Deno.exit(1);
    }
  }
  const electronDst = join(appDir, "electron");
  if (electronSrc === null) {
    console.error(`[electron] \u2717 ${electronMissingHint()}`);
    Deno.exit(1);
  }
  console.log("[electron] copying Electron runtime...");
  await copyDir(electronSrc, electronDst);
  console.log("[electron] \u2713 electron/ copied");

  // Icon \u2014 from THE app-dir decider (cfg.appDir), same place dev reads it
  const { icon: userIcon, misplaced } = await resolveAppIcon(
    cfg.root,
    cfg.appDir,
  );
  if (misplaced) {
    console.warn(
      `[electron] \u26a0 ${misplacedIconHint(misplaced, cfg.appDir)}`,
    );
  }
  if (userIcon) {
    // Outside the stat's catch: an EXISTING icon that fails to copy (EACCES,
    // disk full) is a broken build, never a silent placeholder downgrade.
    await Deno.copyFile(userIcon, join(appDir, `${binaryName}.png`));
    console.log(`[electron] \u2713 icon from ${userIcon}`);
  } else {
    // The app ships no icon — generate its monogram rather than the same flat
    // square every icon-less app used to get. Three running aio apps must be
    // three distinguishable entries in a taskbar, which is the whole job an
    // icon does before someone draws a real one.
    await writeDefaultIcon(join(appDir, binaryName), appTitle ?? binaryName);
    console.log(
      `[electron] \u2713 default icon for "${appTitle ?? binaryName}"`,
    );
  }

  const displayName = (appTitle ?? binaryName).replace(
    // deno-lint-ignore no-control-regex
    /[\x00-\x1f\x7f\r\n]/g,
    "",
  );

  if (os === "linux") {
    await _packageLinux(cfg, appDir, displayName, arch, root, binaryName);
  } else if (os === "windows") {
    await _packageWindows(cfg, appDir, displayName, archStr, root, binaryName);
  } else if (os === "darwin") {
    await _packageMacos(cfg, appDir, archStr, root, binaryName);
  } else {
    console.error(`[electron] \u2717 unsupported platform: ${os}`);
    Deno.exit(1);
  }
}

async function _packageLinux(
  cfg: BuildConfig,
  appDir: string,
  displayName: string,
  arch: string,
  root: string,
  binaryName: string,
): Promise<void> {
  void cfg;
  const appRun = `#!/bin/bash
HERE="$(dirname "$(readlink -f "$0")")"
export ELECTRON_PATH="$HERE/electron/electron"
exec "$HERE/${binaryName}" "$@"
`;
  await Deno.writeTextFile(join(appDir, "AppRun"), appRun);
  await chmodIfSupported(join(appDir, "AppRun"), 0o755);

  const desktop = `[Desktop Entry]
Type=Application
Name=${displayName}
Exec=${binaryName}
Icon=${binaryName}
Categories=Utility;
`;
  await Deno.writeTextFile(join(appDir, `${binaryName}.desktop`), desktop);

  const toolPath = await ensureAppimagetool(arch, toolCacheDir());

  // appimagetool shells out to `file(1)` and dies with "file command is
  // missing but required, please install it" — its message, mid-build, about a
  // tool the developer never chose. Present on every desktop, absent from
  // minimal containers and slim CI images, which is exactly where a build
  // runs. Checked here so the failure names the package instead of arriving
  // from a program the user did not invoke.
  const hasFile = await new Deno.Command("sh", {
    args: ["-c", "command -v file"],
    stdout: "null",
    stderr: "null",
  }).output().then((r) => r.success).catch(() => false);
  if (!hasFile) {
    console.error(
      "[appimage] \u2717 `file` is not installed, and appimagetool requires it.\n" +
        "      Debian/Ubuntu:  sudo apt install -y file\n" +
        "      Fedora/RHEL:    sudo dnf install -y file\n" +
        "      Alpine:         sudo apk add file",
    );
    Deno.exit(1);
  }

  await Deno.mkdir(cfg.outDir ?? root, { recursive: true });
  const appImageOut = join(
    cfg.outDir ?? root,
    `${binaryName}-${arch}.AppImage`,
  );
  console.log("[appimage] packaging...");
  const appimageResult = await new Deno.Command(toolPath, {
    args: [appDir, appImageOut],
    stdout: "inherit",
    stderr: "inherit",
    env: appimageEnv(arch), // FUSE-less hosts — see appimageEnv
  }).output();

  if (appimageResult.code !== 0) {
    console.error("[appimage] \u2717 appimagetool failed");
    Deno.exit(1);
  }

  const appImageStat = await Deno.stat(appImageOut);
  console.log(
    `[appimage] \u2713 ${binaryName}-${arch}.AppImage (${
      formatMb(appImageStat.size)
    } MB)`,
  );
}

async function _packageWindows(
  cfg: BuildConfig,
  appDir: string,
  displayName: string,
  archStr: string,
  root: string,
  binaryName: string,
): Promise<void> {
  void cfg;
  const launcher = `@echo off
SET HERE=%~dp0
SET ELECTRON_PATH=%HERE%electron\\electron.exe
"%HERE%${binaryName}.exe" %*
`;
  await Promise.all([
    Deno.writeTextFile(join(appDir, "run.bat"), launcher),
    Deno.writeTextFile(
      join(appDir, "README.txt"),
      `${displayName}\n\nRun: double-click run.bat or ${binaryName}.exe\n`,
    ),
  ]);
  console.log("[electron] \u2713 run.bat launcher");

  await Deno.mkdir(cfg.outDir ?? root, { recursive: true });
  const zipOut = join(cfg.outDir ?? root, `${binaryName}-win-${archStr}.zip`);
  console.log("[electron] zipping Windows package...");
  // `zip` first, PowerShell second: Compress-Archive exists only on Windows,
  // and that single call was the whole reason a Windows package could not be
  // built anywhere else.
  if (!await zipDir(appDir, zipOut)) {
    console.error("[electron] \u2717 could not zip the Windows package");
    Deno.exit(1);
  }

  const zipStat = await Deno.stat(zipOut);
  console.log(
    `[electron] \u2713 ${binaryName}-win-${archStr}.zip (${
      formatMb(zipStat.size)
    } MB)`,
  );
}

async function _packageMacos(
  cfg: BuildConfig,
  appDir: string,
  archStr: string,
  root: string,
  binaryName: string,
): Promise<void> {
  void cfg;
  const launcher = `#!/bin/bash
HERE="$(cd "$(dirname "$0")" && pwd)"
export ELECTRON_PATH="$HERE/electron/Electron.app/Contents/MacOS/Electron"
exec "$HERE/${binaryName}" "$@"
`;
  const launcherPath = join(appDir, "run.sh");
  await Deno.writeTextFile(launcherPath, launcher);
  await chmodIfSupported(launcherPath, 0o755);
  console.log("[electron] \u2713 run.sh launcher");

  await Deno.mkdir(cfg.outDir ?? root, { recursive: true });
  const zipOut = join(cfg.outDir ?? root, `${binaryName}-mac-${archStr}.zip`);
  console.log("[electron] zipping macOS package...");
  if (!await zipDir(appDir, zipOut)) {
    console.error("[electron] \u2717 could not zip the macOS package");
    Deno.exit(1);
  }

  const zipStat = await Deno.stat(zipOut);
  console.log(
    `[electron] \u2713 ${binaryName}-mac-${archStr}.zip (${
      formatMb(zipStat.size)
    } MB)`,
  );
}
