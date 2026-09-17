/**
 * @module
 * The self-contained Windows desktop exe — one file that runs on a clean
 * machine with no network, the way an AppImage does on Linux.
 *
 * The Windows package used to be a zip (exe + `electron\` folder) plus a bare
 * exe beside it. Double-clicking the bare exe on a real Windows 11 machine
 * started a silent ~100 MB download of the Electron runtime that never
 * finished (2026-09-17). Windows cannot run a program from inside another
 * exe, so this one CARRIES Electron's own published zip in its embedded
 * `dist/` and, on first launch, unpacks it into the per-user runtime cache
 * through the same installer a download uses — lock, integrity check against
 * the checksum this build verified, stamp. Every later launch finds it there.
 */
import { join } from "@std/path";
import type { BuildConfig } from "./build-config.ts";
import { runDenoCompile } from "./build-compile.ts";
import { formatMb } from "./build-helpers.ts";
import {
  ELECTRON_VERSION_FILE,
  electronSlug,
  EMBEDDED_RUNTIME_ZIP,
  ensureElectronZip,
} from "../electron/electron-runtime-fetch.ts";
import { NO, OK } from "../diagnostics/fmt.ts";

/** The self-contained exe's file name — the zip's name with `.exe`, so the
 *  two Windows desktop artifacts sort together and neither is mistaken for
 *  the `browser` target's `<bin>-windows.exe`. Pure. */
export function selfContainedExeName(binaryName: string, archStr: string) {
  return `${binaryName}-win-${archStr}.exe`;
}

/** Compile `<bin>-win-<arch>.exe` with the Electron runtime inside. Exits the
 *  process on failure, like every other packaging step. */
export async function buildSelfContainedWindowsExe(
  cfg: BuildConfig,
): Promise<void> {
  const { root, dist, binaryName, archStr } = cfg;
  const versionFile = join(dist, ELECTRON_VERSION_FILE);
  const original = await Deno.readTextFile(versionFile);
  const { version } = JSON.parse(original) as { version: string };
  const slug = electronSlug({ os: cfg.os, arch: cfg.arch });

  let zip;
  try {
    zip = await ensureElectronZip(version, slug, { log: console.log });
  } catch (e) {
    console.error(`${NO} ${e instanceof Error ? e.message : e}`);
    Deno.exit(1);
  }

  const embedded = join(dist, EMBEDDED_RUNTIME_ZIP);
  const out = join(
    cfg.outDir ?? root,
    selfContainedExeName(binaryName, archStr),
  );
  let ok = false;
  try {
    await Deno.copyFile(zip.path, embedded);
    await Deno.writeTextFile(
      versionFile,
      JSON.stringify({
        version,
        embedded: { name: zip.name, sha256: zip.sha256 },
      }) + "\n",
    );
    console.log(
      `embedding ${zip.name} (${
        formatMb((await Deno.stat(embedded)).size)
      } MB)`,
    );
    ok = await runDenoCompile(cfg, { out });
  } finally {
    // dist/ is embedded WHOLESALE by every compile: nothing of this one may
    // outlive it, or the next target ships a runtime it never asked for.
    await Deno.writeTextFile(versionFile, original);
    await Deno.remove(embedded).catch(() => {
      // aio-ok(silent-catch): best-effort removal of the staged zip in
      // `finally` — its absence is the outcome this wants, and
      // `runDenoCompile` already reported any real failure reason.
    });
  }
  if (!ok) {
    console.error(`${NO} could not compile the self-contained Windows exe`);
    Deno.exit(1);
  }
  console.log(
    `${OK} ${selfContainedExeName(binaryName, archStr)} ` +
      `(${formatMb((await Deno.stat(out)).size)} MB, Electron inside — ` +
      `runs offline on double-click)`,
  );
}
