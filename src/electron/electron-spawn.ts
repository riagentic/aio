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
  try {
    await Deno.stat(electronBin);
    return electronBin;
  } catch { /* not installed yet — try auto-install below */ }

  // 4. Auto-install on first run (machine B5): `deno install` with scripts
  //    allowed for electron runs the postinstall that downloads the binary.
  //    Loud progress; loud failure with the manual command.
  if (await autoInstallElectron(log)) {
    try {
      await Deno.stat(electronBin);
      return electronBin;
    } catch { /* install ran but binary still absent — fall through */ }
  }
  log.error("Electron not found — run: deno task install:electron");

  return null;
}

/** One-shot `deno install --allow-scripts=npm:electron` in the app cwd so
 *  `dev:electron` / `compile:electron` work OUT OF THE BOX on a fresh app —
 *  no separate install step. Returns true when the install command succeeded.
 *  `run` is the command seam (injected in tests; real `deno install` here). */
export async function autoInstallElectron(
  log: { info?: (m: string) => void; error: (m: string) => void },
  run: () => Promise<{ success: boolean }> = () =>
    new Deno.Command(Deno.execPath(), {
      args: ["install", "--allow-scripts=npm:electron"],
      stdout: "inherit",
      stderr: "inherit",
    }).output(),
): Promise<boolean> {
  (log.info ?? console.log)(
    "electron: not installed — auto-installing (deno install --allow-scripts=npm:electron)…",
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
