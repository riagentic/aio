/**
 * @module
 * An app's `icon.png`, scaled down to the sizes a Windows icon holds.
 *
 * One `icon.png` is the whole of an app's icon: 512 px is what the Linux
 * package asks for and 1024 px what macOS wants, and neither fits a Windows
 * `.ico`, whose images are at most 256 px. So the build reads the PNG and
 * cuts it down itself — on every build host, with no image tool installed.
 *
 * Read: 8 bits per channel, not interlaced — grey, RGB, palette, each with or
 * without alpha. That is what image editors export; a 16-bit or interlaced
 * file is refused with the reason, and the caller falls back.
 *
 * Pure: bytes in, bytes out.
 */

import { ICO_SIZES, icoFromPngs, pngFromRgba, pngSize } from "./app-icon.ts";

/** The largest side read: 4096² RGBA is 64 MB, and no icon is drawn larger. */
const MAX_SIDE = 4096;

/** Samples per pixel by PNG colour type (palette: one index). */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** A PNG as RGBA pixels, or why this one is not read. Never throws. */
export async function decodePng(
  png: Uint8Array,
): Promise<{ w: number; h: number; rgba: Uint8Array } | string> {
  const size = pngSize(png);
  if (!size) return "not a PNG";
  const { w, h } = size;
  if (w < 1 || h < 1 || w > MAX_SIDE || h > MAX_SIDE) {
    return `${w}×${h} is larger than ${MAX_SIDE} px`;
  }
  const depth = png[24]!, type = png[25]!, interlace = png[28]!;
  const channels = CHANNELS[type];
  if (depth !== 8 || !channels) {
    return `${depth}-bit colour type ${type} (8-bit grey, RGB or palette is read)`;
  }
  if (interlace !== 0) return "interlaced";

  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const idat: Uint8Array[] = [];
  let palette: Uint8Array | null = null;
  let alpha: Uint8Array | null = null;
  for (let at = 8; at + 12 <= png.length;) {
    const len = v.getUint32(at);
    const name = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + len);
    if (data.length !== len) return "cut short";
    if (name === "IDAT") idat.push(data);
    else if (name === "PLTE") palette = data;
    else if (name === "tRNS") alpha = data;
    else if (name === "IEND") break;
    at += 12 + len;
  }
  if (type === 3 && !palette) return "a palette image with no palette";
  // A colour KEY (one grey level or one RGB value is transparent), not alpha.
  if (alpha && type !== 3) return "transparency by colour key";

  const stride = w * channels;
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(
      await new Response(
        new Blob(idat as BlobPart[]).stream().pipeThrough(
          new DecompressionStream("deflate"),
        ),
      ).arrayBuffer(),
    );
  } catch (e) {
    return `its pixel data cannot be inflated (${
      e instanceof Error ? e.message : e
    })`;
  }
  if (raw.length !== h * (stride + 1)) {
    return "its pixel data has the wrong length";
  }

  // Undo the scanline filters in place (PNG §9): each byte was stored as a
  // difference from the byte one pixel to the left (a), above (b), or both.
  for (let y = 0; y < h; y++) {
    const row = y * (stride + 1) + 1;
    const filter = raw[row - 1]!;
    if (filter > 4) return `scanline filter ${filter}`;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? raw[row + x - channels]! : 0;
      const b = y > 0 ? raw[row + x - stride - 1]! : 0;
      const c = x >= channels && y > 0
        ? raw[row + x - channels - stride - 1]!
        : 0;
      let predicted = 0;
      if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else if (filter === 3) predicted = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      raw[row + x] = (raw[row + x]! + predicted) & 0xff;
    }
  }

  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = y * (stride + 1) + 1 + x * channels;
      const o = (y * w + x) * 4;
      if (type === 3) {
        const i = raw[s]!;
        if (i * 3 + 2 >= palette!.length) return "a pixel outside its palette";
        rgba.set(palette!.subarray(i * 3, i * 3 + 3), o);
        rgba[o + 3] = alpha?.[i] ?? 255;
      } else if (type === 2 || type === 6) {
        rgba.set(raw.subarray(s, s + 3), o);
        rgba[o + 3] = type === 6 ? raw[s + 3]! : 255;
      } else {
        rgba[o] = rgba[o + 1] = rgba[o + 2] = raw[s]!;
        rgba[o + 3] = type === 4 ? raw[s + 1]! : 255;
      }
    }
  }
  return { w, h, rgba };
}

/** `rgba` (`w`×`h`) averaged down to `size`×`size`. Pure.
 *
 *  A box filter: every output pixel is the mean of the source area it covers,
 *  a source pixel on the border counting by the part of it inside. Colour is
 *  averaged weighted by alpha — a transparent pixel has no colour to
 *  contribute, and counting its (usually black) RGB darkens every edge. */
export function boxDownscale(
  rgba: Uint8Array,
  w: number,
  h: number,
  size: number,
): Uint8Array {
  /** For each output cell, the source cells it covers and how much of each. */
  const spans = (from: number) =>
    Array.from({ length: size }, (_, i) => {
      const lo = i * from / size, hi = (i + 1) * from / size;
      const cells: [number, number][] = [];
      for (let s = Math.floor(lo); s < Math.min(from, Math.ceil(hi)); s++) {
        cells.push([s, Math.min(hi, s + 1) - Math.max(lo, s)]);
      }
      return cells;
    });
  const xs = spans(w), ys = spans(h);
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0, area = 0;
      for (const [sy, wy] of ys[y]!) {
        for (const [sx, wx] of xs[x]!) {
          const s = (sy * w + sx) * 4;
          const weight = wx * wy;
          const wa = weight * rgba[s + 3]!;
          r += rgba[s]! * wa;
          g += rgba[s + 1]! * wa;
          b += rgba[s + 2]! * wa;
          a += wa;
          area += weight;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round(a / area);
      }
    }
  }
  return out;
}

/** A Windows `.ico` cut from a square PNG larger than an icon image may be —
 *  one image per {@link ICO_SIZES} — or why this PNG cannot be cut. */
export async function icoFromLargePng(
  png: Uint8Array,
): Promise<Uint8Array | string> {
  const img = await decodePng(png);
  if (typeof img === "string") return img;
  if (img.w !== img.h) return "not square";
  return icoFromPngs(
    await Promise.all(
      ICO_SIZES.map((s) =>
        pngFromRgba(boxDownscale(img.rgba, img.w, img.h, s), s)
      ),
    ),
  );
}
