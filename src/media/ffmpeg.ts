/**
 * @module
 * The host-ffmpeg ENCODER behind `encodeRecording` — used when `ffmpeg` is on
 * PATH, with the in-page WebCodecs encoder as the fallback.
 *
 * WHY: the in-page encoder measured 15–30× slower than real time at 1600×900
 * inside an app window (a 29 s demo took ~13 min to encode, and the app's own
 * autolock fired while it sat idle). libx264/libvpx on the host encode the
 * same frames in seconds.
 *
 * ffmpeg is ONLY the encoder: it gets the planned frames (`planFrames`) one
 * JPEG per slot and hands back one encoded frame per slot, which are then
 * stamped with the plan's own times and written by aio's own MP4/WebM
 * writers. So both paths produce the same container, the same frame times
 * and the same duration by construction — not by matching ffmpeg's muxer.
 */

import type { EncodedChunk, VideoFormat } from "./chunks.ts";
import { codecCandidates, FRAME_RATE, type PlannedFrame } from "./encoder.ts";

/** Pure: the NAL units of an Annex-B H.264 stream (start codes removed). */
export function annexBUnits(b: Uint8Array): Uint8Array[] {
  const starts: { at: number; len: number }[] = [];
  for (let i = 0; i + 2 < b.length; i++) {
    if (b[i] === 0 && b[i + 1] === 0) {
      if (b[i + 2] === 1) {
        starts.push({ at: i, len: 3 });
        i += 2;
      } else if (b[i + 2] === 0 && b[i + 3] === 1) {
        starts.push({ at: i, len: 4 });
        i += 3;
      }
    }
  }
  return starts.map((s, k) =>
    b.subarray(
      s.at + s.len,
      k + 1 < starts.length ? starts[k + 1]!.at : b.length,
    )
  );
}

/** Pure: an Annex-B stream written with an access-unit delimiter before every
 *  frame (`aud=1`), as MP4 samples — the VCL units of each frame, each behind
 *  a 4-byte length — plus the SPS/PPS as an `avcC` record. */
export function h264Samples(
  stream: Uint8Array,
): { frames: { key: boolean; data: Uint8Array }[]; avcC: Uint8Array } {
  let sps: Uint8Array | null = null;
  let pps: Uint8Array | null = null;
  const frames: { key: boolean; data: Uint8Array }[] = [];
  let cur: Uint8Array[] | null = null;
  let key = false;
  const close = () => {
    if (!cur || cur.length === 0) return;
    const n = cur.reduce((a, u) => a + 4 + u.length, 0);
    const data = new Uint8Array(n);
    let i = 0;
    for (const u of cur) {
      new DataView(data.buffer).setUint32(i, u.length);
      data.set(u, i + 4);
      i += 4 + u.length;
    }
    frames.push({ key, data });
  };
  for (const u of annexBUnits(stream)) {
    const type = u[0]! & 0x1f;
    if (type === 9) { // access-unit delimiter: a new frame starts
      close();
      cur = [];
      key = false;
    } else if (type === 7) sps ??= u;
    else if (type === 8) pps ??= u;
    else if (type >= 1 && type <= 5) {
      if (!cur) {
        throw new Error(
          "[aio:video] ffmpeg: H.264 frame data before any access-unit delimiter",
        );
      }
      cur.push(u);
      if (type === 5) key = true;
    }
  }
  close();
  if (!sps || !pps) {
    throw new Error("[aio:video] ffmpeg: no SPS/PPS in the H.264 stream");
  }
  const avcC = new Uint8Array([
    1,
    sps[1]!,
    sps[2]!,
    sps[3]!,
    0xff,
    0xe1,
    sps.length >> 8,
    sps.length & 0xff,
    ...sps,
    1,
    pps.length >> 8,
    pps.length & 0xff,
    ...pps,
  ]);
  return { frames, avcC };
}

/** Pure: the frames of an IVF file (the VP8 elementary-stream wrapper). A VP8
 *  frame is a keyframe when bit 0 of its first byte is 0. */
export function ivfFrames(b: Uint8Array): { key: boolean; data: Uint8Array }[] {
  if (b.length < 32 || String.fromCharCode(...b.subarray(0, 4)) !== "DKIF") {
    throw new Error("[aio:video] ffmpeg: the VP8 output is not an IVF stream");
  }
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: { key: boolean; data: Uint8Array }[] = [];
  for (let i = dv.getUint16(6, true); i + 12 <= b.length;) {
    const size = dv.getUint32(i, true);
    const data = b.subarray(i + 12, i + 12 + size);
    if (data.length !== size) {
      throw new Error("[aio:video] ffmpeg: a truncated IVF frame");
    }
    out.push({ key: (data[0]! & 1) === 0, data });
    i += 12 + size;
  }
  return out;
}

/** Pure: the ffmpeg command line for `format` at `width`×`height` (both even,
 *  the source cropped at the origin like the in-page encoder does), fed
 *  JPEGs on stdin one per planned frame at {@linkcode FRAME_RATE}, with a
 *  keyframe forced at every frame index in `keys`. */
export function ffmpegArgs(
  format: VideoFormat,
  width: number,
  height: number,
  keys: readonly number[],
): string[] {
  // Just before the frame's own time: a forced time is matched against
  // `pts >= t`, and a decimal that rounded up would land on the next frame.
  const at = keys.map((i) => Math.max(0, (i - 0.5) / FRAME_RATE).toFixed(6));
  // The level the in-page encoder would ask for at this size.
  const level =
    parseInt(codecCandidates("mp4", width, height)[0]!.slice(-2), 16) / 10;
  const bitrate = Math.round(Math.min(20e6, Math.max(1e6, width * height * 3)));
  const codec = format === "mp4"
    // No B-frames: the writers take frames in presentation order. An
    // access-unit delimiter before every frame is how the stream is split.
    ? `-c:v libx264 -preset veryfast -crf 18 -profile:v high -level:v ${level} -bf 0 -x264-params aud=1 -f h264`
    // No invisible alt-ref frames (one output frame per input frame), and no
    // keyframes but the forced ones — libvpx otherwise adds its own.
    : `-c:v libvpx -deadline good -cpu-used 5 -b:v ${bitrate} -auto-alt-ref 0 -lag-in-frames 0 -g 100000 -keyint_min 100000 -f ivf`;
  return [
    ..."-hide_banner -loglevel error -nostdin -f image2pipe".split(" "),
    ...`-framerate ${FRAME_RATE} -c:v mjpeg -i pipe:0`.split(" "),
    ...`-vf crop=${width}:${height}:0:0,format=yuv420p`.split(" "),
    ..."-fps_mode passthrough -force_key_frames".split(" "),
    at.join(",") || "0",
    ...codec.split(" "),
    "pipe:1",
  ];
}

/** What {@linkcode encodeWithFfmpeg} returns: chunks stamped with the plan's
 *  times, ready for the same writers the in-page encoder feeds. */
export type FfmpegEncoded = {
  chunks: EncodedChunk[];
  codec: string;
  avcC?: Uint8Array;
  encoder: string;
};

/** Encode `plan` (whose `src` indexes `jpegs`) with the host's ffmpeg, or
 *  `null` when there is no ffmpeg on PATH. Any other failure THROWS — a
 *  wrong frame count, a stream that does not parse, a non-zero exit — so the
 *  caller can fall back loudly rather than write a bad file. */
export async function encodeWithFfmpeg(
  format: VideoFormat,
  width: number,
  height: number,
  plan: readonly PlannedFrame[],
  jpeg: (src: number) => Promise<Uint8Array>,
  progress?: (done: number, total: number) => void,
  bin = "ffmpeg",
): Promise<FfmpegEncoded | null> {
  const keys = plan.flatMap((p, i) => p.key ? [i] : []);
  let proc: Deno.ChildProcess;
  try {
    proc = new Deno.Command(bin, {
      args: ffmpegArgs(format, width, height, keys),
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
  // Read both pipes while writing: ffmpeg blocks on a full stdout otherwise.
  const out = new Response(proc.stdout).bytes();
  const err = new Response(proc.stderr).text();
  const w = proc.stdin.getWriter();
  let fed: Error | null = null;
  try {
    let last: Uint8Array | null = null;
    for (let i = 0; i < plan.length; i++) {
      const src = plan[i]!.src;
      if (src !== null) last = await jpeg(src);
      await w.write(last!);
      if ((i + 1) % 60 === 0) progress?.(i + 1, plan.length);
    }
    await w.close();
  } catch (e) {
    // A write fails when ffmpeg has already exited — its stderr says why.
    fed = e instanceof Error ? e : new Error(String(e));
    await w.abort().catch(() => {
      // aio-ok: the pipe is already broken; the exit status below reports it.
    });
  }
  const [status, bytes, text] = await Promise.all([proc.status, out, err]);
  if (!status.success || fed) {
    throw new Error(
      `[aio:video] ffmpeg exited ${status.code}: ${
        text.trim().split("\n").slice(-3).join(" | ") || fed?.message
      }`,
    );
  }
  let frames: { key: boolean; data: Uint8Array }[];
  let avcC: Uint8Array | undefined;
  if (format === "mp4") ({ frames, avcC } = h264Samples(bytes));
  else frames = ivfFrames(bytes);
  if (frames.length !== plan.length) {
    throw new Error(
      `[aio:video] ffmpeg wrote ${frames.length} frames for ${plan.length} — ` +
        `the video's timing would not match the recording`,
    );
  }
  progress?.(plan.length, plan.length);
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return {
    chunks: frames.map((f, i) => ({ ...f, us: plan[i]!.us })),
    codec: avcC
      ? `avc1.${hex(avcC[1]!)}${hex(avcC[2]!)}${hex(avcC[3]!)}`
      : "vp8",
    ...(avcC ? { avcC } : {}),
    encoder: format === "mp4" ? "ffmpeg libx264" : "ffmpeg libvpx",
  };
}
