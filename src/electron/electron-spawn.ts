// Electron binary resolution and process spawning

import type { AioMeta, Log } from "./electron-shared.ts";
import { electronMainScript } from "./electron-scripts.ts";
import { electronClientScript } from "./electron-client-script.ts";
import { electronMainScriptUDS } from "./electron-uds.ts";

// OS-aware packaged Electron binary path
function distBinPath(): string {
  switch (Deno.build.os) {
    case "darwin":
      return "dist/mac/aio-ui-electron.app/Contents/MacOS/aio-ui-electron";
    case "windows":
      return "dist/win-unpacked/aio-ui-electron.exe";
    default:
      return "dist/linux-unpacked/aio-ui-electron";
  }
}

/** Resolves an Electron binary — $ELECTRON_PATH > packaged dist > node_modules dev */
export async function findElectronBin(log: Log): Promise<string | null> {
  // 1. ELECTRON_PATH env var (AppImage / custom deployment)
  const envPath = Deno.env.get("ELECTRON_PATH");
  if (envPath) {
    try {
      await Deno.stat(envPath);
      return envPath;
    } catch {
      log.error(`$ELECTRON_PATH set but not found: ${envPath}`);
    }
  }

  // 2. Packaged binary (electron-builder output)
  const distBin = distBinPath();
  try {
    await Deno.stat(distBin);
    return distBin;
  } catch { /* no packaged binary */ }

  // 3. node_modules dev binary
  const electronBin = Deno.build.os === "windows"
    ? "node_modules\\.bin\\electron.cmd"
    : "node_modules/.bin/electron";
  if (await electronBinReady(electronBin)) return electronBin;

  // 4. Auto-install on first run: `deno install` FORCE-adds electron (positional
  //    `npm:electron`) so `deno task dev` works no matter what — even if the
  //    app never declared electron as a dep. `--allow-scripts=npm:electron`
  //    runs the postinstall that downloads the real binary. Loud progress.
  if (await autoInstallElectron(log)) {
    if (await electronBinReady(electronBin)) return electronBin;
  }
  log.error(
    "Electron could not be installed automatically. Check your network, then " +
      "retry `deno task dev` — or install manually: deno install --allow-scripts=npm:electron npm:electron",
  );

  return null;
}

/** True when the electron launcher exists AND its real binary is downloaded.
 *  `.bin/electron` is created by `deno install` BEFORE the postinstall
 *  downloads the ~100MB binary, so the launcher can exist while the binary is
 *  still missing (a broken launch). We check the launcher resolves to a real
 *  electron dist binary via its `path.txt`. */
async function electronBinReady(launcher: string): Promise<boolean> {
  try {
    await Deno.stat(launcher);
  } catch {
    return false;
  }
  // Find the electron package dir the launcher points into and confirm the
  // downloaded binary exists (path.txt names it, inside dist/).
  try {
    for (
      const base of [
        "node_modules/electron",
        ...(await denoElectronDirs()),
      ]
    ) {
      try {
        const rel = (await Deno.readTextFile(`${base}/path.txt`)).trim();
        await Deno.stat(`${base}/dist/${rel}`);
        return true; // real binary present
      } catch { /* try next candidate */ }
    }
  } catch { /* fall through */ }
  // No path.txt found (older layout) — trust the launcher's existence.
  return true;
}

/** Electron package dirs under Deno's `.deno` npm cache (node_modules/.deno/
 *  electron@<ver>/node_modules/electron). */
async function denoElectronDirs(): Promise<string[]> {
  const dirs: string[] = [];
  try {
    for await (const e of Deno.readDir("node_modules/.deno")) {
      if (e.isDirectory && e.name.startsWith("electron@")) {
        dirs.push(`node_modules/.deno/${e.name}/node_modules/electron`);
      }
    }
  } catch { /* no .deno dir */ }
  return dirs;
}

/** Force-install electron in the app cwd so `dev:electron` / `compile:electron`
 *  work OUT OF THE BOX — even when the app didn't declare electron as a dep.
 *  The positional `npm:electron` adds + installs it; `--allow-scripts` runs its
 *  postinstall (downloads the binary). Returns true when the command succeeded.
 *  `run` is the command seam (injected in tests; real `deno install` here). */
export async function autoInstallElectron(
  log: { info?: (m: string) => void; error: (m: string) => void },
  run: () => Promise<{ success: boolean }> = () =>
    new Deno.Command(Deno.execPath(), {
      args: ["install", "--allow-scripts=npm:electron", "npm:electron"],
      stdout: "inherit",
      stderr: "inherit",
    }).output(),
): Promise<boolean> {
  (log.info ?? console.log)(
    "electron: not installed — auto-installing (deno install --allow-scripts=npm:electron npm:electron)… " +
      "first run downloads the Electron binary (~100MB), this can take a minute.",
  );
  try {
    return (await run()).success;
  } catch {
    return false;
  }
}

/** Writes script to temp file, spawns Electron, cleans up after exit or process unload */
async function spawnElectron(
  bin: string,
  script: string,
  extraArgs: string[] = [],
): Promise<Deno.ChildProcess> {
  const tmpFile = await Deno.makeTempFile({ suffix: ".cjs" });
  await Deno.writeTextFile(tmpFile, script);
  const proc = new Deno.Command(bin, { args: [tmpFile, ...extraArgs] }).spawn();
  const cleanup = () => Deno.remove(tmpFile).catch(() => {});
  // Primary cleanup: after Electron exits normally
  proc.status.then(cleanup);
  // Backup cleanup: covers SIGKILL / host process crash where proc.status never resolves
  addEventListener("unload", cleanup);
  proc.status.then(() => removeEventListener("unload", cleanup));
  return proc;
}

/** Spawns Electron with the main app script */
export async function launchElectron(
  url: string,
  log: Log,
  meta?: AioMeta,
  uds?: {
    socketPath: string;
    baseDir?: string;
    title?: string;
    hasCSS?: boolean;
  },
): Promise<Deno.ChildProcess | null> {
  const bin = await findElectronBin(log);
  if (!bin) return null;
  const mode = bin.includes("node_modules")
    ? "dev"
    : bin.includes("dist")
    ? "packaged"
    : "$ELECTRON_PATH";
  const transport = uds ? "UDS" : "WS";
  log.info(`launching Electron (${mode}, ${transport})`);
  const script = uds
    ? electronMainScriptUDS(url, uds.socketPath, {
      baseDir: uds.baseDir,
      title: uds.title,
      hasCSS: uds.hasCSS,
      meta,
    })
    : electronMainScript(url, meta);
  return spawnElectron(bin, script);
}

/** Launches Electron with the client connect-page script (no server needed) */
export async function launchElectronClient(
  log: Log,
  url?: string,
): Promise<Deno.ChildProcess | null> {
  const bin = await findElectronBin(log);
  if (!bin) return null;
  const args = url ? [`--server-url=${url}`] : [];
  log.info(`launching aio client${url ? ` → ${url}` : ""}`);
  return spawnElectron(bin, electronClientScript(), args);
}
