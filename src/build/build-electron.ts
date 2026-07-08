/**
 * @module
 * Build Electron — packages the compiled Deno binary + Electron runtime into
 * a platform-native distributable (AppImage on Linux, zip on Windows/macOS).
 */
import { join } from "@std/path";
import {
  copyDir,
  ensureAppimagetool,
  formatMb,
  writePlaceholderIcon,
} from "./build-helpers.ts";
import type { BuildConfig } from "./build-config.ts";

/** Package the Electron app for the current platform. Exits process on completion or error. */
export async function buildElectron(cfg: BuildConfig): Promise<void> {
  const { root, dist, binaryName, appTitle, os, arch, archStr } = cfg;

  const appDir = join(dist, "AppDir");

  // Copy dist/ assets into AppDir/dist/ (Electron can't read Deno's embedded VFS)
  const appDirDist = join(appDir, "dist");
  await Deno.mkdir(appDirDist, { recursive: true });
  for (const name of ["app.js", "style.css", "icon.png"]) {
    try {
      await Deno.copyFile(join(dist, name), join(appDirDist, name));
    } catch { /* optional file */ }
  }
  console.log("[electron] \u2713 dist/ assets copied to AppDir/dist/");

  // Copy Electron runtime
  const electronSrc = join(root, "node_modules", "electron", "dist");
  const electronDst = join(appDir, "electron");
  try {
    await Deno.stat(electronSrc);
  } catch {
    console.error(
      "[electron] \u2717 node_modules/electron/dist/ not found — run: deno task install:electron",
    );
    Deno.exit(1);
  }
  console.log("[electron] copying Electron runtime...");
  await copyDir(electronSrc, electronDst);
  console.log("[electron] \u2713 electron/ copied");

  // Icon
  const userIcon = join(root, "src", "icon.png");
  try {
    await Deno.stat(userIcon);
    await Deno.copyFile(userIcon, join(appDir, `${binaryName}.png`));
    console.log("[electron] \u2713 icon from src/icon.png");
  } catch {
    await writePlaceholderIcon(join(appDir, `${binaryName}.svg`), binaryName);
    console.log("[electron] \u2713 generated placeholder icon");
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

  const toolPath = await ensureAppimagetool(
    arch,
    join(root, "node_modules", ".cache"),
  );

  const appImageOut = join(root, `${binaryName}-${arch}.AppImage`);
  console.log("[appimage] packaging...");
  const appimageResult = await new Deno.Command(toolPath, {
    args: [appDir, appImageOut],
    stdout: "inherit",
    stderr: "inherit",
    env: { ...Deno.env.toObject(), ARCH: arch },
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

  const zipOut = join(root, `${binaryName}-win-${archStr}.zip`);
  console.log("[electron] zipping Windows package...");
  const zipResult = await new Deno.Command("powershell", {
    args: [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path "${appDir}\\*" -DestinationPath "${zipOut}" -Force`,
    ],
    stdout: "inherit",
    stderr: "inherit",
  }).output();

  if (zipResult.code !== 0) {
    console.error("[electron] \u2717 Compress-Archive failed");
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

  const zipOut = join(root, `${binaryName}-mac-${archStr}.zip`);
  console.log("[electron] zipping macOS package...");
  const zipResult = await new Deno.Command("zip", {
    args: ["-r", zipOut, "."],
    cwd: appDir,
    stdout: "inherit",
    stderr: "inherit",
  }).output();

  if (zipResult.code !== 0) {
    console.error("[electron] \u2717 zip failed");
    Deno.exit(1);
  }

  const zipStat = await Deno.stat(zipOut);
  console.log(
    `[electron] \u2713 ${binaryName}-mac-${archStr}.zip (${
      formatMb(zipStat.size)
    } MB)`,
  );
}
