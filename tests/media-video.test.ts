// The pure half of aio's video writer: which frames get encoded and when, the
// codec a size needs, and the MP4/WebM box trees around encoded chunks.
//
// A real encoder's output is proven by the real-Chromium tests
// (ui-video-e2e, am-shot-video), which decode the files with ffprobe. These
// pin the arithmetic that decides what a player sees — a frame held too long,
// a timestamp two frames share, a cue that points at the wrong byte — none of
// which a successful decode would notice.
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  codecCandidates,
  FRAME_RATE,
  planFrames,
  videoFormatOf,
} from "../src/media/encoder.ts";
import {
  assertChunks,
  type EncodedChunk,
  fromB64,
  toB64,
} from "../src/media/chunks.ts";
import { muxMp4 } from "../src/media/mp4.ts";
import { muxWebm } from "../src/media/webm.ts";
import { jpegSize } from "../src/media/screencast.ts";

const TICK = 1e6 / FRAME_RATE;
const onGrid = (us: number) => Math.abs(us - Math.round(us / TICK) * TICK) <= 1;

Deno.test("videoFormatOf: the extension picks the container; anything else is refused", () => {
  assertEquals(videoFormatOf("a/b.mp4"), "mp4");
  assertEquals(videoFormatOf("B.WEBM"), "webm");
  for (const bad of ["demo.mov", "demo", "videos/"]) {
    assertThrows(() => videoFormatOf(bad), Error, ".mp4 or .webm");
  }
});

Deno.test("codecCandidates: H.264 level follows the frame size; VP8 has none", () => {
  assertEquals(codecCandidates("webm", 4000, 4000), ["vp8"]);
  assertEquals(codecCandidates("mp4", 1024, 768), [
    "avc1.64001f",
    "avc1.4d001f",
    "avc1.42001f",
  ]);
  // 1080p is 8160 macroblocks — past 3.1's 3600, inside 4.0's 8192.
  assertEquals(codecCandidates("mp4", 1920, 1080)[0], "avc1.640028");
  assertEquals(codecCandidates("mp4", 3840, 2160)[0], "avc1.640033");
  assertThrows(() => codecCandidates("mp4", 8000, 8000), Error, ".webm");
});

Deno.test("planFrames: every frame on the 60 fps grid, strictly increasing, first is a keyframe", () => {
  const plan = planFrames([0, 5_000, 400_123, 3_700_000], 5_000_000);
  assert(plan[0]!.key && plan[0]!.us === 0);
  for (let i = 0; i < plan.length; i++) {
    assert(onGrid(plan[i]!.us), `frame ${i} at ${plan[i]!.us} is off-grid`);
    if (i > 0) {
      assert(plan[i]!.us > plan[i - 1]!.us, `frame ${i} not after ${i - 1}`);
    }
  }
});

Deno.test("planFrames: two stills in one tick keep the NEWER one", () => {
  // 0 and 5 ms share slot 0 — the recorder must show what was painted last.
  const plan = planFrames([0, 5_000], 200_000);
  assertEquals(plan[0], { src: 1, us: 0, key: true });
  assertEquals(plan.filter((p) => p.src === 0).length, 0);
});

Deno.test("planFrames: a held still repeats each second, keyframes at most 2 s apart, tail before the end", () => {
  const plan = planFrames([0], 5_000_000);
  assertEquals(plan.map((p) => p.src), [0, null, null, null, null, null]);
  const us = plan.map((p) => p.us);
  assertEquals(us.slice(0, 5), [0, 1e6, 2e6, 3e6, 4e6]);
  assertEquals(us.at(-1), 4_900_000); // TAIL: 100 ms before the end
  const keys = plan.filter((p) => p.key).map((p) => p.us);
  for (let i = 1; i < keys.length; i++) assert(keys[i]! - keys[i - 1]! <= 2e6);
  assertEquals(planFrames([], 1e6), []);
});

Deno.test("assertChunks: empty, non-key first, and non-increasing times are refused", () => {
  const c = (us: number, key = false): EncodedChunk => ({
    us,
    key,
    data: new Uint8Array([1]),
  });
  assertThrows(() => assertChunks([], "MP4"));
  assertThrows(() => assertChunks([c(0)], "MP4"));
  assertThrows(() => assertChunks([c(0, true), c(0)], "WebM"));
  assertChunks([c(0, true), c(1000)], "WebM");
});

Deno.test("toB64/fromB64: round-trip past the 32 KB slice boundary", () => {
  const u8 = new Uint8Array(100_000).map((_, i) => (i * 7) & 0xff);
  assertEquals(fromB64(toB64(u8)), u8);
});

Deno.test("jpegSize: reads the SOF header, skipping segments before it; not-a-JPEG is null", () => {
  const jpeg = new Uint8Array([
    0xff,
    0xd8, // SOI
    0xff,
    0xe0,
    0x00,
    0x04,
    0x00,
    0x00, // APP0, 2 bytes of body
    0xff,
    0xc4,
    0x00,
    0x03,
    0x00, // DHT — a C-range marker that is NOT a frame
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    0x02,
    0x58,
    0x03,
    0x20,
    0x03,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);
  assertEquals(jpegSize(jpeg), { width: 800, height: 600 });
  assertEquals(jpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null);
});

// ── containers ───────────────────────────────────────────────────────────

const CHUNKS: EncodedChunk[] = [
  { us: 0, key: true, data: new Uint8Array([1, 1, 1]) },
  { us: 500_000, key: false, data: new Uint8Array([2, 2]) },
  { us: 2_000_000, key: true, data: new Uint8Array([3, 3, 3, 3]) },
];

type Box = { type: string; start: number; size: number; body: Uint8Array };
function boxes(u8: Uint8Array, from = 0, to = u8.length): Box[] {
  const dv = new DataView(u8.buffer, u8.byteOffset);
  const out: Box[] = [];
  for (let at = from; at < to;) {
    const size = dv.getUint32(at);
    if (size < 8) throw new Error(`box at ${at} has size ${size}`);
    const type = new TextDecoder().decode(u8.subarray(at + 4, at + 8));
    out.push({ type, start: at, size, body: u8.subarray(at + 8, at + size) });
    at += size;
  }
  return out;
}
const find = (u8: Uint8Array, path: string[]): Box => {
  let list = boxes(u8);
  let hit: Box | undefined;
  for (const t of path) {
    hit = list.find((b) => b.type === t);
    assert(hit, `no ${t} box in ${path.join("/")}`);
    // stsd's children start after its version/flags + entry count, avc1's
    // after the 78-byte visual sample entry; the rest start at once.
    const skip = t === "stsd" ? 8 : t === "avc1" ? 78 : 0;
    if (!["stts", "stss", "stsz", "stco", "stsc", "mdhd", "mvhd"].includes(t)) {
      list = boxes(u8, hit.start + 8 + skip, hit.start + hit.size);
    }
  }
  return hit!;
};

Deno.test("muxMp4: fast-start box order, sample tables, and stco pointing at the first sample", () => {
  const avcC = new Uint8Array([1, 0x64, 0, 0x1f, 0xff, 0xe0, 0]);
  const mp4 = muxMp4({ width: 640, height: 480, avcC }, CHUNKS, 3_000_000);
  assertEquals(boxes(mp4).map((b) => b.type), ["ftyp", "moov", "mdat"]);
  const stbl = ["moov", "trak", "mdia", "minf", "stbl"];
  const dv = (b: Box) => new DataView(b.body.buffer, b.body.byteOffset);
  const stsz = find(mp4, [...stbl, "stsz"]);
  assertEquals(dv(stsz).getUint32(8), 3); // sample count
  assertEquals([12, 16, 20].map((o) => dv(stsz).getUint32(o)), [3, 2, 4]);
  const stss = find(mp4, [...stbl, "stss"]);
  assertEquals([4, 8, 12].map((o) => dv(stss).getUint32(o)), [2, 1, 3]);
  // stts: 0→0.5 s, 0.5→2 s, 2→3 s at 90 kHz.
  const stts = find(mp4, [...stbl, "stts"]);
  assertEquals(dv(stts).getUint32(4), 3);
  assertEquals(
    [8, 12, 16, 20, 24, 28].map((o) => dv(stts).getUint32(o)),
    [1, 45_000, 1, 135_000, 1, 90_000],
  );
  const offset = dv(find(mp4, [...stbl, "stco"])).getUint32(8);
  const mdat = boxes(mp4).find((b) => b.type === "mdat")!;
  assertEquals(offset, mdat.start + 8);
  assertEquals([...mp4.subarray(offset, offset + 3)], [1, 1, 1]);
  const mdhd = find(mp4, ["moov", "trak", "mdia", "mdhd"]);
  assertEquals(dv(mdhd).getUint32(12), 90_000);
  assertEquals(dv(mdhd).getUint32(16), 270_000); // 3 s
  assertEquals([...find(mp4, [...stbl, "stsd", "avc1", "avcC"]).body], [
    ...avcC,
  ]);
});

Deno.test("muxMp4: an unusable avcC is refused rather than written", () => {
  assertThrows(
    () =>
      muxMp4(
        { width: 2, height: 2, avcC: new Uint8Array([0, 1]) },
        CHUNKS,
        1e6,
      ),
    Error,
    "avcC",
  );
});

/** Minimal EBML walk: [id, dataStart, dataEnd] of each child in a range. */
function ebml(
  u8: Uint8Array,
  from: number,
  to: number,
): [number, number, number][] {
  const out: [number, number, number][] = [];
  const vint = (at: number, keepMarker: boolean): [number, number] => {
    const first = u8[at]!;
    let len = 1;
    while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
    let v = keepMarker ? first : first & (0xff >> len);
    for (let i = 1; i < len; i++) v = v * 256 + u8[at + i]!;
    return [v, len];
  };
  for (let at = from; at < to;) {
    const [id, il] = vint(at, true);
    const [size, sl] = vint(at + il, false);
    const start = at + il + sl;
    out.push([id, start, start + size]);
    at = start + size;
  }
  return out;
}

Deno.test("muxWebm: cues come before the clusters and each points at a keyframe cluster", () => {
  const webm = muxWebm({ width: 640, height: 480 }, CHUNKS, 3_000_000);
  const top = ebml(webm, 0, webm.length);
  assertEquals(top.map(([id]) => id), [0x1A45DFA3, 0x18538067]);
  const [, segStart, segEnd] = top[1]!;
  const seg = ebml(webm, segStart, segEnd);
  const ids = seg.map(([id]) => id);
  assertEquals(ids.slice(0, 3), [0x1549A966, 0x1654AE6B, 0x1C53BB6B]);
  const clusters = seg.filter(([id]) => id === 0x1F43B675);
  assertEquals(clusters.length, 2); // a new cluster at each keyframe
  const [, cuesStart, cuesEnd] = seg[2]!;
  const positions = ebml(webm, cuesStart, cuesEnd).map(([, s, e]) => {
    const trackPos = ebml(webm, s, e).find(([id]) => id === 0xB7)!;
    const pos = ebml(webm, trackPos[1], trackPos[2]).find(([id]) =>
      id === 0xF1
    )!;
    let v = 0;
    for (let i = pos[1]; i < pos[2]; i++) v = v * 256 + webm[i]!;
    return v;
  });
  // CueClusterPosition is relative to the segment's data start, and must
  // land on a Cluster's id (the element header, not its data).
  for (const p of positions) {
    const at = segStart + p;
    assertEquals([...webm.subarray(at, at + 4)], [0x1F, 0x43, 0xB6, 0x75]);
  }
  const blocks = clusters.flatMap(([, s, e]) =>
    ebml(webm, s, e).filter(([id]) => id === 0xA3)
  );
  assertEquals(blocks.length, 3);
});
