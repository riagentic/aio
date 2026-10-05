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
 *   [tiny prebuilt stub PE (~0.7 MB)] + [payload] + [JSON hdr] + [lengths] + [magic]
 *
 * into `<bin>-win-<arch>.exe`. The stub (see `windows-sfx-stub/`) extracts the
 * payload once into `%LOCALAPPDATA%\aio-sfx\<bin>\win-<arch>\`, verifies the
 * payload's SHA-256, stamps it, and launches the inner `<bin>.exe` with
 * `ELECTRON_PATH` set — same layout and fuse-off Electron as unzipping the zip
 * today. Second launch skips extract when the stamp matches. No network.
 *
 * The extracted tree is an ordinary unpacked Electron install, so the app's
 * own updater replaces it in place (`electron-zip`); it carries the stamp into
 * the new tree (`SFX_STAMP_FILE` / `carrySfxStamp` in
 * `server/updates-apply.ts`), which keeps the downloaded `.exe` a plain
 * launcher for the updated app instead of extracting its old payload over it.
 *
 * ## The payload: zstd-compressed tar, packed by Deno
 *
 * The stub extracts any payload, so the `.exe` need not reuse the `.zip`'s
 * deflate. The default payload is a **zstd-compressed tar of the AppDir**,
 * produced by {@link packAppDirTarZstd} — `@std/tar` piped through Deno's
 * `node:zlib` `createZstdCompress` — measured ~14% smaller than the zip on a
 * reference Electron tree, and zstd decompresses faster than deflate, so first
 * launch is faster too. Building it needs **no compiler**: the extractor stub
 * is a committed prebuilt PE ({@link ensureWindowsSfxStub}, a Rust program —
 * a Go one through 1.0.17-beta) and the compression runs in Deno. The `.zip` artifact is unchanged (Windows users unzip it with
 * Explorer); if packing fails, the exe falls back to the zip payload
 * (`format: "zip"`) — larger, never broken.
 *
 * A Windows install has no symlinks, and the stub refuses one. A symlink in
 * the staged app is therefore packed as a copy of what it points at
 * ({@link appDirEntries}); one that points outside the app, at nothing, or at
 * a folder it is inside stops the build, naming the path.
 *
 * Emergency rollback: `AIO_WINDOWS_FAT_EXE=1` restores the old embedded-runtime
 * `deno compile` path (gated; not the default). The same path is the loud
 * fallback when the stub cannot be obtained or fails its checksum.
 */
import { dirname, fromFileUrl, join, relative, SEPARATOR } from "@std/path";
import { TarStream, type TarStreamInput } from "@std/tar";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import type { BuildConfig } from "./build-config.ts";
import {
  readSfxTrailerOfFile,
  SFX_MAGIC,
  type SfxFormat,
  type SfxHeader,
} from "./sfx-trailer.ts";
import { electronStagingDir } from "./build-electron.ts";
import { runDenoCompile } from "./build-compile.ts";
import { ensureHeadroom } from "./freeze-guard.ts";
import { artifactMode, formatMb } from "./build-helpers.ts";
import {
  ELECTRON_VERSION_FILE,
  electronSlug,
  EMBEDDED_RUNTIME_ZIP,
  ensureElectronZip,
} from "../electron/electron-runtime-fetch.ts";
import { HEY, NO, OK } from "../diagnostics/fmt.ts";

export {
  parseSfxTrailer,
  readSfxTrailer,
  readSfxTrailerOfFile,
  SFX_MAGIC,
  type SfxFormat,
  type SfxHeader,
  type SfxTrailer,
} from "./sfx-trailer.ts";

/** SHA-256 of the committed stub PE. {@link ensureWindowsSfxStub} refuses any
 *  other bytes, so what goes into every user's `.exe` is exactly the binary
 *  built from `windows-sfx-stub/` by the command in its README — update this
 *  line with every rebuild. */
export const SFX_STUB_SHA256 =
  "2fd8497fbb7c00cf1cecee664b4e8b1b2bd8c01e0a5c0196f010bf8704d41871";

/** SHA-256 over the stub's SOURCES (`src/*.rs`, `Cargo.toml`, `Cargo.lock`) as
 *  they were when {@link SFX_STUB_SHA256} was built. Rebuilding needs Rust,
 *  which a gate may not have; this needs none, so a source edit that was not
 *  followed by a rebuild and a re-pin of both lines goes red everywhere
 *  (`tests/build-windows-sfx-stub.test.ts` prints the value to put here). */
// aio-ok: a test-only seam — the pin a gate without Rust compares the sources with.
export const SFX_STUB_SOURCE_SHA256 =
  "7aa3ce923acd381e4dae5a0c8a8b51e4177b64cf6adaefd4e62f70a2f7c5b3fd";

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

/** The bytes that follow the payload: JSON | u32 hdrLen | u64 payloadLen |
 *  magic. Pure. */
export function sfxTrailer(
  header: SfxHeader,
  payloadLength: number,
): Uint8Array {
  const hdr = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(hdr.length + 4 + 8 + SFX_MAGIC.length);
  out.set(hdr, 0);
  const view = new DataView(out.buffer);
  view.setUint32(hdr.length, hdr.length, true);
  // payload length as u64 LE
  view.setUint32(hdr.length + 4, payloadLength >>> 0, true);
  view.setUint32(
    hdr.length + 8,
    Math.floor(payloadLength / 0x100000000),
    true,
  );
  out.set(new TextEncoder().encode(SFX_MAGIC), hdr.length + 12);
  return out;
}

/** Append a payload + trailer onto a stub PE. Pure bytes → bytes.
 *
 *  Trailer (end of file): payload | JSON | u32 hdrLen | u64 payloadLen | magic. */
// aio-ok: a test-only seam — the in-memory form of the streamed writer, pinned against it.
export function appendSfxPayload(
  stub: Uint8Array,
  payload: Uint8Array,
  header: SfxHeader,
): Uint8Array {
  const trailer = sfxTrailer(header, payload.length);
  const out = new Uint8Array(stub.length + payload.length + trailer.length);
  out.set(stub, 0);
  out.set(payload, stub.length);
  out.set(trailer, stub.length + payload.length);
  return out;
}

/** True when `bytes` look like a PE that embeds `electron-runtime.zip` as a
 *  Deno VFS file name — the old fat path. Size-regression / packaging gate. */
// aio-ok: a test-only seam — the packaging gate reads a built exe with it.
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

/** The committed stub PE, relative to this module. */
const STUB_REL = "./windows-sfx-stub/prebuilt/aio-windows-sfx-stub-amd64.exe";

/** Directory holding the SFX stub source and the committed prebuilt PE (next
 *  to this module). A local path: it exists only when aio itself is on disk
 *  (a checkout), not when it is imported from a registry —
 *  {@link ensureWindowsSfxStub} covers both. */
// aio-ok: a test-only seam — the stub's source is checked against its prebuilt PE.
export function windowsSfxStubDir(): string {
  // `fromFileUrl`, never `URL.pathname`: the pathname keeps `%20` for a space
  // and `/C:/…` on Windows, so the stub was "missing" from any checkout whose
  // path was not plain ASCII.
  return fromFileUrl(new URL("./windows-sfx-stub", import.meta.url));
}

/** The committed Windows stub — a prebuilt PE, so building the one-click `.exe`
 *  needs no compiler on the build host. Rebuilt only when the stub's source
 *  changes; see `windows-sfx-stub/README.md`. */
// aio-ok: a test-only seam — the product reads the stub through ensureWindowsSfxStub.
export function prebuiltStubPath(): string {
  return fromFileUrl(new URL(STUB_REL, import.meta.url));
}

/** The prebuilt Windows stub as a local file whose bytes are EXACTLY the
 *  pinned build ({@link SFX_STUB_SHA256}). Throws with the fix when it is
 *  missing, unreachable or different.
 *
 *  aio on disk: the committed file itself. aio imported from a registry (an
 *  `https:` module URL — there is no file beside the module): the stub is
 *  fetched from the module's own origin and written to a file of its own,
 *  which the caller removes. `moduleUrl` is a test seam. */
// aio-ok: the earlier signature, kept for its callers — the build itself goes through resolveWindowsSfxStub.
export async function ensureWindowsSfxStub(
  moduleUrl: string = import.meta.url,
): Promise<string> {
  return (await resolveWindowsSfxStub(moduleUrl)).path;
}

/** {@link ensureWindowsSfxStub}, saying also whether `path` is a fetched copy
 *  the caller must remove (`temp`) — decided once, here, where the copy is
 *  made. The copy goes into `scratch` under one fixed name when the caller has
 *  a scratch folder (the build's own): a build that is interrupted then leaves
 *  it where the next build writes over it, not one more file in the system
 *  temp folder each time. The whole fetch, body included, gets
 *  `fetchTimeoutMs` (a test seam): a registry that never answers, or answers
 *  too slowly to finish in that time, is given up on, so the build reaches its
 *  fallback instead of hanging. */
export async function resolveWindowsSfxStub(
  moduleUrl: string = import.meta.url,
  fetchTimeoutMs = 60_000,
  scratch?: string,
): Promise<{ path: string; temp: boolean }> {
  const url = new URL(STUB_REL, moduleUrl);
  const local = url.protocol === "file:" ? fromFileUrl(url) : null;
  let bytes: Uint8Array;
  if (local) {
    try {
      bytes = await Deno.readFile(local);
    } catch (e) {
      throw new Error(
        `the prebuilt Windows SFX stub cannot be read: ${local} (${
          e instanceof Error ? e.message : e
        })\n` +
          `       it is committed to the repo (see windows-sfx-stub/README.md); ` +
          `restore it from git, or rebuild it and commit the result.`,
      );
    }
  } else {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(fetchTimeoutMs),
      });
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`HTTP ${res.status}`);
      }
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      throw new Error(
        `the prebuilt Windows SFX stub could not be fetched from ${url} (${
          e instanceof Error ? e.message : e
        })`,
      );
    }
  }
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== SFX_STUB_SHA256) {
    throw new Error(
      `the prebuilt Windows SFX stub is not the pinned build: ${
        local ?? url
      }\n` +
        `       sha256 ${got}\n` +
        `       pinned ${SFX_STUB_SHA256} (SFX_STUB_SHA256)\n` +
        `       restore it from git — or, after a deliberate rebuild, update ` +
        `the pin (see windows-sfx-stub/README.md).`,
    );
  }
  if (local) return { path: local, temp: false };
  if (scratch) await Deno.mkdir(scratch, { recursive: true });
  const tmp = scratch
    ? join(scratch, "aio-sfx-stub.exe")
    : await Deno.makeTempFile({ prefix: "aio-sfx-stub-", suffix: ".exe" });
  await Deno.writeFile(tmp, bytes);
  return { path: tmp, temp: true };
}

/** A tar entry name: always `/`-separated, whatever the build host's
 *  separator — the stub (and every tar reader) treats `\` as part of a name.
 *  Pure; `sep` is a test seam. */
export function tarEntryName(rel: string, sep: string = SEPARATOR): string {
  return sep === "/" ? rel : rel.replaceAll(sep, "/");
}

/** One entry of a staged app, as it is packed. */
export type AppDirEntry = {
  /** `/`-separated, relative to the app. */
  path: string;
  /** Where its bytes are read from. */
  full: string;
  /** Bytes of a file; null for a directory. */
  size: number | null;
  /** Reached through a symlink: packed as a copy of the link's target. */
  linked: boolean;
};

/** Every entry under `root`, depth-first, sorted by name — so the same app
 *  packs to the same bytes (and the same payload stamp) on every build.
 *
 *  A symlink is resolved to what it points at: a Windows install has none and
 *  the stub refuses one, so a link to a file is packed as that file and a link
 *  to a folder as that folder. One that cannot be resolved to something INSIDE
 *  the app throws, naming it — packing a file from elsewhere on the build
 *  machine, or leaving the file out, is never what the app asked for. So does
 *  a device, socket or pipe. */
export async function appDirEntries(root: string): Promise<AppDirEntry[]> {
  const out: AppDirEntry[] = [];
  // `realDirs`: the real path of every folder from the app down to `dir`.
  const walk = async (dir: string, realDirs: string[], linked: boolean) => {
    const entries = await Array.fromAsync(Deno.readDir(dir));
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const e of entries) {
      const full = join(dir, e.name);
      const path = tarEntryName(relative(root, full));
      let real = join(realDirs.at(-1)!, e.name);
      let { isDirectory, isFile } = e;
      if (e.isSymlink) {
        try {
          real = await Deno.realPath(full);
        } catch (err) {
          if (!(err instanceof Deno.errors.NotFound)) throw err;
          throw new Error(
            `a symlink in the app points at nothing: ${path} → ` +
              `${await Deno.readLink(full)}`,
          );
        }
        if (!real.startsWith(realDirs[0]! + SEPARATOR)) {
          throw new Error(
            real === realDirs[0] || realDirs[0]!.startsWith(real + SEPARATOR)
              ? `a symlink in the app points at a folder it is inside: ${path} → ${real}`
              : `a symlink in the app points outside it: ${path} → ${real} — ` +
                `a Windows install has no symlinks, so each is packed as a ` +
                `copy of its target, and only a target inside the app is the ` +
                `app's to pack. Copy it into the app.`,
          );
        }
        if (realDirs.includes(real)) {
          throw new Error(
            `a symlink in the app points at a folder it is inside: ${path} → ${real}`,
          );
        }
        ({ isDirectory, isFile } = await Deno.stat(real));
      }
      const via = linked || e.isSymlink;
      if (isDirectory) {
        out.push({ path, full, size: null, linked: via });
        await walk(full, [...realDirs, real], via);
      } else if (isFile) {
        const { size } = await Deno.stat(full);
        out.push({ path, full, size, linked: via });
      } else {
        throw new Error(
          `unsupported file type (not a regular file): ${path} — a Windows ` +
            `install has only files and folders`,
        );
      }
    }
  };
  await walk(root, [await Deno.realPath(root)], false);
  return out;
}

/** The pack's one file — being opened, or open — and whether the pack has
 *  failed: so the pack can close what it was reading when it stops early, and
 *  never returns while an open is still on its way. */
type PackState = { opening?: Promise<Deno.FsFile>; failed?: boolean };

/** What Windows runs by its name. The payload is a Windows package: there is
 *  no exec bit to carry, and on a Windows build host none to read — so what
 *  counts as executable in it is decided by the name, on every host alike. */
const WINDOWS_RUNS = /\.(exe|bat|cmd|com)$/i;

/** {@link appDirEntries} as `@std/tar` inputs, with a fixed mtime and the
 *  mode every package entry gets ({@link artifactMode}) — stated, so the same
 *  staged package packs to the same bytes whatever it was staged with. */
async function* tarEntries(
  entries: AppDirEntry[],
  pack: PackState,
): AsyncGenerator<TarStreamInput> {
  for (const { path, full, size } of entries) {
    const options = {
      mtime: 0,
      mode: size === null
        ? artifactMode("dir", 0)
        : artifactMode("file", WINDOWS_RUNS.test(path) ? 0o755 : 0o644),
    };
    yield size === null ? { type: "directory", path, options } : {
      type: "file",
      path,
      size,
      readable: ReadableStream.from(fileChunks(path, full, size, pack)),
      options,
    };
  }
}

/** The bytes of one file, opened only when the tar starts reading it (it may
 *  take an entry before it is done with the one before, or refuse an entry's
 *  name without reading it) and closed when it has read it all.
 *
 *  The app was listed before the pack began, and a file can change under it.
 *  One that is no longer a regular file, or not the `size` it was listed
 *  with, stops the pack here, by name: the tar's own complaint names no file,
 *  and opening what has become a pipe waits for ever. */
async function* fileChunks(
  path: string,
  full: string,
  size: number,
  pack: PackState,
): AsyncGenerator<Uint8Array> {
  pack.opening = openRegularFile(path, full);
  using file = await pack.opening;
  if (pack.failed) return;
  let read = 0;
  for await (const chunk of file.readable) {
    read += chunk.length;
    yield chunk;
  }
  if (read !== size) {
    throw new Error(
      `${path} changed while the app was being packed: ${size} bytes when ` +
        `it was listed, ${read} now`,
    );
  }
}

async function openRegularFile(
  path: string,
  full: string,
): Promise<Deno.FsFile> {
  if (!(await Deno.stat(full)).isFile) {
    throw new Error(
      `${path} was a file when the app was listed and is not one now`,
    );
  }
  return await Deno.open(full);
}

/** `ZSTD_c_compressionLevel` (zstd.h). Deno's bundled `node:zlib` types predate
 *  the zstd API, so the enum member is not declared; the value is stable. */
const ZSTD_C_COMPRESSION_LEVEL = 100;

/** Pack `dir` into a **zstd-compressed tar** at `outPath`, entirely in Deno:
 *  `@std/tar` → `node:zlib`'s `createZstdCompress` at maximum compression.
 *  No host packer binary. Entries stream lazily, so only one file is
 *  open at a time, none is left open when the pack ends — however it ends —
 *  and the ~800 MB tree is never buffered whole.
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
  entries?: AppDirEntry[],
): Promise<void> {
  await ensureHeadroom("packing the Windows payload (zstd)");
  entries ??= await appDirEntries(dir);
  await Deno.mkdir(dirname(outPath), { recursive: true });
  const tmp = `${outPath}.incoming`;
  const pack: PackState = {};
  const tar = ReadableStream.from(tarEntries(entries, pack)).pipeThrough(
    new TarStream(),
  );
  try {
    await pipeline(
      Readable.fromWeb(tar as unknown as NodeReadableStream),
      zlib.createZstdCompress({
        params: { [ZSTD_C_COMPRESSION_LEVEL]: 19 },
      }),
      createWriteStream(tmp),
    );
    await Deno.rename(tmp, outPath);
  } catch (e) {
    pack.failed = true;
    await removeQuietly(tmp);
    throw e;
  } finally {
    // A pack that stops early (a name the tar refuses, a write that fails)
    // tells no one upstream: the file it was reading is closed here, not
    // whenever the stream is collected — after the open it had asked for has
    // landed, so nothing of the pack is still under way when it returns. A
    // no-op for a file already closed.
    const file = await pack.opening?.catch(() => {
      // aio-ok(silent-catch): an open that failed opened nothing to close,
      // and its error is the one the pack is already throwing.
    });
    file?.[Symbol.dispose]();
  }
}

/** Remove build scratch whose absence is the outcome wanted. */
async function removeQuietly(path: string): Promise<void> {
  await Deno.remove(path).catch(() => {
    // aio-ok(silent-catch): scratch that may never have been created; the
    // caller is already reporting the real failure.
  });
}

/** Zip `dir`'s contents into `out` with every symlink FOLLOWED — the zip
 *  payload of an app that has symlinks. (The `.zip` artifact stores a link as
 *  a link, which the stub refuses.) Throws with the reason. */
async function zipFollowingLinks(dir: string, out: string): Promise<void> {
  // `zip -r` updates an existing archive; only a fresh one holds just this tree.
  await removeQuietly(out);
  let r: Deno.CommandOutput;
  try {
    r = await new Deno.Command("zip", {
      args: ["-r", "-q", out, "."],
      cwd: dir,
      stdout: "null",
      stderr: "piped",
    }).output();
  } catch (e) {
    throw new Error(
      `zip could not be run (${e instanceof Error ? e.message : e})`,
    );
  }
  if (!r.success) {
    throw new Error(
      `zip: ${new TextDecoder().decode(r.stderr).trim().split("\n")[0] ?? ""}`,
    );
  }
}

/** Pack stub + payload → SFX exe on disk. The payload is STREAMED through the
 *  hash into the output — it is hundreds of MB, and buffering stub + payload +
 *  output held three copies of it in memory. */
export async function writeWindowsSfxExe(opts: {
  stubPath: string;
  payloadPath: string;
  payloadFormat: SfxFormat;
  outPath: string;
  binaryName: string;
  archStr: string;
  /** The app's version, title and whether the stub adds a Start-menu
   *  shortcut — see {@link SfxHeader}. Left out of the header when absent. */
  version?: string;
  title?: string;
  shortcut?: boolean;
}): Promise<{ size: number; sha256: string; payloadSize: number }> {
  const stub = await Deno.readFile(opts.stubPath);
  await Deno.mkdir(dirname(opts.outPath), { recursive: true });
  const tmp = `${opts.outPath}.incoming`;
  const hash = createHash("sha256");
  let payloadSize = 0;
  let size = 0;
  let sha256 = "";
  try {
    const out = (await Deno.open(tmp, {
      write: true,
      create: true,
      truncate: true,
    })).writable.getWriter();
    try {
      await out.write(stub);
      for await (const chunk of (await Deno.open(opts.payloadPath)).readable) {
        hash.update(chunk);
        payloadSize += chunk.length;
        await out.write(chunk);
      }
      sha256 = hash.digest("hex");
      const trailer = sfxTrailer({
        sha256,
        binary: opts.binaryName,
        arch: opts.archStr,
        format: opts.payloadFormat,
        ...(opts.version ? { version: opts.version } : {}),
        ...(opts.title ? { title: opts.title } : {}),
        ...(opts.shortcut ? { shortcut: true } : {}),
      }, payloadSize);
      await out.write(trailer);
      size = stub.length + payloadSize + trailer.length;
    } finally {
      await out.close();
    }
    await Deno.rename(tmp, opts.outPath);
  } catch (e) {
    await removeQuietly(tmp);
    throw e;
  }
  return { size, sha256, payloadSize };
}

/** Build `<bin>-win-<arch>.exe` as an SFX over the staged AppDir. Exits the
 *  process on failure, like every other packaging step. `deps` is a test seam
 *  for the two things a unit test cannot afford: the fat `deno compile` and a
 *  stub that is not there. */
export async function buildSelfContainedWindowsExe(
  cfg: BuildConfig,
  deps: {
    fat?: (cfg: BuildConfig) => Promise<void>;
    stub?: () => Promise<{ path: string; temp: boolean }>;
  } = {},
): Promise<void> {
  const fat = deps.fat ?? buildFatEmbeddedWindowsExe;
  if (Deno.env.get("AIO_WINDOWS_FAT_EXE") === "1") {
    console.warn(
      `${NO} AIO_WINDOWS_FAT_EXE=1 — building the legacy fat PE (embedded ` +
        `electron-runtime.zip). Prefer the default SFX path.`,
    );
    await fat(cfg);
    return;
  }
  // No stub, no SFX — but the fat exe needs none, and a one-click exe that is
  // twice the size beats a build that stops. Said loudly: the size is not what
  // the docs promise, and the cause is fixable.
  let stub: { path: string; temp: boolean };
  try {
    stub = await (deps.stub?.() ??
      resolveWindowsSfxStub(
        undefined,
        undefined,
        dirname(electronStagingDir(cfg.root)),
      ));
  } catch (e) {
    console.warn(
      `${NO} ${e instanceof Error ? e.message : e}\n` +
        `       FALLING BACK to the legacy fat exe (Electron's zip embedded ` +
        `in the Deno PE): it runs the same, offline, but the download is ` +
        `about twice the size of the zip. Fix the stub to get the small SFX.`,
    );
    await fat(cfg);
    return;
  }
  // The exit comes AFTER the temp stub is removed: `Deno.exit` runs no
  // `finally`.
  let failure: string | null;
  try {
    failure = await buildWindowsSfxExe(cfg, stub.path);
  } finally {
    if (stub.temp) await removeQuietly(stub.path);
  }
  if (failure !== null) {
    console.error(`${NO} ${failure}`);
    Deno.exit(1);
  }
}

/** The SFX step. Returns why it failed, or null. */
async function buildWindowsSfxExe(
  cfg: BuildConfig,
  stubPath: string,
): Promise<string | null> {
  const { root, binaryName, archStr } = cfg;
  const outDir = cfg.outDir ?? root;
  const zipPath = join(outDir, windowsZipName(binaryName, archStr));
  let zipSize = 0;
  try {
    zipSize = (await Deno.stat(zipPath)).size;
  } catch {
    return `${windowsZipName(binaryName, archStr)} is missing — build the ` +
      `Electron Windows package first (it stages the AppDir and the zip).`;
  }

  const appDir = electronStagingDir(root);
  const scratch = dirname(appDir);
  const payloadPath = join(scratch, `${binaryName}-win-${archStr}.tar.zst`);
  const zipPayloadPath = join(scratch, `${binaryName}-win-${archStr}.sfx.zip`);

  let entries: AppDirEntry[];
  try {
    entries = await appDirEntries(appDir);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  const links = entries.filter((e) => e.linked);
  // What the copies add over the zip, which stores a link as a link.
  const linkedBytes = links.reduce((n, e) => n + (e.size ?? 0), 0);
  if (links.length > 0) {
    console.warn(
      `${HEY} ${links[0]!.path}${
        links.length > 1 ? ` and ${links.length - 1} more are` : " is"
      } reached through a symlink — a Windows install has none, so the ` +
        `.exe carries a copy of the target (${formatMb(linkedBytes)} MB).`,
    );
  }

  // Preferred payload: a zstd tar packed in Deno. Fall back to the zip when
  // packing fails — larger, never broken.
  let payloadForPack = payloadPath;
  let format: SfxFormat = "tar.zstd";
  try {
    console.log(
      `${OK} packing the Windows payload (zstd, best compression)...`,
    );
    await packAppDirTarZstd(appDir, payloadPath, entries);
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
    payloadForPack = zipPath;
    if (links.length > 0) {
      // The zip beside the exe stores the links themselves.
      try {
        await zipFollowingLinks(appDir, zipPayloadPath);
      } catch (err) {
        await removeQuietly(zipPayloadPath);
        return `the zip payload could not be packed either: ${
          err instanceof Error ? err.message : err
        }`;
      }
      payloadForPack = zipPayloadPath;
    }
  }

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
      version: cfg.version.version,
      title: cfg.appTitle ?? binaryName,
      shortcut: cfg.windowsShortcut,
    });
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    // Build scratch, removed once its bytes are inside the SFX.
    await removeQuietly(payloadPath);
    await removeQuietly(zipPayloadPath);
  }

  // Sanity: what is on disk ends in the trailer just written, and the SFX
  // should never be larger than the zip it replaces — plus the copies it
  // carries where the zip has a link. (It cannot be the old fat VFS embed: it
  // is the pinned stub plus an opaque payload.)
  const trailer = await readSfxTrailerOfFile(out);
  if (
    !trailer || trailer.header.sha256 !== result.sha256 ||
    trailer.payloadLength !== result.payloadSize
  ) {
    return `SFX trailer missing or checksum mismatch after write`;
  }
  const ratio = result.size / Math.max(1, zipSize + linkedBytes);
  if (ratio > 1.15) {
    return `${selfContainedExeName(binaryName, archStr)} is ` +
      `${(ratio * 100).toFixed(0)}% of the zip — an SFX must never exceed ` +
      `the zip it is built beside (payload format ${format}).`;
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
  return null;
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
