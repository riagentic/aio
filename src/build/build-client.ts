/**
 * @module
 * Build client — aio-client standalone Electron connect-page AppImage (Linux only).
 * No Deno binary, no server — pure Electron app for connecting to a remote aio server.
 */
import { join } from "@std/path";
import {
  appimageEnv,
  copyDir,
  ensureAppimagetool,
  formatMb,
  toolCacheDir,
  writePlaceholderIcon,
} from "./build-helpers.ts";
import type { BuildConfig } from "./build-config.ts";

/** Build the aio-client AppImage. Exits process on completion or error. */
export async function buildClient(cfg: BuildConfig): Promise<void> {
  const { os, arch, root, dist } = cfg;

  if (os !== "linux") {
    console.error(
      `[client] \u2717 compile:electron:remote only supported on Linux — use CI for other platforms`,
    );
    Deno.exit(1);
  }

  const appDir = join(dist, "AppDir");
  try {
    await Deno.remove(appDir, { recursive: true });
  } catch { /* no previous — skip */ }
  await Deno.mkdir(appDir, { recursive: true });

  // Generate client main.cjs
  const { electronClientScript } = await import("../electron/electron.ts");
  // The address the build already knows, handed to the artifact instead of
  // being printed and forgotten.
  const clientScript = electronClientScript(cfg.bakedServer);
  if (cfg.bakedServer) {
    console.log(`[client] \u2713 default server ${cfg.bakedServer}`);
  }
  await Deno.writeTextFile(join(appDir, "main.cjs"), clientScript);
  console.log("[client] \u2713 main.cjs");

  // Copy Electron runtime
  const electronSrc = join(root, "node_modules", "electron", "dist");
  try {
    await Deno.stat(electronSrc);
  } catch {
    console.error(
      "[client] \u2717 node_modules/electron/dist/ not found — run: deno task install:electron",
    );
    Deno.exit(1);
  }

  console.log("[client] copying Electron runtime...");
  await copyDir(electronSrc, join(appDir, "electron"));
  console.log("[client] \u2713 electron/ copied");

  // AppRun — launches electron directly (no Deno binary)
  const appRun = `#!/bin/bash
HERE="$(dirname "$(readlink -f "$0")")"
exec "$HERE/electron/electron" "$HERE/main.cjs" "$@"
`;
  await Deno.writeTextFile(join(appDir, "AppRun"), appRun);
  await Deno.chmod(join(appDir, "AppRun"), 0o755);

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
    await Deno.copyFile(userIcon, join(appDir, "aio-client.png"));
    console.log(`[client] \u2713 icon from ${userIcon}`);
  } else {
    await writePlaceholderIcon(join(appDir, "aio-client.svg"), "aio");
    console.log("[client] \u2713 generated placeholder icon");
  }

  // .desktop file
  const desktop = `[Desktop Entry]
Type=Application
Name=aio
Exec=aio-client
Icon=aio-client
Categories=Utility;
`;
  await Deno.writeTextFile(join(appDir, "aio-client.desktop"), desktop);

  // Download appimagetool if needed
  const toolPath = await ensureAppimagetool(arch, toolCacheDir());

  // Build AppImage
  const appImageOut = join(root, `aio-client-${arch}.AppImage`);
  console.log("[appimage] packaging aio-client...");
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
    `[appimage] \u2713 aio-client-${arch}.AppImage (${
      formatMb(appImageStat.size)
    } MB)`,
  );
  Deno.exit(0);
}
