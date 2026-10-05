/**
 * @module
 * The trailer of a one-click Windows `.exe` (an aio SFX): what follows the
 * stub and its payload, and how to find it again. Kept apart from the builder
 * so a reader (`am publish`) loads nothing of the build with it.
 */

/** Magic trailer the stub and the packer agree on. Keep in sync with
 *  `windows-sfx-stub/src/format.rs`. `AIOSFX01` was a bare zip payload; `AIOSFX02`
 *  is a zstd tar (the stub still extracts a `zip` payload for old artifacts). */
export const SFX_MAGIC = "AIOSFX02";

/** Payload kinds the stub understands. */
export type SfxFormat = "tar.zstd" | "zip";

/** JSON header embedded in the SFX trailer. */
export type SfxHeader = {
  sha256: string;
  binary: string;
  arch: string;
  /** `"tar.zstd"` (default) or `"zip"` (fallback / pre-AIOSFX02). */
  format: SfxFormat;
  /** The app version the payload holds. The stub keeps an install that is
   *  NEWER than it instead of extracting over it. */
  version?: string;
  /** The app's display name: the Start-menu shortcut's. */
  title?: string;
  /** Add a Start-menu shortcut when the app is installed. */
  shortcut?: boolean;
};

/** What an SFX trailer says. */
export type SfxTrailer = {
  header: SfxHeader;
  payloadOffset: number;
  payloadLength: number;
};

/** The trailer of an SFX held in memory, or null when `bytes` is not an aio
 *  SFX. Reads a signed exe too (see {@link readSfxTrailerOfFile}). */
// aio-ok: a test-only seam — the in-memory form of readSfxTrailerOfFile.
export function readSfxTrailer(bytes: Uint8Array): SfxTrailer | null {
  for (const end of trailerEnds(bytes, bytes.length)) {
    const found = parseSfxTrailer(bytes.subarray(0, end), end);
    if (found) return found;
  }
  return null;
}

/** {@link readSfxTrailer} for a file on disk, reading only its head and a
 *  tail — an SFX is hundreds of MB and the trailer is a few hundred bytes.
 *
 *  An Authenticode signature appends its certificate table AFTER the trailer
 *  (the file padded to 8 bytes first), so the magic is no longer at the end of
 *  the file: it is looked for just before that table too, the way the stub
 *  does (`windows-sfx-stub/src/format.rs`). */
export async function readSfxTrailerOfFile(
  path: string,
): Promise<SfxTrailer | null> {
  using f = await Deno.open(path, { read: true });
  const size = (await f.stat()).size;
  const read = async (from: number, to: number): Promise<Uint8Array | null> => {
    const out = new Uint8Array(to - from);
    await f.seek(from, Deno.SeekMode.Start);
    let n = 0;
    while (n < out.length) {
      const r = await f.read(out.subarray(n));
      if (r === null) return null;
      n += r;
    }
    return out;
  };
  const head = await read(0, Math.min(size, PE_HEAD));
  if (!head) return null;
  for (const end of trailerEnds(head, size)) {
    const tail = await read(Math.max(0, end - 64 * 1024), end);
    const found = tail && parseSfxTrailer(tail, end);
    if (found) return found;
  }
  return null;
}

/** How much of a PE holds its headers — the data directories sit well inside
 *  the first page. */
const PE_HEAD = 4096;

/** Where a trailer may end in a file of `size` bytes whose first bytes are
 *  `head`: the end of the file, then — for a signed PE — the start of the
 *  certificate table, minus each padding 0..7. Pure. */
function trailerEnds(head: Uint8Array, size: number): number[] {
  const ends = [size];
  const cert = peCertTableOffset(head, size);
  for (let pad = 0; cert > 0 && pad < 8; pad++) ends.push(cert - pad);
  return ends.filter((end) => end > 0);
}

/** The file offset of a PE's certificate table (IMAGE_DIRECTORY_ENTRY_SECURITY
 *  — the one data directory whose address is a FILE offset), or 0 when the
 *  file is unsigned or not a PE. Pure. */
function peCertTableOffset(head: Uint8Array, size: number): number {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const u32 = (off: number) =>
    off >= 0 && off + 4 <= head.length ? view.getUint32(off, true) : null;
  const pe = u32(0x3c);
  if (pe === null || u32(pe) !== 0x00004550) return 0; // "PE\0\0"
  const opt = pe + 4 + 20; // past the signature and the COFF file header
  const magic = u32(opt);
  if (magic === null) return 0;
  const dirs = (magic & 0xffff) === 0x20b
    ? opt + 112 // PE32+
    : (magic & 0xffff) === 0x10b
    ? opt + 96 // PE32
    : 0;
  const SECURITY = 4;
  if (dirs === 0 || (u32(dirs - 4) ?? 0) <= SECURITY) return 0;
  const off = u32(dirs + SECURITY * 8);
  const len = u32(dirs + SECURITY * 8 + 4);
  return off && len && off <= size ? off : 0;
}

/** `tail` is the last bytes of a file of `fileSize` bytes. Pure. */
export function parseSfxTrailer(
  tail: Uint8Array,
  fileSize: number,
): SfxTrailer | null {
  const mag = SFX_MAGIC.length;
  if (tail.length < mag + 8 + 4) return null;
  const end = tail.length;
  const magicBytes = tail.subarray(end - mag);
  if (new TextDecoder().decode(magicBytes) !== SFX_MAGIC) return null;
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const lenLo = view.getUint32(end - mag - 8, true);
  const lenHi = view.getUint32(end - mag - 4, true);
  const payloadLength = lenLo + lenHi * 0x100000000;
  const hdrLen = view.getUint32(end - mag - 8 - 4, true);
  if (hdrLen === 0 || hdrLen > 1 << 20) return null;
  const hdrOff = end - mag - 8 - 4 - hdrLen;
  const payloadOffset = fileSize - tail.length + hdrOff - payloadLength;
  if (payloadOffset < 0 || hdrOff < 0) return null;
  const header = JSON.parse(
    new TextDecoder().decode(tail.subarray(hdrOff, hdrOff + hdrLen)),
  ) as SfxHeader;
  if (!header.format) header.format = "zip"; // pre-AIOSFX02 headers
  return { header, payloadOffset, payloadLength };
}
