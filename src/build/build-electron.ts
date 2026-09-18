/**
 * @module
 * Build Electron — packages the compiled Deno binary + Electron runtime into a
 * platform-native distributable: an AppImage on Linux, a zip on Windows, and a
 * real `.app` (in a `.dmg`, or a zip of the bundle when no Mac is available) on
 * macOS. See `macos-app.ts` for the bundle and `dmg.ts` for the disk image.
 */
import { dirname, join } from "@std/path";
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
import { assembleMacApp, icnsFromName, icnsFromPng } from "./macos-app.ts";
import { trimLocalePaks } from "./electron-locales.ts";
import {
  canFinalizeDmg,
  dmgDone,
  finalizeMacDmg,
  MACOS_HOST_ENV,
  noDmgWarning,
} from "./dmg.ts";
import {
  electronMissingHint,
  ensureElectronDist,
  localElectronDistFor,
  reportElectronDrift,
  resolveElectronVersion,
} from "./electron-runtime.ts";
import {
  APP_ICON,
  APP_STYLE,
  BUILD_SCRATCH_DIR,
  BUNDLE_JS,
  DIST_DIR,
} from "../server/app-files.ts";
import { HEY, NO, OK } from "../diagnostics/fmt.ts";

/** Zip a directory's CONTENTS, portably.
 *
 *  `zip -y` keeps symlinks as links, which matters for macOS: Electron.app's
 *  Frameworks are a web of them, and a package that resolved them into copies
 *  is both enormous and subtly broken. PowerShell's Compress-Archive is the
 *  fallback (Windows hosts without `zip`), and it is no longer the only way —
 *  that was what made a Windows package a Windows-only act. */
async function zipDir(dir: string, out: string): Promise<boolean> {
  // `zip -r` UPDATES an existing archive: entries the tree no longer has stay
  // in it. A previous build's zip therefore carried its files into this one
  // however clean the staging dir was. Only absence is fine.
  await Deno.remove(out).catch((e) => {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  });
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
        `${HEY} ${cmd}: ${
          new TextDecoder().decode(r.stderr).trim().split("\n")[0] ?? ""
        }`,
      );
    } catch { /* not installed — try the next */ }
  }
  console.error(
    `${NO} neither \`zip\` nor PowerShell could pack it — install zip ` +
      "(Debian/Ubuntu: sudo apt install zip)",
  );
  return false;
}

/** Where every Electron package is assembled before it is packed. */
export function electronStagingDir(root: string): string {
  return join(root, BUILD_SCRATCH_DIR, "AppDir");
}

/** Empty the staging dir — FRESH per build, never merely ensured. Every
 *  platform stages into this one directory and `buildElectron` packs it
 *  wholesale, so a kept tree carried the previous platform into the next
 *  package: a Windows zip that shipped the Linux Electron and the Linux binary
 *  beside its own (350 MB instead of ~160). Only absence is fine; a tree that
 *  cannot be removed is a package that cannot be trusted. */
export async function freshElectronStaging(root: string): Promise<string> {
  const dir = electronStagingDir(root);
  await Deno.remove(dir, { recursive: true }).catch((e) => {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  });
  await Deno.mkdir(dir, { recursive: true });
  return dir;
}

/** An executable's container format, from its first four bytes. */ export type BinaryFormat =
  | "elf"
  | "pe"
  | "macho";

/** The format a platform's executables use, keyed by `Deno.build.os`. */
const NATIVE_FORMAT: Readonly<Record<string, BinaryFormat>> = {
  linux: "elf",
  windows: "pe",
  darwin: "macho",
};

/** Which executable format `head` starts with, or null for anything else.
 *  Mach-O covers thin 32/64-bit (either byte order) and fat/universal. Pure. */
export function binaryFormat(head: Uint8Array): BinaryFormat | null {
  const [a = -1, b = -1, c = -1, d = -1] = head;
  if (a === 0x4d && b === 0x5a) return "pe";
  if (d < 0) return null;
  const m = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  if (m === 0x7f454c46) return "elf";
  if (
    m === 0xfeedface || m === 0xfeedfacf || m === 0xcefaedfe ||
    m === 0xcffaedfe || m === 0xcafebabe || m === 0xbebafeca
  ) return "macho";
  return null;
}

/** Every executable under `dir` whose format is not `os`'s own, as paths
 *  relative to `dir`. Symlinks are not followed (a macOS framework is full of
 *  them, and they point inside the tree anyway). */
export async function foreignBinaries(
  dir: string,
  os: string,
): Promise<{ path: string; format: BinaryFormat }[]> {
  const native = NATIVE_FORMAT[os];
  if (!native) throw new Error(`foreignBinaries: unknown os "${os}"`);
  const out: { path: string; format: BinaryFormat }[] = [];
  const walk = async (rel: string): Promise<void> => {
    for await (const e of Deno.readDir(join(dir, rel))) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) await walk(p);
      else if (e.isFile) {
        const f = await Deno.open(join(dir, p));
        const head = new Uint8Array(4);
        const n = await f.read(head).finally(() => f.close());
        const format = binaryFormat(head.subarray(0, n ?? 0));
        if (format && format !== native) out.push({ path: p, format });
      }
    }
  };
  await walk("");
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Package the Electron app for the current platform. Exits process on completion or error. */
export async function buildElectron(cfg: BuildConfig): Promise<void> {
  const { root, dist, binaryName, appTitle, os, arch, archStr } = cfg;

  const appDir = electronStagingDir(root);

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
        `${NO} ${join(dist, name)} missing — bundle step did not produce it`,
      );
      Deno.exit(1);
    }
    if (exists) await Deno.copyFile(join(dist, name), join(appDirDist, name));
  }
  console.log(`${OK} dist/ assets copied to AppDir/dist/`);

  // Copy Electron runtime — auto-install on first build so `--electron` works
  // OUT OF THE BOX; loud manual fallback if it fails.
  //
  // ONE version decider for the whole package: `resolveElectronVersion` is the
  // SAME call `build.ts` uses to bake `dist/electron.json`, and the runtime is
  // then taken for exactly that version. It used to take the host runtime from
  // node_modules and, separately, the target runtime from the baked version —
  // so a stale `node_modules/electron` (a package.json whose `dist/` was
  // deleted, or a rewrite by `deno install`) made the zip ship one Electron
  // while the self-contained exe carried another (real Windows 11,
  // 2026-09-17).
  const version = await resolveElectronVersion(root);
  await reportElectronDrift(root, (m) => console.warn(`${HEY} ${m}`));
  // A local node_modules runtime is used ONLY when it IS that version, so an
  // offline build still works and a stale one cannot slip in beside the baked
  // version. Anything else is fetched for the platform (a download, which the
  // per-user cache makes once).
  const host = isHostPlatform(cfg.platform)
    ? await localElectronDistFor(version, root)
    : null;
  let electronSrc: string | null;
  if (host) {
    console.log(`copying Electron runtime ${version} from node_modules...`);
    electronSrc = host;
  } else {
    try {
      electronSrc = await ensureElectronDist(version, cfg.platform);
    } catch (e) {
      console.error(`${NO} ${e instanceof Error ? e.message : e}`);
      Deno.exit(1);
    }
  }
  const electronDst = join(appDir, "electron");
  if (electronSrc === null) {
    console.error(`${NO} ${electronMissingHint()}`);
    Deno.exit(1);
  }
  console.log(`copying Electron runtime ${version}...`);
  await copyDir(electronSrc, electronDst);
  console.log(`${OK} electron/ copied`);

  // Trim Chromium's translations — ~46 MB on Linux/Windows, ~66 MB on macOS,
  // and the largest safe saving in every desktop package. The app's own text is
  // in the Deno bundle; a missing locale falls back to English, so the worst
  // case is Chromium's menus in English.
  //
  // macOS keeps its locales inside the Electron.app as `.lproj` directories, so
  // the trim for that platform happens in `assembleMacApp` (against the bundle
  // it is building); here we handle the flat `locales/*.pak` layout that Linux
  // and Windows use. One of the two always applies, and a runtime with neither
  // simply trims zero.
  const trimmed = cfg.os === "darwin"
    ? 0 // done in assembleMacApp, once the bundle exists
    : trimLocalePaks(join(electronDst, "locales"));
  if (trimmed > 0) {
    console.log(`${OK} trimmed ${trimmed} unused locale(s) from the runtime`);
  }

  // Icon \u2014 from THE app-dir decider (cfg.appDir), same place dev reads it
  const { icon: userIcon, misplaced } = await resolveAppIcon(
    cfg.root,
    cfg.appDir,
  );
  if (misplaced) {
    console.warn(
      `${HEY} ${misplacedIconHint(misplaced, cfg.appDir)}`,
    );
  }
  if (userIcon) {
    // Outside the stat's catch: an EXISTING icon that fails to copy (EACCES,
    // disk full) is a broken build, never a silent placeholder downgrade.
    await Deno.copyFile(userIcon, join(appDir, `${binaryName}.png`));
    console.log(`${OK} icon from ${userIcon}`);
  } else {
    // The app ships no icon — generate its monogram rather than the same flat
    // square every icon-less app used to get. Three running aio apps must be
    // three distinguishable entries in a taskbar, which is the whole job an
    // icon does before someone draws a real one.
    await writeDefaultIcon(join(appDir, binaryName), appTitle ?? binaryName);
    console.log(
      `${OK} default icon for "${appTitle ?? binaryName}"`,
    );
  }

  const displayName = (appTitle ?? binaryName).replace(
    // deno-lint-ignore no-control-regex
    /[\x00-\x1f\x7f\r\n]/g,
    "",
  );

  // A package holds ONE platform's executables. Checked on the finished tree,
  // not assumed from how it was assembled: a stale staging dir once shipped
  // the Linux Electron inside the Windows zip, and every Linux-host gate was
  // green because nothing ever looked inside.
  const foreign = await foreignBinaries(appDir, os);
  if (foreign.length > 0) {
    console.error(
      `${NO} the ${cfg.platform} package holds executables for another ` +
        `platform:\n` +
        foreign.map((f) => `      ${f.path} (${f.format})`).join("\n") +
        `\n      Refusing to ship it. Remove ${appDir} and rebuild; if they ` +
        `come back, the step that copies them is the bug.`,
    );
    Deno.exit(1);
  }

  if (os === "linux") {
    await _packageLinux(cfg, appDir, displayName, arch, root, binaryName);
  } else if (os === "windows") {
    await _packageWindows(cfg, appDir, displayName, archStr, root, binaryName);
  } else if (os === "darwin") {
    await _packageMacos(cfg, appDir, archStr, root, binaryName);
  } else {
    console.error(`${NO} unsupported platform: ${os}`);
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
      `${NO} \`file\` is not installed, and appimagetool requires it.\n` +
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
  console.log(`packaging...`);
  const appimageResult = await new Deno.Command(toolPath, {
    args: [appDir, appImageOut],
    stdout: "inherit",
    stderr: "inherit",
    env: appimageEnv(arch), // FUSE-less hosts — see appimageEnv
  }).output();

  if (appimageResult.code !== 0) {
    console.error(`${NO} appimagetool failed`);
    Deno.exit(1);
  }

  const appImageStat = await Deno.stat(appImageOut);
  console.log(
    `${OK} ${binaryName}-${arch}.AppImage (${formatMb(appImageStat.size)} MB)`,
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
  // `start ""` returns at once, so the launcher's own console closes instead
  // of sitting behind the window (the exe itself is a GUI program).
  const launcher = `@echo off
SET HERE=%~dp0
SET ELECTRON_PATH=%HERE%electron\\electron.exe
start "" "%HERE%${binaryName}.exe" %*
`;
  await Promise.all([
    Deno.writeTextFile(join(appDir, "run.bat"), launcher),
    Deno.writeTextFile(
      join(appDir, "README.txt"),
      `${displayName}\n\nRun: double-click run.bat or ${binaryName}.exe\n`,
    ),
  ]);
  console.log(`${OK} run.bat launcher`);

  await Deno.mkdir(cfg.outDir ?? root, { recursive: true });
  const zipOut = join(cfg.outDir ?? root, `${binaryName}-win-${archStr}.zip`);
  console.log(`zipping Windows package...`);
  // `zip` first, PowerShell second: Compress-Archive exists only on Windows,
  // and that single call was the whole reason a Windows package could not be
  // built anywhere else.
  if (!await zipDir(appDir, zipOut)) {
    console.error(`${NO} could not zip the Windows package`);
    Deno.exit(1);
  }

  const zipStat = await Deno.stat(zipOut);
  console.log(
    `${OK} ${binaryName}-win-${archStr}.zip (${formatMb(zipStat.size)} MB)`,
  );
}

/** macOS: assemble a real `.app`, then deliver it as a `.dmg` (a Mac was
 *  reachable) or a `.zip` of the bundle (none was).
 *
 *  What this REPLACED: a zip holding the Deno binary next to a pristine
 *  `Electron.app` still named "Electron" and still signed as
 *  `com.github.Electron` — no `.app`, no Dock identity, no icon, a
 *  Gatekeeper-blocking archive.
 *
 *  **Both outcomes are a single collectable FILE**, which is not a detail: the
 *  `.app` is a directory, and the fleet collects files. A version of this that
 *  returned after assembling only the directory made `--targets=electron
 *  --platforms=macos` fail with "produced no recognized artifact" on every
 *  host without a Mac — the build worked and reported failure.
 *
 *  | A Mac | Artifact | Why |
 *  | ----- | -------- | --- |
 *  | reachable (native or `AIO_MACOS_SSH`) | `<bin>-mac-<arch>.dmg` | signed, drag-to-Applications |
 *  | none | `<bin>-mac-<arch>.zip` | the unsigned `.app`, zipped |
 *
 *  The DMG is preferred because it is what a macOS user expects and it is the
 *  only path that SIGNS the bundle. Apple Silicon refuses to execute an
 *  unsigned arm64 binary, and editing the nested `Info.plist` invalidates
 *  Electron's shipped signature, so an unsigned arm64 `.app` is a real
 *  limitation — which is why the zip path WARNS rather than pretending. */
async function _packageMacos(
  cfg: BuildConfig,
  appDir: string,
  archStr: string,
  root: string,
  binaryName: string,
): Promise<void> {
  const outDir = cfg.outDir ?? root;
  await Deno.mkdir(outDir, { recursive: true });

  const displayName = (cfg.appTitle ?? binaryName).replace(
    // deno-lint-ignore no-control-regex
    /[\x00-\x1f\x7f\r\n]/g,
    "",
  );
  // A version Electron/macOS will accept: `0.1.0-nogit.2bfe7cce` is a legal
  // bundle version once the build metadata is dropped.
  const bundleVersion = cfg.version.version.split("+")[0]!
    .replace(/[^0-9A-Za-z.].*$/, "") || "0.0.0";

  // The icon: the app's own `icon.png` when it is a square PNG, else its
  // generated monogram — the SAME identity every other target shows.
  const { icon: userIcon } = await resolveAppIcon(cfg.root, cfg.appDir);
  let icns: Uint8Array | null = null;
  if (userIcon) {
    icns = icnsFromPng(await Deno.readFile(userIcon));
    if (icns === null) {
      console.warn(
        `${HEY} ${userIcon} is not a square PNG, so the app's generated ` +
          `monogram is used for the macOS icon instead. Provide a square ` +
          `icon.png (512x512 is the convention).`,
      );
    }
  }
  if (icns === null) icns = await icnsFromName(displayName);

  // Assembled into the build SCRATCH, never the output dir: a `.app` is a
  // 300 MB directory, and the artifact this target ships is the ONE file that
  // wraps it. Leaving the loose bundle in `dist/` would also put a directory
  // where the fleet expects a release file.
  const scratch = join(root, BUILD_SCRATCH_DIR);
  await Deno.mkdir(scratch, { recursive: true });
  console.log(`assembling ${displayName}.app...`);
  const app = await assembleMacApp({
    stagedDir: appDir,
    outDir: scratch,
    name: displayName,
    binaryName,
    identifier: cfg.macBundleId,
    version: bundleVersion,
    iconIcns: icns,
  });
  const appSize = await dirSize(app);
  console.log(`${OK} ${displayName}.app (${formatMb(appSize)} MB)`);

  if (canFinalizeDmg(cfg.macosHost)) {
    const dmgOut = join(outDir, `${binaryName}-mac-${archStr}.dmg`);
    console.log(`building the .dmg...`);
    try {
      await finalizeMacDmg({
        appPath: app,
        outPath: dmgOut,
        volumeName: displayName,
        binaryName,
        declaredHost: cfg.macosHost,
      });
    } catch (e) {
      // A configured Mac that fails is a real failure, not a reason to pretend:
      // the message names the host and the ssh command to check.
      console.error(`${NO} ${e instanceof Error ? e.message : e}`);
      Deno.exit(1);
    }
    const stat = await Deno.stat(dmgOut);
    console.log(
      dmgDone(`${binaryName}-mac-${archStr}.dmg`, formatMb(stat.size)),
    );
    return;
  }

  // No Mac: a `.zip` of the `.app` (symlinks preserved) is the collectable,
  // mount-free deliverable. It is UNSIGNED — say so, because on Apple Silicon
  // that is the difference between an app that opens and one that does not.
  const zipOut = join(outDir, `${binaryName}-mac-${archStr}.zip`);
  console.log(`no Mac available — zipping the .app instead of a .dmg...`);
  if (!await zipAppBundle(app, zipOut)) {
    console.error(`${NO} could not zip the macOS .app bundle`);
    Deno.exit(1);
  }
  console.warn(`${HEY} ${noDmgWarning()}`);
  const zstat = await Deno.stat(zipOut);
  console.log(
    `${OK} ${binaryName}-mac-${archStr}.zip (${formatMb(zstat.size)} MB, ` +
      `UNSIGNED — Apple Silicon will refuse it until it is ad-hoc signed)`,
  );
}

/** Zip a `.app` bundle so the BUNDLE ITSELF is the archive's top entry.
 *
 *  Distinct from {@link zipDir}, which zips a directory's CONTENTS: a macOS
 *  `.app` only works when it is unzipped AS a bundle, so the archive must carry
 *  `Counter.app/…`, not `Contents/…`. `-y` keeps Electron's framework symlinks
 *  as links — resolving them into copies is both enormous and subtly broken. */
async function zipAppBundle(appPath: string, out: string): Promise<boolean> {
  await Deno.remove(out).catch((e) => {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  });
  try {
    const r = await new Deno.Command("zip", {
      args: [
        "-r",
        "-y",
        "-q",
        out,
        appPath.slice(appPath.lastIndexOf("/") + 1),
      ],
      cwd: dirname(appPath),
      stdout: "null",
      stderr: "piped",
    }).output();
    if (r.success) return true;
    console.error(
      `${HEY} zip: ${
        new TextDecoder().decode(r.stderr).trim().split("\n")[0] ?? ""
      }`,
    );
  } catch {
    // aio-ok: `zip` not installed — the message below names the package to
    // install and the alternative (configure a Mac), which is the whole point.
  }
  console.error(
    `${NO} \`zip\` is needed to package the macOS .app on a host without a ` +
      `Mac (Debian/Ubuntu: sudo apt install zip) — or configure a Mac with ` +
      `${MACOS_HOST_ENV} to produce a .dmg instead.`,
  );
  return false;
}

/** Recursive byte size of a directory. */
async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for await (const e of Deno.readDir(dir)) {
    const p = join(dir, e.name);
    if (e.isDirectory) total += await dirSize(p);
    else if (e.isFile) total += (await Deno.stat(p)).size;
  }
  return total;
}
