/**
 * @module
 * Record a live Chromium page (an Electron window) as a video: the page's own
 * screencast while recording; afterwards host ffmpeg when it is on PATH, else
 * the page's own WebCodecs encoder.
 *
 * Recording and encoding are two phases on purpose. While recording, the only
 * work added to the app is what Chromium already does to paint — frames are
 * JPEGs written to a temp directory, nothing is decoded or encoded. The
 * encoder runs once recording has stopped, so the video shows the app at the
 * speed it really ran.
 */

import type { CdpSession } from "./cdp.ts";
import { fromB64, toB64, type VideoFormat } from "./chunks.ts";
import {
  codecCandidates,
  openPageEncoder,
  planFrames,
  type PlannedFrame,
} from "./encoder.ts";
import { encodeWithFfmpeg } from "./ffmpeg.ts";
import { muxMp4 } from "./mp4.ts";
import { muxWebm } from "./webm.ts";

/** One recorded frame: when it was painted, and where its JPEG is. */
export type RecordedFrame = { us: number; path: string };

/** What a recording produced. */
export type Recording = {
  frames: RecordedFrame[];
  /** How long the recording ran, µs. */
  endUs: number;
  /** The page went away (window closed) before `stop` fired. */
  lost: boolean;
};

/** Pure: a JPEG's pixel size from its start-of-frame header, or null. */
export function jpegSize(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1]!;
    if (marker === 0xff) { // fill byte
      i++;
      continue;
    }
    const len = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 &&
      marker !== 0xc8 && marker !== 0xcc
    ) {
      return {
        height: (bytes[i + 5]! << 8) | bytes[i + 6]!,
        width: (bytes[i + 7]! << 8) | bytes[i + 8]!,
      };
    }
    i += 2 + len;
  }
  return null;
}

/** Record the page behind `cdp` into `dir` until `stop` resolves (or the page
 *  goes away). The first frame is a screenshot taken at the start, so a window
 *  that never repaints still has a picture; after that, a frame arrives each
 *  time the page paints. */
export async function recordScreencast(
  cdp: CdpSession,
  dir: string,
  stop: Promise<void>,
): Promise<Recording> {
  const frames: RecordedFrame[] = [];
  const writes: Promise<void>[] = [];
  const t0 = Date.now();
  const save = (us: number, data: string) => {
    const path = `${dir}/${String(frames.length).padStart(6, "0")}.jpg`;
    frames.push({ us, path });
    writes.push(Deno.writeFile(path, fromB64(data)));
  };
  let lost = false;
  const gone = cdp.closed.then(() => {
    lost = true;
  });
  const first = await cdp.call("Page.captureScreenshot", {
    format: "jpeg",
    quality: 90,
  }) as { data?: string };
  if (!first?.data) throw new Error("[aio:video] the window gave no picture");
  save(0, first.data);
  const off = cdp.on("Page.screencastFrame", (p) => {
    const f = p as {
      sessionId: number;
      data: string;
      metadata: { timestamp?: number };
    };
    // Acked first: the page sends nothing more until it is, and an ack that
    // waited on the disk would slow the recording down to the disk's pace.
    cdp.call("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(
      () => {
        // aio-ok: the only way an ack fails is a closed socket, which `gone`
        // already reports as `lost` — the recording's own answer.
      },
    );
    const at = f.metadata.timestamp !== undefined
      ? f.metadata.timestamp * 1000
      : Date.now();
    const us = Math.round((at - t0) * 1000);
    // Strictly after the previous frame: a paint stamped before the start
    // screenshot is a frame the screenshot already shows.
    if (us > frames.at(-1)!.us) save(us, f.data);
  });
  // A window closed WHILE starting or stopping the screencast is the same
  // event as one closed mid-recording: LOST, frames kept — not a throw. The
  // call's rejection can land a tick before `gone` flips `lost`, so a
  // rejected call waits (briefly) for the socket's own verdict first.
  const unlessLost = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      await Promise.race([gone, new Promise((r) => setTimeout(r, 200))]);
      if (!lost) throw e;
    }
  };
  try {
    await unlessLost(
      cdp.call("Page.startScreencast", { format: "jpeg", quality: 90 }),
    );
    if (!lost) await Promise.race([stop, gone]);
    if (!lost) await unlessLost(cdp.call("Page.stopScreencast"));
  } finally {
    off();
  }
  const endUs = Math.max((Date.now() - t0) * 1000, frames.at(-1)!.us + 1000);
  await Promise.all(writes);
  return { frames, endUs, lost };
}

/** Frames per call into the page — bounded so one `Runtime.evaluate` never
 *  carries more than a few megabytes of base64. */
const BATCH_BYTES = 6 * 1024 * 1024;

/** Which encoder `encodeRecording` uses: `"auto"` (the default) is host
 *  ffmpeg when it is on PATH, else the page's WebCodecs encoder; the other two
 *  name one and fail rather than fall back. */
export type VideoEncoderChoice = "auto" | "ffmpeg" | "page";

/** Encode a recording into a `format` file's bytes — with host ffmpeg when it
 *  is on PATH (seconds per clip), else in the page behind `cdp` (WebCodecs,
 *  measured 15–30× slower than real time inside an app window). Both write
 *  the same frames at the same times through the same container writers.
 *  An ffmpeg that is present and FAILS is never a silent bad file: the page
 *  encodes instead, and `fallback` (also warned) says why. The video is the
 *  size of the first frame. `progress` is told how many frames are done. */
export async function encodeRecording(
  cdp: CdpSession,
  rec: Recording,
  format: VideoFormat,
  progress?: (done: number, total: number) => void,
  opts: { encoder?: VideoEncoderChoice } = {},
): Promise<
  {
    bytes: Uint8Array;
    codec: string;
    width: number;
    height: number;
    /** What encoded it: `"ffmpeg libx264"`, `"ffmpeg libvpx"`, `"page"`. */
    encoder: string;
    /** Why ffmpeg was skipped or failed, when it was on PATH but not used. */
    fallback?: string;
  }
> {
  const size = jpegSize(await Deno.readFile(rec.frames[0]!.path));
  if (!size) throw new Error("[aio:video] the first frame is not a JPEG");
  const plan = planFrames(rec.frames.map((f) => f.us), rec.endUs);
  const choice = opts.encoder ?? "auto";
  let fallback: string | undefined;
  if (choice !== "page") {
    const w = Math.max(2, size.width & ~1);
    const h = Math.max(2, size.height & ~1);
    codecCandidates(format, w, h); // a size no codec takes is refused first
    try {
      const got = await ffmpegEncode(rec, format, size, w, h, plan, progress);
      if (got === null && choice === "ffmpeg") {
        throw new Error("[aio:video] no ffmpeg on PATH");
      }
      if (got !== null) {
        return {
          bytes: format === "webm"
            ? muxWebm({ width: w, height: h }, got.chunks, rec.endUs)
            : muxMp4(
              { width: w, height: h, avcC: got.avcC! },
              got.chunks,
              rec.endUs,
            ),
          codec: got.codec,
          width: w,
          height: h,
          encoder: got.encoder,
        };
      }
    } catch (e) {
      if (choice === "ffmpeg") throw e;
      fallback = e instanceof Error ? e.message : String(e);
      console.warn(`${fallback} — encoding in the page instead (slower)`);
    }
  }
  const enc = await openPageEncoder(cdp, format, size.width, size.height);
  let batch: { image?: string; mime: string; us: number; key: boolean }[] = [];
  let bytes = 0;
  const flush = async (done: number) => {
    await enc.add(batch);
    batch = [];
    bytes = 0;
    progress?.(done, plan.length);
  };
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i]!;
    const image = p.src === null
      ? undefined
      : toB64(await Deno.readFile(rec.frames[p.src]!.path));
    batch.push({ image, mime: "image/jpeg", us: p.us, key: p.key });
    bytes += image?.length ?? 0;
    if (bytes >= BATCH_BYTES) await flush(i + 1);
  }
  await flush(plan.length);
  return {
    bytes: await enc.finish(rec.endUs),
    codec: enc.codec,
    width: enc.width,
    height: enc.height,
    encoder: "page",
    ...(fallback ? { fallback } : {}),
  };
}

/** The ffmpeg half of {@linkcode encodeRecording}: `null` when there is no
 *  ffmpeg. Frames that change size mid-recording (a resized window) are
 *  fitted by the page encoder only, so that case throws here and falls back. */
async function ffmpegEncode(
  rec: Recording,
  format: VideoFormat,
  size: { width: number; height: number },
  w: number,
  h: number,
  plan: PlannedFrame[],
  progress?: (done: number, total: number) => void,
) {
  const jpeg = async (src: number) => {
    const b = await Deno.readFile(rec.frames[src]!.path);
    const s = jpegSize(b);
    if (!s || s.width !== size.width || s.height !== size.height) {
      throw new Error(
        `[aio:video] frame ${src} is ${
          s ? `${s.width}×${s.height}` : "not a JPEG"
        }, ` +
          `not ${size.width}×${size.height} — ffmpeg does not fit a resized window`,
      );
    }
    return b;
  };
  return await encodeWithFfmpeg(format, w, h, plan, jpeg, progress);
}
