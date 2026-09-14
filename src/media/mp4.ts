/**
 * @module
 * An MP4 (ISO BMFF) writer for ONE H.264 video track — pure bytes in, bytes
 * out. Same reasoning as the WebM writer: WebCodecs already did the hard part,
 * and the container is a fixed tree of boxes.
 *
 * `moov` is written BEFORE `mdat` ("fast start"), so a browser can start
 * playing and seeking before the whole file has arrived.
 */

import { assertChunks, cat, type EncodedChunk } from "./chunks.ts";

const MEDIA_TIMESCALE = 90_000; // the video convention; 32-bit durations last ~13h
const MOVIE_TIMESCALE = 1000;

const u8 = (v: number) => new Uint8Array([v & 0xff]);
const u16 = (v: number) => {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, v);
  return b;
};
const u32 = (v: number) => {
  if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) {
    throw new Error(
      `[aio:video] MP4: ${v} does not fit a 32-bit field — the video is too ` +
        `long or too large for this writer`,
    );
  }
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v);
  return b;
};
const zeros = (n: number) => new Uint8Array(n);
const ascii = (s: string) => new TextEncoder().encode(s);

const box = (type: string, ...body: Uint8Array[]): Uint8Array => {
  const content = cat(body);
  return cat([u32(content.length + 8), ascii(type), content]);
};
/** A "full box": version + 24-bit flags before the body. */
const fullBox = (
  type: string,
  version: number,
  flags: number,
  ...body: Uint8Array[]
) =>
  box(type, u8(version), u8(flags >> 16), u8(flags >> 8), u8(flags), ...body);

/** The identity transform every track and movie header carries. */
const MATRIX = cat([
  u32(0x00010000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x00010000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x40000000),
]);

/** Wrap H.264 chunks into a fast-start MP4.
 *
 *  `avcC` is the decoder configuration WebCodecs reports
 *  (`decoderConfig.description` with `avc: { format: "avc" }`), and the chunks
 *  must be in that length-prefixed form. `durationUs` is the end of the video
 *  — the last frame is shown until then. */
export function muxMp4(
  track: { width: number; height: number; avcC: Uint8Array },
  chunks: readonly EncodedChunk[],
  durationUs: number,
): Uint8Array {
  assertChunks(chunks, "MP4");
  if (track.avcC.length < 7 || track.avcC[0] !== 1) {
    throw new Error(
      "[aio:video] MP4: the encoder gave no usable avcC decoder configuration " +
        "— the H.264 stream cannot be described, so no player could open it",
    );
  }
  const ticks = (us: number) => Math.round(us * MEDIA_TIMESCALE / 1e6);
  const end = Math.max(ticks(durationUs), ticks(chunks.at(-1)!.us) + 1);
  const mediaDuration = end - ticks(chunks[0]!.us);
  const movieDuration = Math.round(
    mediaDuration * MOVIE_TIMESCALE / MEDIA_TIMESCALE,
  );

  // stts: run-length (count, delta) of each sample's duration.
  const deltas = chunks.map((c, i) =>
    (i + 1 < chunks.length ? ticks(chunks[i + 1]!.us) : end) - ticks(c.us)
  );
  const runs: [number, number][] = [];
  for (const d of deltas) {
    const last = runs.at(-1);
    if (last && last[1] === d) last[0]++;
    else runs.push([1, d]);
  }
  const keys = chunks.flatMap((c, i) => (c.key ? [i + 1] : []));

  const { width: w, height: h } = track;
  const avc1 = box(
    "avc1",
    zeros(6),
    u16(1), // data reference index
    zeros(16),
    u16(w),
    u16(h),
    u32(0x00480000), // 72 dpi
    u32(0x00480000),
    zeros(4),
    u16(1), // frame count
    zeros(32), // compressor name
    u16(0x0018), // depth
    u16(0xffff),
    box("avcC", track.avcC),
  );
  const stbl = (chunkOffset: number) =>
    box(
      "stbl",
      fullBox("stsd", 0, 0, u32(1), avc1),
      fullBox(
        "stts",
        0,
        0,
        u32(runs.length),
        ...runs.flatMap(([n, d]) => [u32(n), u32(d)]),
      ),
      fullBox("stss", 0, 0, u32(keys.length), ...keys.map(u32)),
      // Every sample in ONE chunk, so one stsc entry and one offset.
      fullBox("stsc", 0, 0, u32(1), u32(1), u32(chunks.length), u32(1)),
      fullBox(
        "stsz",
        0,
        0,
        u32(0),
        u32(chunks.length),
        ...chunks.map((c) => u32(c.data.length)),
      ),
      fullBox("stco", 0, 0, u32(1), u32(chunkOffset)),
    );
  const moov = (chunkOffset: number) =>
    box(
      "moov",
      fullBox(
        "mvhd",
        0,
        0,
        u32(0),
        u32(0),
        u32(MOVIE_TIMESCALE),
        u32(movieDuration),
        u32(0x00010000), // rate 1.0
        u16(0x0100), // volume 1.0
        zeros(10),
        MATRIX,
        zeros(24),
        u32(2), // next track id
      ),
      box(
        "trak",
        fullBox(
          "tkhd",
          0,
          3, // enabled | in movie
          u32(0),
          u32(0),
          u32(1), // track id
          zeros(4),
          u32(movieDuration),
          zeros(8),
          u16(0), // layer
          u16(0), // alternate group
          u16(0), // volume (video)
          zeros(2),
          MATRIX,
          u32(w * 0x10000),
          u32(h * 0x10000),
        ),
        box(
          "mdia",
          fullBox(
            "mdhd",
            0,
            0,
            u32(0),
            u32(0),
            u32(MEDIA_TIMESCALE),
            u32(mediaDuration),
            u16(0x55c4), // language "und"
            u16(0),
          ),
          fullBox(
            "hdlr",
            0,
            0,
            zeros(4),
            ascii("vide"),
            zeros(12),
            ascii("VideoHandler\0"),
          ),
          box(
            "minf",
            fullBox("vmhd", 0, 1, zeros(8)),
            box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1))),
            stbl(chunkOffset),
          ),
        ),
      ),
    );
  const ftyp = box(
    "ftyp",
    ascii("isom"),
    u32(0x200),
    ascii("isom"),
    ascii("iso2"),
    ascii("avc1"),
    ascii("mp41"),
  );
  // The offset is a fixed-width field, so moov's size does not depend on it.
  const moovSize = moov(0).length;
  const data = cat(chunks.map((c) => c.data));
  const mdatHeader = cat([u32(data.length + 8), ascii("mdat")]);
  const offset = ftyp.length + moovSize + mdatHeader.length;
  return cat([ftyp, moov(offset), mdatHeader, data]);
}
