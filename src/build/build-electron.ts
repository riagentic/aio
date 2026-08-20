/**
 * @module
 * Build Electron — packages the compiled Deno binary + Electron runtime into
 * a platform-native distributable (AppImage on Linux, zip on Windows/macOS).
 */
import { join } from "@std/path";
import {
  appimageEnv,
  copyDir,
  ensureAppimagetool,
  formatMb,
  toolCacheDir,
  writeDefaultIcon,
} from "./build-helpers.ts";
import type { BuildConfig } from "./build-config.ts";
import { isHostPlatform } from "./platforms.ts";

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
  const appDirDist = join(appDir, "dist");
  await Deno.mkdir(appDirDist, { recursive: true });
  for (const name of ["app.js", "style.css", "icon.png"]) {
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
    if (name === "app.js" && !exists) {
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

  // Copy Electron runtime — auto-install on first build so
  // `compile:electron` works OUT OF THE BOX; loud manual fallback if it fails.
  //
  // The LOCATION comes from `electronDistDir` (electron-spawn.ts), which is the
  // same function the runtime uses to launch. This used to be a local
  // `node_modules/electron/dist` — one of the two layouts — so a successful
  // auto-install was followed by "not found — run: deno task install:electron",
  // advice that installs it exactly where this code was still not looking.
  const { autoInstallElectron, electronDistDir } = await import(
    "../electron/electron-spawn.ts"
  );
  let electronSrc = await electronDistDir(root);

  // Cross-building: the runtime in node_modules is THIS host's. Electron
  // publishes every platform's build as a zip, so fetch the one this package
  // is for — the version comes from the runtime already installed here, so a
  // cross-built package and a local one are never two different Electrons.
  if (!isHostPlatform(cfg.platform)) {
    const { ensureElectronDist, installedElectronVersion } = await import(
      "./electron-runtime.ts"
    );
    const version = await installedElectronVersion(root) ??
      (await autoInstallElectron({ error: console.error })
        ? await installedElectronVersion(root)
        : null);
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
    // `deno install npm:electron` REWRITES the app's deno.json (it adds the
    // dependency, and re-resolving can move other pins with it). That file is
    // the user's, and a build silently editing the config it is building from
    // is how a pin moves and a bundle cache busts with nobody looking. We
    // cannot decline the install — the target needs the runtime — but the
    // mutation is detected and announced at the moment it happens, instead of
    // being discovered later as an unexplained diff.
    const denoJsonPath = join(root, "deno.json");
    const before = await Deno.readTextFile(denoJsonPath).catch(() => null);
    const installed = await autoInstallElectron({ error: console.error });
    const after = await Deno.readTextFile(denoJsonPath).catch(() => null);
    if (before !== null && after !== null && before !== after) {
      console.warn(
        `[electron] \u26a0 ${denoJsonPath} was MODIFIED by ` +
          `\`deno install npm:electron\` (auto-install of the Electron ` +
          `runtime). Review the diff and commit it deliberately — the next ` +
          `build reads its pins from this file.`,
      );
    }
    if (installed) electronSrc = await electronDistDir(root);
    if (electronSrc === null) {
      console.error(
        "[electron] \u2717 the Electron runtime is not installed and could " +
          "not be installed automatically. Install it by hand:\n" +
          "      deno task install:electron\n" +
          "  (looked in node_modules/electron/dist and " +
          "node_modules/.deno/electron@*/node_modules/electron/dist)",
      );
      Deno.exit(1);
    }
  }
  console.log("[electron] copying Electron runtime...");
  await copyDir(electronSrc, electronDst);
  console.log("[electron] \u2713 electron/ copied");

  // Icon \u2014 from THE app-dir decider (cfg.appDir), same place dev reads it
  const userIcon = join(cfg.appDir, "icon.png");
  let hasUserIcon = false;
  try {
    await Deno.stat(userIcon);
    hasUserIcon = true;
  } catch { /* no app icon \u2014 placeholder below */ }
  if (hasUserIcon) {
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
  await Deno.chmod(join(appDir, "AppRun"), 0o755);

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
  await Deno.chmod(launcherPath, 0o755);
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
