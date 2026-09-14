/**
 * @module
 * A WebM (Matroska) writer for ONE video track — pure bytes in, bytes out.
 *
 * Written here rather than depending on ffmpeg: every aio video is a handful
 * of encoded chunks that WebCodecs already produced, and wrapping them is a
 * few dozen EBML elements. A native dependency for that would be a second
 * install step on every machine that wants a video.
 *
 * Seekable on purpose: `Cues` sit BEFORE the clusters (sizes are fixed-width,
 * so their positions are computable up front). A WebM without cues plays, but
 * a browser's `<video>` refuses to seek in it — and scrubbing to the step that
 * failed is the reason to have a test video at all.
 */

import { assertChunks, cat, type EncodedChunk } from "./chunks.ts";

const enc = new TextEncoder();

/** An EBML element id's own bytes (the marker bits are part of the id). */
function idBytes(id: number): Uint8Array {
  const out: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return new Uint8Array(out);
}

/** An 8-byte EBML size — fixed width, so an element's size never depends on
 *  its contents' size (what makes cue positions computable up front). */
function size8(n: number): Uint8Array {
  const b = new Uint8Array(8);
  b[0] = 0x01;
  let v = BigInt(n);
  for (let i = 7; i >= 1; i--) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}

const el = (id: number, ...kids: Uint8Array[]): Uint8Array => {
  const body = cat(kids);
  return cat([idBytes(id), size8(body.length), body]);
};
const uint = (id: number, v: number, width = 0): Uint8Array => {
  const b: number[] = [];
  let x = v;
  do {
    b.unshift(x & 0xff);
    x = Math.floor(x / 256);
  } while (x > 0);
  while (b.length < width) b.unshift(0);
  return el(id, new Uint8Array(b));
};
const str = (id: number, s: string) => el(id, enc.encode(s));
const f64 = (id: number, v: number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v);
  return el(id, b);
};

/** A cluster's relative block time is an int16 of milliseconds. */
const CLUSTER_MAX_MS = 30_000;

/** Wrap VP8 chunks into a seekable WebM file.
 *
 *  `chunks` are in presentation order with microsecond timestamps; the first
 *  must be a keyframe. `durationUs` is the end of the video — the last frame
 *  is shown until then. */
export function muxWebm(
  track: { width: number; height: number },
  chunks: readonly EncodedChunk[],
  durationUs: number,
): Uint8Array {
  assertChunks(chunks, "WebM");
  const ms = (us: number) => Math.round(us / 1000);
  // Clusters: a new one at every keyframe (so each cue points at one), and
  // never longer than an int16 of milliseconds.
  const clusters: { tc: number; key: boolean; body: Uint8Array }[] = [];
  let cur: { tc: number; key: boolean; blocks: Uint8Array[] } | null = null;
  const close = () => {
    if (!cur) return;
    clusters.push({
      tc: cur.tc,
      key: cur.key,
      body: el(0x1F43B675, uint(0xE7, cur.tc), ...cur.blocks),
    });
    cur = null;
  };
  for (const c of chunks) {
    const t = ms(c.us);
    if (!cur || c.key || t - cur.tc > CLUSTER_MAX_MS) {
      close();
      cur = { tc: t, key: c.key, blocks: [] };
    }
    const hdr = new Uint8Array(4);
    hdr[0] = 0x81; // track number 1, as a 1-byte vint
    new DataView(hdr.buffer).setInt16(1, t - cur.tc);
    hdr[3] = c.key ? 0x80 : 0;
    cur.blocks.push(el(0xA3, hdr, c.data));
  }
  close();

  const info = el(
    0x1549A966,
    uint(0x2AD7B1, 1_000_000), // TimecodeScale: 1 ms
    str(0x4D80, "aio"),
    str(0x5741, "aio"),
    f64(0x4489, durationUs / 1000),
  );
  const tracks = el(
    0x1654AE6B,
    el(
      0xAE,
      uint(0xD7, 1),
      uint(0x73C5, 1),
      uint(0x83, 1), // video
      str(0x86, "V_VP8"),
      el(0xE0, uint(0xB0, track.width), uint(0xBA, track.height)),
    ),
  );
  // Cues come before the clusters; with 8-byte positions their size is known
  // before the positions are, so build once with zeros to measure, then fill.
  const keyClusters = clusters.filter((c) => c.key);
  const cues = (positions: number[]) =>
    el(
      0x1C53BB6B,
      ...keyClusters.map((c, i) =>
        el(
          0xBB,
          uint(0xB3, c.tc),
          el(0xB7, uint(0xF7, 1), uint(0xF1, positions[i] ?? 0, 8)),
        )
      ),
    );
  const head = info.length + tracks.length + cues([]).length;
  const positions: number[] = [];
  let at = head;
  for (const c of clusters) {
    if (c.key) positions.push(at);
    at += c.body.length;
  }
  const segment = el(
    0x18538067,
    info,
    tracks,
    cues(positions),
    ...clusters.map((c) => c.body),
  );
  const ebml = el(
    0x1A45DFA3,
    uint(0x4286, 1),
    uint(0x42F7, 1),
    uint(0x42F2, 4),
    uint(0x42F3, 8),
    str(0x4282, "webm"),
    uint(0x4287, 2),
    uint(0x4285, 2),
  );
  return cat([ebml, segment]);
}
