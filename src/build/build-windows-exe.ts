/**
 * @module
 * The one-click Windows desktop `.exe` — an SFX / thin installer whose
 * download size tracks (and now beats) the Windows zip, instead of a fat Deno
 * PE with an embedded raw Electron zip.
 *
 * ## Why SFX (Task1 / optimal-builds §1.3 Option A)
 *
 * The previous path re-`deno compile`d with Electron's published zip staged as
 * `dist/electron-runtime.zip`. Deno's VFS stores that zip **verbatim** inside
 * an already-uncompressed PE, so the download was ≈ (zip's Deno PE) + (Electron
 * release zip) ≈ **2× the Windows zip**. Offline double-click was correct;
 * paying twice for lack of outer compression was not.
 *
 * ## What this builds
 *
 * After `buildElectron` stages the AppDir, this concatenates:
 *
 *   [tiny prebuilt stub PE (~3.5 MB)] + [payload] + [JSON hdr] + [lengths] + [magic]
 *
 * into `<bin>-win-<arch>.exe`. The stub (see `windows-sfx-stub/`) extracts the
 * payload once into `%LOCALAPPDATA%\aio-sfx\<bin>\win-<arch>\`, verifies the
 * payload's SHA-256, stamps it, and launches the inner `<bin>.exe` with
 * `ELECTRON_PATH` set — same layout and fuse-off Electron as unzipping the zip
 * today. Second launch skips extract when the stamp matches. No network.
 *
 * ## The payload: zstd-compressed tar, packed by Deno (no Go)
 *
 * The stub extracts any payload, so the `.exe` need not reuse the `.zip`'s
 * deflate. The default payload is a **zstd-compressed tar of the AppDir**,
 * produced by {@link packAppDirTarZstd} — `@std/tar` piped through Deno's
 * `node:zlib` `createZstdCompress` — measured ~14% smaller than the zip on a
 * reference Electron tree, and zstd decompresses faster than deflate, so first
 * launch is faster too. Building it needs **no Go**: the extractor stub is a
 * committed prebuilt PE ({@link ensureWindowsSfxStub}) and the compression runs
 * in Deno. The `.zip` artifact is unchanged (Windows users unzip it with
 * Explorer); if packing fails, the exe falls back to the zip payload
 * (`format: "zip"`) — larger, never broken.
 *
 * Ship still labels the PE as install kind `binary` (updates replace the SFX).
 *
 * Emergency rollback: `AIO_WINDOWS_FAT_EXE=1` restores the old embedded-runtime
 * `deno compile` path (gated; not the default).
 */
import { dirname, join, relative } from "@std/path";
import { TarStream, type TarStreamInput } from "@std/tar";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import type { BuildConfig } from "./build-config.ts";
import { electronStagingDir } from "./build-electron.ts";
import { runDenoCompile } from "./build-compile.ts";
import { ensureHeadroom } from "./freeze-guard.ts";
import { formatMb } from "./build-helpers.ts";
import { sha256Hex } from "./ship.ts";
import {
  ELECTRON_VERSION_FILE,
  electronSlug,
  EMBEDDED_RUNTIME_ZIP,
  ensureElectronZip,
} from "../electron/electron-runtime-fetch.ts";
import { HEY, NO, OK } from "../diagnostics/fmt.ts";

/** Magic trailer the stub and the packer agree on. Keep in sync with
 *  `windows-sfx-stub/format.go`. `AIOSFX01` was a bare zip payload; `AIOSFX02`
 *  is a zstd tar (the stub still extracts a `zip` payload for old artifacts). */
export const SFX_MAGIC = "AIOSFX02";

/** Payload kinds the stub understands. */
export type SfxFormat = "tar.zstd" | "zip";

/** The self-contained exe's file name — the zip's name with `.exe`, so the
 *  two Windows desktop artifacts sort together and neither is mistaken for
 *  the `browser` target's `<bin>-windows.exe`. Pure. */
export function selfContainedExeName(binaryName: string, archStr: string) {
  return `${binaryName}-win-${archStr}.exe`;
}

/** Zip path `_packageWindows` already wrote. Pure. */
export function windowsZipName(binaryName: string, archStr: string) {
  return `${binaryName}-win-${archStr}.zip`;
}

/** JSON header embedded in the SFX trailer. */
export type SfxHeader = {
  sha256: string;
  binary: string;
  arch: string;
  /** `"tar.zstd"` (default) or `"zip"` (fallback / pre-AIOSFX02). */
  format: SfxFormat;
};

/** Append a payload + trailer onto a stub PE. Pure bytes → bytes.
 *
 *  Trailer (end of file): payload | JSON | u32 hdrLen | u64 payloadLen | magic. */
export function appendSfxPayload(
  stub: Uint8Array,
  payload: Uint8Array,
  header: SfxHeader,
): Uint8Array {
  const hdr = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(
    stub.length + payload.length + hdr.length + 4 + 8 + SFX_MAGIC.length,
  );
  let o = 0;
  out.set(stub, o);
  o += stub.length;
  out.set(payload, o);
  o += payload.length;
  out.set(hdr, o);
  o += hdr.length;
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(o, hdr.length, true);
  o += 4;
  // payload length as u64 LE
  const payloadLen = payload.length;
  view.setUint32(o, payloadLen >>> 0, true);
  view.setUint32(o + 4, Math.floor(payloadLen / 0x100000000), true);
  o += 8;
  out.set(new TextEncoder().encode(SFX_MAGIC), o);
  return out;
}

/** Parse an SFX trailer from the end of `bytes`. Returns null when not an
 *  aio SFX (no magic). Used by tests / size gates. */
export function readSfxTrailer(bytes: Uint8Array): {
  header: SfxHeader;
  payloadOffset: number;
  payloadLength: number;
} | null {
  const mag = SFX_MAGIC.length;
  if (bytes.length < mag + 8 + 4) return null;
  const end = bytes.length;
  const magicBytes = bytes.subarray(end - mag);
  if (new TextDecoder().decode(magicBytes) !== SFX_MAGIC) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lenLo = view.getUint32(end - mag - 8, true);
  const lenHi = view.getUint32(end - mag - 4, true);
  const payloadLength = lenLo + lenHi * 0x100000000;
  const hdrLen = view.getUint32(end - mag - 8 - 4, true);
  if (hdrLen === 0 || hdrLen > 1 << 20) return null;
  const hdrOff = end - mag - 8 - 4 - hdrLen;
  const payloadOffset = hdrOff - payloadLength;
  if (payloadOffset < 0 || hdrOff < 0) return null;
  const header = JSON.parse(
    new TextDecoder().decode(bytes.subarray(hdrOff, hdrOff + hdrLen)),
  ) as SfxHeader;
  if (!header.format) header.format = "zip"; // pre-AIOSFX02 headers
  return { header, payloadOffset, payloadLength };
}

/** True when `bytes` look like a PE that embeds `electron-runtime.zip` as a
 *  Deno VFS file name — the old fat path. Size-regression / packaging gate. */
export function peEmbedsElectronRuntimeZip(bytes: Uint8Array): boolean {
  // Deno VFS records the file name as JSON text inside the PE.
  const needle = new TextEncoder().encode('"electron-runtime.zip"');
  return indexOfBytes(bytes, needle) >= 0;
}

function indexOfBytes(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** Directory holding the SFX stub source and the committed prebuilt PE (next
 *  to this module). */
export function windowsSfxStubDir(): string {
  return join(dirname(new URL(import.meta.url).pathname), "windows-sfx-stub");
}

/** The committed Windows stub — a prebuilt PE, so building the one-click `.exe`
 *  needs no Go toolchain on the build host. Rebuilt only when the stub's source
 *  changes; see `windows-sfx-stub/README.md`. */
export function prebuiltStubPath(): string {
  return join(
    windowsSfxStubDir(),
    "prebuilt",
    "aio-windows-sfx-stub-amd64.exe",
  );
}

/** The prebuilt Windows stub, verified to be a PE. Throws with the fix when it
 *  is missing or truncated (a checkout that dropped the committed binary). */
export async function ensureWindowsSfxStub(): Promise<string> {
  const path = prebuiltStubPath();
  let st: Deno.FileInfo;
  try {
    st = await Deno.stat(path);
  } catch {
    throw new Error(
      `the prebuilt Windows SFX stub is missing: ${path}\n` +
        `       it is committed to the repo (see windows-sfx-stub/README.md); ` +
        `restore it from git, or rebuild it and commit the result.`,
    );
  }
  if (!st.isFile || st.size < 100_000) {
    throw new Error(`the prebuilt Windows SFX stub looks truncated: ${path}`);
  }
  const head = new Uint8Array(2);
  const f = await Deno.open(path, { read: true });
  try {
    await f.read(head);
  } finally {
    f.close();
  }
  // "MZ" — every Windows PE begins with the DOS stub signature.
  if (head[0] !== 0x4d || head[1] !== 0x5a) {
    throw new Error(`the prebuilt Windows SFX stub is not a PE: ${path}`);
  }
  return path;
}

/** Every entry under `dir`, depth-first, as `@std/tar` inputs (paths relative
 *  to `root`). Symlinks and devices are refused — a Windows AppDir has none,
 *  and silently dropping a file the app needs is worse. */
async function* tarEntries(
  root: string,
  dir: string,
): AsyncGenerator<TarStreamInput> {
  for await (const e of Deno.readDir(dir)) {
    const full = join(dir, e.name);
    const rel = relative(root, full);
    if (e.isDirectory) {
      yield { type: "directory", path: rel };
      yield* tarEntries(root, full);
    } else if (e.isFile) {
      const st = await Deno.stat(full);
      yield {
        type: "file",
        path: rel,
        size: st.size,
        readable: (await Deno.open(full)).readable,
      };
    } else {
      throw new Error(
        `unsupported file type (not a regular file): ${rel} — a Windows ` +
          `AppDir has no symlinks or devices`,
      );
    }
  }
}

/** `ZSTD_c_compressionLevel` (zstd.h). Deno's bundled `node:zlib` types predate
 *  the zstd API, so the enum member is not declared; the value is stable. */
const ZSTD_C_COMPRESSION_LEVEL = 100;

/** Pack `dir` into a **zstd-compressed tar** at `outPath`, entirely in Deno:
 *  `@std/tar` → `node:zlib`'s `createZstdCompress` at maximum compression.
 *  No Go, no host packer binary. Entries stream lazily, so only one file is
 *  open at a time and the ~800 MB tree is never buffered whole.
 *
 *  SYSTEM stability: this is the biggest memory/IO burst aio owns, so it asks
 *  {@link ensureHeadroom} first and declines while the machine is already
 *  tight. `buildWindowsSfxExe` treats a decline like any pack failure and
 *  falls back to the zip payload — the build finishes, and the box is never
 *  pushed into swap thrash. Compression is single-threaded on purpose: Deno's
 *  `node:zlib` rejects `ZSTD_c_nbWorkers` (param 400), so a build can never
 *  take every core with zstd. */
export async function packAppDirTarZstd(
  dir: string,
  outPath: string,
): Promise<void> {
  await ensureHeadroom("packing the Windows payload (zstd)");
  await Deno.mkdir(dirname(outPath), { recursive: true });
  const tmp = `${outPath}.incoming`;
  const tar = ReadableStream.from(tarEntries(dir, dir)).pipeThrough(
    new TarStream(),
  );
  await pipeline(
    Readable.fromWeb(tar as unknown as NodeReadableStream),
    zlib.createZstdCompress({
      params: { [ZSTD_C_COMPRESSION_LEVEL]: 19 },
    }),
    createWriteStream(tmp),
  );
  await Deno.rename(tmp, outPath);
}

/** Pack stub + payload → SFX exe on disk. */
export async function writeWindowsSfxExe(opts: {
  stubPath: string;
  payloadPath: string;
  payloadFormat: SfxFormat;
  outPath: string;
  binaryName: string;
  archStr: string;
}): Promise<{ size: number; sha256: string; payloadSize: number }> {
  const stub = await Deno.readFile(opts.stubPath);
  const payload = await Deno.readFile(opts.payloadPath);
  const sha256 = await sha256Hex(payload);
  const bytes = appendSfxPayload(stub, payload, {
    sha256,
    binary: opts.binaryName,
    arch: opts.archStr,
    format: opts.payloadFormat,
  });
  await Deno.mkdir(dirname(opts.outPath), { recursive: true });
  const tmp = `${opts.outPath}.incoming`;
  await Deno.writeFile(tmp, bytes);
  await Deno.rename(tmp, opts.outPath);
  return { size: bytes.length, sha256, payloadSize: payload.length };
}

/** Build `<bin>-win-<arch>.exe` as an SFX over the staged AppDir. Exits the
 *  process on failure, like every other packaging step. */
export async function buildSelfContainedWindowsExe(
  cfg: BuildConfig,
): Promise<void> {
  if (Deno.env.get("AIO_WINDOWS_FAT_EXE") === "1") {
    console.warn(
      `${NO} AIO_WINDOWS_FAT_EXE=1 — building the legacy fat PE (embedded ` +
        `electron-runtime.zip). Prefer the default SFX path.`,
    );
    await buildFatEmbeddedWindowsExe(cfg);
    return;
  }
  await buildWindowsSfxExe(cfg);
}

async function buildWindowsSfxExe(cfg: BuildConfig): Promise<void> {
  const { root, binaryName, archStr } = cfg;
  const outDir = cfg.outDir ?? root;
  const zipPath = join(outDir, windowsZipName(binaryName, archStr));
  let zipSize = 0;
  try {
    zipSize = (await Deno.stat(zipPath)).size;
  } catch {
    console.error(
      `${NO} ${windowsZipName(binaryName, archStr)} is missing — build the ` +
        `Electron Windows package first (it stages the AppDir and the zip).`,
    );
    Deno.exit(1);
  }

  const appDir = electronStagingDir(root);
  const scratch = dirname(appDir);
  const payloadPath = join(scratch, `${binaryName}-win-${archStr}.tar.zst`);

  // Preferred payload: a zstd tar packed in Deno. Fall back to the zip when
  // packing fails — larger, never broken.
  let format: SfxFormat = "tar.zstd";
  try {
    console.log(
      `${OK} packing the Windows payload (zstd, best compression)...`,
    );
    await packAppDirTarZstd(appDir, payloadPath);
    console.log(
      `${OK} payload ${formatMb((await Deno.stat(payloadPath)).size)} MB ` +
        `(zip ${formatMb(zipSize)} MB)`,
    );
  } catch (e) {
    console.warn(
      `${HEY} ${
        e instanceof Error ? e.message : e
      }\n       falling back to the zip payload (larger, still one-click offline).`,
    );
    format = "zip";
  }

  let stubPath: string;
  try {
    stubPath = await ensureWindowsSfxStub();
  } catch (e) {
    console.error(`${NO} ${e instanceof Error ? e.message : e}`);
    Deno.exit(1);
  }

  const payloadForPack = format === "zip" ? zipPath : payloadPath;
  const out = join(outDir, selfContainedExeName(binaryName, archStr));
  let result: { size: number; sha256: string; payloadSize: number };
  try {
    result = await writeWindowsSfxExe({
      stubPath,
      payloadPath: payloadForPack,
      payloadFormat: format,
      outPath: out,
      binaryName,
      archStr,
    });
  } catch (e) {
    console.error(`${NO} ${e instanceof Error ? e.message : e}`);
    Deno.exit(1);
  } finally {
    if (format === "tar.zstd") {
      await Deno.remove(payloadPath).catch(() => {
        // aio-ok: build scratch, removed once its bytes are inside the SFX.
      });
    }
  }

  // Sanity: SFX must not be the old fat VFS embed, and should never be larger
  // than the zip it replaces.
  const pe = await Deno.readFile(out);
  if (peEmbedsElectronRuntimeZip(pe)) {
    console.error(
      `${NO} SFX unexpectedly contains an embedded electron-runtime.zip ` +
        `VFS name — refusing to ship a fat PE`,
    );
    Deno.exit(1);
  }
  const trailer = readSfxTrailer(pe);
  if (!trailer || trailer.header.sha256 !== result.sha256) {
    console.error(`${NO} SFX trailer missing or checksum mismatch after write`);
    Deno.exit(1);
  }
  const ratio = result.size / Math.max(1, zipSize);
  if (ratio > 1.15) {
    console.error(
      `${NO} ${selfContainedExeName(binaryName, archStr)} is ` +
        `${(ratio * 100).toFixed(0)}% of the zip — an SFX must never exceed ` +
        `the zip it is built beside (payload format ${format}).`,
    );
    Deno.exit(1);
  }

  console.log(
    `${OK} ${selfContainedExeName(binaryName, archStr)} ` +
      `(${formatMb(result.size)} MB SFX, ${format} payload ≈ ${
        formatMb(
          result.payloadSize,
        )
      } MB vs zip ${formatMb(zipSize)} MB — offline double-click; extract ` +
      `once to %LOCALAPPDATA%\\aio-sfx)`,
  );
}

/** Legacy path: re-compile with Electron's published zip inside Deno VFS.
 *  Kept behind `AIO_WINDOWS_FAT_EXE=1` only. */
async function buildFatEmbeddedWindowsExe(cfg: BuildConfig): Promise<void> {
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
