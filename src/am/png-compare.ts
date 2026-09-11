// png-compare.ts — decode a PNG to pixels, and say how two of them differ.
//
// WHY DECODE AT ALL, when comparing the two files byte-for-byte is one line.
// Because a PNG's bytes are not its pixels: the same image re-encoded with a
// different zlib level, a different filter choice or an extra ancillary chunk
// is a different file. A byte comparison would report a difference no human
// can see, on a screenshot that is identical — and a check that cries wolf is
// one people delete, taking the true failures with it.
//
// The other direction matters too: a TOLERANCE. Antialiasing and subpixel text
// rendering move a channel by one or two between otherwise identical captures,
// so "not one byte moved" is not the question anyone is asking. The question is
// "did anything I would notice change", and that is a per-pixel threshold with
// a count.
//
// Deliberately small: 8-bit, non-interlaced, colour types 0/2/4/6 — which is
// every screenshot Chrome's `Page.captureScreenshot` produces and every icon
// this repo writes. Anything else is REFUSED BY NAME rather than guessed at; a
// decoder that quietly mis-reads an interlaced image reports differences that
// are its own.

/** A decoded image: 8-bit RGBA, row-major, `width * height * 4` bytes. */
export type Pixels = {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
};

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Channels per pixel for a PNG colour type. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** Decode a PNG into 8-bit RGBA.
 *
 *  Throws with the reason — a decoder that returns a half-read image turns
 *  every later comparison into a mystery. */
export async function decodePng(bytes: Uint8Array): Promise<Pixels> {
  if (bytes.length < 8 || SIG.some((b, i) => bytes[i] !== b)) {
    throw new Error("not a PNG (bad signature)");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0, height = 0, depth = 0, colorType = 0;
  let seenIhdr = false;
  const idat: Uint8Array[] = [];

  while (at + 8 <= bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(
      bytes[at + 4]!,
      bytes[at + 5]!,
      bytes[at + 6]!,
      bytes[at + 7]!,
    );
    const body = bytes.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      depth = bytes[at + 16]!;
      colorType = bytes[at + 17]!;
      const interlace = bytes[at + 20]!;
      if (depth !== 8) {
        throw new Error(
          `PNG bit depth ${depth} is not supported (only 8) — this reader ` +
            `exists for screenshots and icons, and guessing at a 16-bit or ` +
            `palette image would report differences that are its own.`,
        );
      }
      if (!(colorType in CHANNELS)) {
        throw new Error(
          `PNG colour type ${colorType} is not supported (0, 2, 4, 6 are).`,
        );
      }
      if (interlace !== 0) {
        throw new Error("interlaced PNG is not supported.");
      }
      seenIhdr = true;
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    at += 12 + len; // length + type + body + crc
  }
  if (!seenIhdr) throw new Error("PNG has no IHDR chunk");
  if (idat.length === 0) throw new Error("PNG has no image data (no IDAT)");

  // IDAT chunks are ONE zlib stream split across chunk boundaries — inflating
  // them separately fails on any image big enough to need two, which is every
  // screenshot.
  const total = idat.reduce((n, c) => n + c.length, 0);
  const joined = new Uint8Array(total);
  let off = 0;
  for (const c of idat) {
    joined.set(c, off);
    off += c.length;
  }
  const raw = new Uint8Array(
    await new Response(
      new Blob([joined]).stream().pipeThrough(
        new DecompressionStream("deflate"),
      ),
    ).arrayBuffer(),
  );

  const ch = CHANNELS[colorType]!;
  const stride = width * ch;
  const expected = height * (stride + 1);
  if (raw.length < expected) {
    throw new Error(
      `PNG data is short: ${raw.length} bytes for a ${width}x${height} ` +
        `image that needs ${expected}. The file is truncated.`,
    );
  }

  // Un-filter, in place, one scanline at a time. Each filter is defined
  // against the reconstructed bytes of the PREVIOUS line, never the raw ones.
  const lines = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prev = dst - stride;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[src + x]!;
      const a = x >= ch ? lines[dst + x - ch]! : 0; // left
      const b = y > 0 ? lines[prev + x]! : 0; // up
      const c = y > 0 && x >= ch ? lines[prev + x - ch]! : 0; // up-left
      let value: number;
      switch (filter) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = rawByte + a;
          break;
        case 2:
          value = rawByte + b;
          break;
        case 3:
          value = rawByte + ((a + b) >> 1);
          break;
        case 4: {
          // Paeth: the neighbour closest to a + b - c.
          const p = a + b - c;
          const pa = Math.abs(p - a),
            pb = Math.abs(p - b),
            pc = Math.abs(p - c);
          value = rawByte + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(
            `PNG scanline ${y} uses filter ${filter} (0-4 are defined)`,
          );
      }
      lines[dst + x] = value & 0xff;
    }
  }

  // Widen to RGBA, so everything downstream has one shape to reason about.
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    const s = i * ch;
    if (ch === 1) {
      rgba[p] = rgba[p + 1] = rgba[p + 2] = lines[s]!;
      rgba[p + 3] = 255;
    } else if (ch === 2) {
      rgba[p] = rgba[p + 1] = rgba[p + 2] = lines[s]!;
      rgba[p + 3] = lines[s + 1]!;
    } else if (ch === 3) {
      rgba[p] = lines[s]!;
      rgba[p + 1] = lines[s + 1]!;
      rgba[p + 2] = lines[s + 2]!;
      rgba[p + 3] = 255;
    } else {
      rgba[p] = lines[s]!;
      rgba[p + 1] = lines[s + 1]!;
      rgba[p + 2] = lines[s + 2]!;
      rgba[p + 3] = lines[s + 3]!;
    }
  }
  return { width, height, rgba };
}

/** How two images differ. `same` is the verdict the gate acts on. */
export type PngDiff = {
  readonly same: boolean;
  /** Why not, in one sentence, when `same` is false. */
  readonly reason: string;
  readonly diffPixels: number;
  readonly totalPixels: number;
  /** The largest single-channel difference seen, 0-255. */
  readonly maxDelta: number;
  /** `diffPixels / totalPixels`, 0-1. */
  readonly ratio: number;
};

export type PngDiffOptions = {
  /** A channel may move by this much and still count as the same pixel.
   *  Default 2 — antialiasing and subpixel text move one or two between
   *  otherwise identical captures. */
  readonly threshold?: number;
  /** How many pixels may differ before the images are called different, as a
   *  fraction. Default 0 — a real change is usually thousands of pixels, and a
   *  budget that tolerates "a few" is a budget that hides a moved button. */
  readonly maxRatio?: number;
};

/** Compare two decoded images. Pure. */
export function comparePixels(
  a: Pixels,
  b: Pixels,
  opts: PngDiffOptions = {},
): PngDiff {
  const threshold = opts.threshold ?? 2;
  const maxRatio = opts.maxRatio ?? 0;
  const totalPixels = a.width * a.height;
  if (a.width !== b.width || a.height !== b.height) {
    return {
      same: false,
      // SIZE FIRST, and on its own. A resized window makes every pixel
      // "different", and reporting 100% of pixels changed sends the reader
      // looking for a visual change that did not happen.
      reason: `size changed: ${b.width}x${b.height} baseline, ` +
        `${a.width}x${a.height} now`,
      diffPixels: totalPixels,
      totalPixels,
      maxDelta: 255,
      ratio: 1,
    };
  }
  let diffPixels = 0;
  let maxDelta = 0;
  for (let p = 0; p < a.rgba.length; p += 4) {
    let worst = 0;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(a.rgba[p + c]! - b.rgba[p + c]!);
      if (d > worst) worst = d;
    }
    if (worst > maxDelta) maxDelta = worst;
    if (worst > threshold) diffPixels++;
  }
  const ratio = totalPixels === 0 ? 0 : diffPixels / totalPixels;
  const same = ratio <= maxRatio;
  return {
    same,
    reason: same ? "" : `${diffPixels} of ${totalPixels} pixels differ ` +
      `(${(ratio * 100).toFixed(2)}%, largest channel change ${maxDelta})`,
    diffPixels,
    totalPixels,
    maxDelta,
    ratio,
  };
}

/** Decode both and compare. */
export async function comparePng(
  actual: Uint8Array,
  baseline: Uint8Array,
  opts: PngDiffOptions = {},
): Promise<PngDiff> {
  const [a, b] = await Promise.all([decodePng(actual), decodePng(baseline)]);
  return comparePixels(a, b, opts);
}
