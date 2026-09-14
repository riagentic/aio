/**
 * @module
 * Turn still images into a video file, using the WebCodecs encoder of a
 * Chromium page reached over CDP.
 *
 * WHY a page: Chromium already ships VP8 and H.264 encoders, and every place
 * aio records from already HAS a Chromium page — the Electron window
 * (`am shot --video`) or the headless tab that draws a test's steps. Borrowing
 * its encoder means no ffmpeg, no native module, no second install step.
 *
 * The encoder lives in an ISOLATED WORLD: it shares the page's pixels and DOM
 * but none of its globals, so recording can neither see nor disturb the app's
 * own scripts.
 */

import type { CdpSession } from "./cdp.ts";
import { type EncodedChunk, fromB64, type VideoFormat } from "./chunks.ts";
import { muxMp4 } from "./mp4.ts";
import { muxWebm } from "./webm.ts";

/** Pure: the container a file name asks for, or a throw naming the two that
 *  exist. An unknown extension is refused rather than guessed — a `.mov`
 *  written as MP4 bytes is a file that opens in some players and not others. */
export function videoFormatOf(path: string): VideoFormat {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  if (ext === "mp4" || ext === "webm") return ext;
  throw new Error(
    `[aio:video] ${path}: a video file must end in .mp4 or .webm ` +
      `(the extension picks the format)`,
  );
}

/** One frame to encode: a new image, or `null` to repeat the previous one. */
export type PlannedFrame = { src: number | null; us: number; key: boolean };

/** The time grid frames are placed on. No screen shows more than this, and a
 *  file with two frames inside one of its ticks is one a player (or ffmpeg)
 *  must drop a frame from — so the recorder drops it, choosing the newer. */
export const FRAME_RATE = 60;
/** Longest a frame is held before it is repeated. A still that is never
 *  re-sent makes a file a player can only seek to at its keyframes. */
const HOLD_US = 1_000_000;
/** A keyframe at least this often — the seek granularity. */
const KEY_US = 2_000_000;
/** The last frame is repeated this long before the end, so it is SHOWN until
 *  the end in players that give the final sample no duration of its own. */
const TAIL_US = 100_000;

const slotOf = (us: number) => Math.round(us * FRAME_RATE / 1e6);
const usOf = (slot: number) => Math.round(slot * 1e6 / FRAME_RATE);

/** Pure: the frames to encode for stills shown at `times` (µs, ascending),
 *  with the video ending at `endUs`. Every frame sits on the
 *  {@linkcode FRAME_RATE} grid; stills that land in one slot keep the newest.
 *  A held still is repeated every second, a keyframe comes at least every two,
 *  and the final still is repeated just before the end. */
export function planFrames(
  times: readonly number[],
  endUs: number,
): PlannedFrame[] {
  const out: (PlannedFrame & { slot: number })[] = [];
  let lastKey = -Infinity;
  const push = (src: number | null, at: number) => {
    const prev = out.at(-1);
    const slot = Math.max(0, slotOf(at));
    if (prev && slot <= prev.slot) {
      // Same tick: a newer still replaces what is there; a repeat adds nothing.
      if (src !== null) prev.src = src;
      return;
    }
    const us = usOf(slot);
    const key = us - lastKey >= KEY_US;
    if (key) lastKey = us;
    out.push({ src, us, key, slot });
  };
  for (let i = 0; i < times.length; i++) {
    push(i, times[i]!);
    const next = i + 1 < times.length ? times[i + 1]! : endUs - TAIL_US;
    for (let t = out.at(-1)!.us + HOLD_US; t < next; t += HOLD_US) {
      push(null, t);
    }
  }
  if (times.length > 0) push(null, endUs - TAIL_US);
  return out.map(({ src, us, key }) => ({ src, us, key }));
}

/** Pure: the WebCodecs codec strings to try for `format` at this size, best
 *  first. H.264 needs a LEVEL that admits the frame size, so it is derived
 *  from the size rather than fixed — a fixed 3.1 refuses anything above 720p. */
export function codecCandidates(
  format: VideoFormat,
  width: number,
  height: number,
): string[] {
  if (format === "webm") return ["vp8"];
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const level =
    ([[3600, "1f"], [8192, "28"], [22080, "32"], [36864, "33"]] as const)
      .find(([max]) => mbs <= max)?.[1];
  if (!level) {
    throw new Error(
      `[aio:video] ${width}×${height} is too large for H.264 — record a ` +
        `smaller window, or write .webm`,
    );
  }
  return [`avc1.6400${level}`, `avc1.4d00${level}`, `avc1.4200${level}`];
}

/** The script installed into the isolated world. Plain JS on purpose — it is
 *  evaluated in the page, not transpiled. */
const PAGE_ENCODER = `(() => {
  const b64 = (u8) => {
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    }
    return btoa(s);
  };
  const S = { enc: null, chunks: [], description: null, err: null };
  globalThis.__aioVideo = {
    async init(codecs, width, height, bitrate) {
      if (typeof VideoEncoder !== "function") {
        return { error: "this page has no WebCodecs VideoEncoder (secure context: " + isSecureContext + ")" };
      }
      for (const codec of codecs) {
        const cfg = { codec, width, height, bitrate, framerate: 30, latencyMode: "quality" };
        if (codec.startsWith("avc1")) cfg.avc = { format: "avc" };
        let ok = false;
        try { ok = (await VideoEncoder.isConfigSupported(cfg)).supported === true; } catch {}
        if (!ok) continue;
        S.canvas = new OffscreenCanvas(width, height);
        S.ctx = S.canvas.getContext("2d");
        S.ctx.fillStyle = "#fff";
        S.ctx.fillRect(0, 0, width, height);
        S.enc = new VideoEncoder({
          output: (chunk, meta) => {
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            S.chunks.push({ us: chunk.timestamp, key: chunk.type === "key", data });
            const d = meta && meta.decoderConfig && meta.decoderConfig.description;
            if (d && !S.description) {
              S.description = ArrayBuffer.isView(d)
                ? new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength))
                : new Uint8Array(d);
            }
          },
          error: (e) => { S.err = String(e); },
        });
        S.enc.configure(cfg);
        S.width = width;
        S.height = height;
        return { codec };
      }
      return { error: "none of " + codecs.join(", ") + " can be encoded here" };
    },
    async add(frames) {
      for (const f of frames) {
        if (S.err) throw new Error(S.err);
        if (f.image) {
          const bin = Uint8Array.from(atob(f.image), (c) => c.charCodeAt(0));
          const bmp = await createImageBitmap(new Blob([bin], { type: f.mime }));
          // Fit, never stretch: a window resized mid-recording keeps its
          // proportions, letterboxed in the size the video started at.
          const k = Math.min(S.width / bmp.width, S.height / bmp.height);
          const dw = Math.round(bmp.width * k), dh = Math.round(bmp.height * k);
          if (dw !== S.width || dh !== S.height) {
            S.ctx.fillStyle = "#000";
            S.ctx.fillRect(0, 0, S.width, S.height);
          }
          S.ctx.drawImage(bmp, (S.width - dw) >> 1, (S.height - dh) >> 1, dw, dh);
          bmp.close();
        }
        const vf = new VideoFrame(S.canvas, { timestamp: f.us });
        S.enc.encode(vf, { keyFrame: f.key });
        vf.close();
        while (S.enc.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 1));
      }
      if (S.err) throw new Error(S.err);
      return true;
    },
    async finish() {
      await S.enc.flush();
      if (S.err) throw new Error(S.err);
      S.enc.close();
      return { count: S.chunks.length, description: S.description ? b64(S.description) : null };
    },
    take(maxBytes) {
      const out = [];
      let n = 0;
      while (S.chunks.length && (out.length === 0 || n + S.chunks[0].data.length <= maxBytes)) {
        const c = S.chunks.shift();
        n += c.data.length;
        out.push({ us: c.us, key: c.key, data: b64(c.data) });
      }
      return out;
    },
  };
  return true;
})()`;

/** Evaluate `expression` in `contextId`; a thrown page error is thrown here. */
export async function evaluateIn(
  cdp: CdpSession,
  contextId: number,
  expression: string,
): Promise<unknown> {
  const r = await cdp.call("Runtime.evaluate", {
    expression,
    contextId,
    awaitPromise: true,
    returnByValue: true,
  }) as {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(
      `[aio:video] in-page: ${d.exception?.description ?? d.text ?? "error"}`,
    );
  }
  return r.result?.value;
}

/** A fresh isolated world in the target's main frame — its execution context
 *  id. Shares the page's DOM and pixels, none of its globals. */
export async function isolatedWorld(
  cdp: CdpSession,
  name: string,
): Promise<number> {
  const tree = await cdp.call("Page.getFrameTree") as {
    frameTree: { frame: { id: string } };
  };
  const world = await cdp.call("Page.createIsolatedWorld", {
    frameId: tree.frameTree.frame.id,
    worldName: name,
  }) as { executionContextId: number };
  return world.executionContextId;
}

/** An encoder running in a page. */
export type PageEncoder = {
  /** The codec the page agreed to (`"vp8"`, `"avc1.42001f"`, …). */
  codec: string;
  width: number;
  height: number;
  /** Encode frames in order. `image` is base64 of a PNG/JPEG, or absent to
   *  repeat the previous one. */
  add(
    frames: readonly {
      image?: string;
      mime?: string;
      us: number;
      key: boolean;
    }[],
  ): Promise<void>;
  /** Flush and return the finished file's bytes, ending at `endUs`. */
  finish(endUs: number): Promise<Uint8Array>;
};

/** Open an encoder for `format` at `width`×`height` (rounded down to even —
 *  both codecs subsample colour by two) in the page behind `cdp`. */
export async function openPageEncoder(
  cdp: CdpSession,
  format: VideoFormat,
  width: number,
  height: number,
): Promise<PageEncoder> {
  const w = Math.max(2, width & ~1);
  const h = Math.max(2, height & ~1);
  const ctx = await isolatedWorld(cdp, "aio-video");
  await evaluateIn(cdp, ctx, PAGE_ENCODER);
  const bitrate = Math.round(Math.min(20e6, Math.max(1e6, w * h * 3)));
  const init = await evaluateIn(
    cdp,
    ctx,
    `__aioVideo.init(${
      JSON.stringify(codecCandidates(format, w, h))
    }, ${w}, ${h}, ${bitrate})`,
  ) as { codec?: string; error?: string };
  if (!init?.codec) {
    throw new Error(
      `[aio:video] cannot write .${format} here: ${
        init?.error ?? "no encoder"
      }` +
        (format === "mp4" ? " — try .webm (VP8 is in every Chromium)" : ""),
    );
  }
  return {
    codec: init.codec,
    width: w,
    height: h,
    async add(frames) {
      if (frames.length === 0) return;
      await evaluateIn(
        cdp,
        ctx,
        `__aioVideo.add(${
          JSON.stringify(
            frames.map((f) => ({ ...f, mime: f.mime ?? "image/png" })),
          )
        })`,
      );
    },
    async finish(endUs) {
      const done = await evaluateIn(cdp, ctx, `__aioVideo.finish()`) as {
        count: number;
        description: string | null;
      };
      const chunks: EncodedChunk[] = [];
      while (chunks.length < done.count) {
        const part = await evaluateIn(
          cdp,
          ctx,
          `__aioVideo.take(${4 * 1024 * 1024})`,
        ) as { us: number; key: boolean; data: string }[];
        if (part.length === 0) break;
        for (const c of part) {
          chunks.push({ us: c.us, key: c.key, data: fromB64(c.data) });
        }
      }
      if (format === "webm") {
        return muxWebm({ width: w, height: h }, chunks, endUs);
      }
      if (!done.description) {
        throw new Error(
          "[aio:video] the H.264 encoder reported no decoder configuration — " +
            "write .webm instead",
        );
      }
      return muxMp4(
        { width: w, height: h, avcC: fromB64(done.description) },
        chunks,
        endUs,
      );
    },
  };
}
