/**
 * @module
 * Unpack a zip with nothing but the runtime — no `unzip`, `tar`, `python3` or
 * PowerShell.
 *
 * Every archive aio unpacks (the Electron runtime a desktop app carries or
 * fetches, an Electron release an updater applies) used to go through whatever
 * tool the machine happened to have. A clean Windows has none of the Unix
 * ones; under Wine, `powershell.exe` exits 0 having unpacked nothing; slim
 * Linux images lack `unzip`. So the one step a first launch depends on was the
 * step most likely to be missing (real Windows 11 and Wine, 2026-09-17).
 *
 * Supported: stored and deflated entries, Unix modes (exec bits) and symlinks
 * from archives made on Unix (Electron.app's frameworks are full of them).
 * Refused, loudly: zip64, encryption, other methods, CRC mismatches, and any
 * entry or link that would land outside the destination ("zip slip").
 */
import { dirname, isAbsolute, join, normalize, relative } from "@std/path";

/** One file, directory or symlink in the archive's central directory. */
export type ZipEntry = {
  name: string;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  /** Unix `st_mode` when the archive was made on Unix, else null. */
  mode: number | null;
  isDir: boolean;
  isSymlink: boolean;
};

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/** The archive's central directory. Pure. */
export function readZipDirectory(zip: Uint8Array): ZipEntry[] {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // The end record sits in the last 22 bytes + up to 64 KB of comment.
  let eocd = -1;
  for (
    let i = zip.length - 22;
    i >= Math.max(0, zip.length - 22 - 65535);
    i--
  ) {
    if (v.getUint32(i, true) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error("not a zip archive (no end-of-directory record)");
  }
  const count = v.getUint16(eocd + 10, true);
  const dirSize = v.getUint32(eocd + 12, true);
  let at = v.getUint32(eocd + 16, true);
  if (count === 0xffff || dirSize === 0xffffffff || at === 0xffffffff) {
    throw new Error("zip64 archives are not supported");
  }
  const text = new TextDecoder();
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (at + 46 > zip.length || v.getUint32(at, true) !== CENTRAL) {
      throw new Error(`corrupt zip: central directory entry ${n} is missing`);
    }
    const madeBy = v.getUint16(at + 4, true) >> 8;
    const flags = v.getUint16(at + 8, true);
    const method = v.getUint16(at + 10, true);
    const crc32 = v.getUint32(at + 16, true);
    const compressedSize = v.getUint32(at + 20, true);
    const size = v.getUint32(at + 24, true);
    const nameLen = v.getUint16(at + 28, true);
    const extraLen = v.getUint16(at + 30, true);
    const commentLen = v.getUint16(at + 32, true);
    const external = v.getUint32(at + 38, true);
    const localOffset = v.getUint32(at + 42, true);
    if (
      compressedSize === 0xffffffff || size === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      throw new Error("zip64 archives are not supported");
    }
    const name = text.decode(zip.subarray(at + 46, at + 46 + nameLen));
    const mode = madeBy === 3 ? (external >>> 16) & 0xffff : null;
    const isSymlink = mode !== null && (mode & S_IFMT) === S_IFLNK;
    out.push({
      name,
      method,
      flags,
      crc32,
      compressedSize,
      size,
      localOffset,
      mode,
      isDir: name.endsWith("/"),
      isSymlink,
    });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** The path `name` unpacks to under `dest`, or an error when it would escape
 *  it. Pure. */
export function safeZipPath(dest: string, name: string): string {
  const clean = name.replaceAll("\\", "/");
  if (
    clean.startsWith("/") || /^[A-Za-z]:/.test(clean) ||
    clean.split("/").includes("..")
  ) {
    throw new Error(`refusing zip entry outside the destination: ${name}`);
  }
  return join(dest, ...clean.split("/").filter((s) => s.length > 0));
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Incremental CRC-32 (the zip polynomial). Pure. */
export function crc32Update(crc: number, bytes: Uint8Array): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return ~c >>> 0;
}

/** The entry's data, decompressed, as a stream. */
function entryStream(
  zip: Uint8Array,
  e: ZipEntry,
): ReadableStream<Uint8Array> {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const lo = e.localOffset;
  if (v.getUint32(lo, true) !== LOCAL) {
    throw new Error(`corrupt zip: no local header for ${e.name}`);
  }
  const start = lo + 30 + v.getUint16(lo + 26, true) +
    v.getUint16(lo + 28, true);
  const data = zip.subarray(start, start + e.compressedSize);
  if (data.length !== e.compressedSize) {
    throw new Error(`corrupt zip: ${e.name} is truncated`);
  }
  const raw = new Blob([data as Uint8Array<ArrayBuffer>]).stream();
  if (e.method === 0) return raw;
  if (e.method === 8) {
    return raw.pipeThrough(
      new DecompressionStream("deflate-raw") as unknown as TransformStream<
        Uint8Array,
        Uint8Array
      >,
    );
  }
  throw new Error(`${e.name}: unsupported zip compression method ${e.method}`);
}

/** Unpack `zip` into `dest` (created if missing). Files are written as they
 *  decompress; each is checked against its CRC and size. */
export async function extractZip(
  zip: Uint8Array,
  dest: string,
): Promise<void> {
  await Deno.mkdir(dest, { recursive: true });
  const unix = Deno.build.os !== "windows";
  const links: { path: string; target: string }[] = [];
  for (const e of readZipDirectory(zip)) {
    if (e.flags & 1) {
      throw new Error(`${e.name}: encrypted zip entries are not supported`);
    }
    const path = safeZipPath(dest, e.name);
    if (e.isDir) {
      await Deno.mkdir(path, { recursive: true });
      continue;
    }
    await Deno.mkdir(dirname(path), { recursive: true });
    if (e.isSymlink) {
      const target = await new Response(entryStream(zip, e)).text();
      const resolved = normalize(
        isAbsolute(target) ? target : join(dirname(path), target),
      );
      const rel = relative(dest, resolved);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(
          `refusing zip symlink ${e.name} → ${target}: it points outside the destination`,
        );
      }
      links.push({ path, target });
      continue;
    }
    let crc = 0;
    let size = 0;
    const file = await Deno.open(path, {
      write: true,
      create: true,
      truncate: true,
    });
    try {
      const reader = entryStream(zip, e).getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        crc = crc32Update(crc, value);
        size += value.length;
        let off = 0;
        while (off < value.length) off += await file.write(value.subarray(off));
      }
    } finally {
      file.close();
    }
    if (size !== e.size || crc !== e.crc32) {
      throw new Error(
        `corrupt zip: ${e.name} unpacked to ${size} bytes / crc ` +
          `${crc.toString(16)}, the archive says ${e.size} / ` +
          `${e.crc32.toString(16)}`,
      );
    }
    if (unix && e.mode !== null && (e.mode & 0o777) !== 0) {
      await Deno.chmod(path, e.mode & 0o777);
    }
  }
  // Links last, so a link never stands where a later file is written through.
  for (const { path, target } of links) {
    await Deno.remove(path).catch(() => {
      // aio-ok(silent-catch): clear whatever stands where the symlink goes —
      // absent is the expected case, and a real failure is reported by the
      // symlink call below.
    });
    try {
      await Deno.symlink(target, path, unix ? undefined : { type: "file" });
    } catch (e) {
      throw new Error(
        `could not create the symlink ${path} → ${target} this archive ` +
          `holds${
            unix
              ? ""
              : " (Windows needs Developer Mode or admin rights for symlinks)"
          }`,
        { cause: e },
      );
    }
  }
}
