/**
 * @module
 * Build client — aio-client standalone Electron connect-page AppImage (Linux only).
 * No Deno binary, no server — pure Electron app for connecting to a remote aio server.
 */
import { BUILD_SCRATCH_DIR } from "../server/app-files.ts";
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
import {
  electronMissingHint,
  ensureHostElectronDist,
} from "./electron-runtime.ts";

/** Build the aio-client AppImage. Exits process on completion or error. */
export async function buildClient(cfg: BuildConfig): Promise<void> {
  const { os, arch, root } = cfg;

  // The standalone connect-page client is packaged as an AppImage and nothing
  // else, so it is Linux-only — a TOOL constraint (`appimagetool`), the same
  // one `crossCompileBlocker` states for the `electron` target's Linux
  // package. The fleet refuses this combination before it gets here; this is
  // the direct-invocation backstop, and it names the way out. (It used to name
  // `compile:electron:remote`, a task spelling retired in alpha52 — advice
  // pointing at a command the project no longer has.)
  if (os !== "linux") {
    console.error(
      `[client] \u2717 the standalone Electron client is packaged as an ` +
        `AppImage, which needs a Linux host — asked for ${cfg.platform}.\n` +
        `        Build the \`electron\` target for a Windows/macOS package ` +
        `(its runtime is a download, so it cross-builds), or run this one on ` +
        `Linux.`,
    );
    Deno.exit(1);
  }

  const appDir = join(root, BUILD_SCRATCH_DIR, "AppDir");
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

  // Copy the Electron runtime — through THE decider, which knows both
  // node_modules layouts and installs one when the host has none. This used to
  // stat `node_modules/electron/dist` and nothing else: on a project whose
  // Electron sits under `node_modules/.deno/electron@<ver>/…` (deno's own
  // layout, and where `deno task install:electron` puts it) the build refused,
  // advising the very command that had already succeeded. `--electron` was
  // fixed for exactly this and `--client` was left behind.
  const electronSrc = await ensureHostElectronDist(root);
  if (electronSrc === null) {
    console.error(`[client] \u2717 ${electronMissingHint()}`);
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
  await chmodIfSupported(join(appDir, "AppRun"), 0o755);

  // Icon \u2014 from THE app-dir decider (cfg.appDir), same place dev reads it
  const { icon: userIcon, misplaced } = await resolveAppIcon(
    cfg.root,
    cfg.appDir,
  );
  if (misplaced) {
    console.warn(`[client] \u26a0 ${misplacedIconHint(misplaced, cfg.appDir)}`);
  }
  if (userIcon) {
    // Outside the stat's catch: an EXISTING icon that fails to copy (EACCES,
    // disk full) is a broken build, never a silent placeholder downgrade.
    await Deno.copyFile(userIcon, join(appDir, "aio-client.png"));
    console.log(`[client] \u2713 icon from ${userIcon}`);
  } else {
    await writeDefaultIcon(join(appDir, "aio-client"), "aio client");
    console.log("[client] \u2713 default icon");
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
  await Deno.mkdir(cfg.outDir ?? root, { recursive: true });
  const appImageOut = join(cfg.outDir ?? root, `aio-client-${arch}.AppImage`);
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
