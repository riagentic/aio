/**
 * @module
 * `am shot --video[=file.mp4|.webm]` — record the live Electron window until
 * Ctrl-C (or `--duration=`), then write a video. Same `--cdp` gate and window
 * choice as a screenshot; the recorder and encoder are `media/`'s, shared with
 * `testUI --video=`.
 */

import { dirname } from "@std/path";
import type { OutputMode } from "./am-types.ts";
import { out, outError, sayErr } from "./am-output.ts";
import { parseNumArg } from "./am-utils.ts";
import type { CdpSession } from "../media/cdp.ts";
import type { VideoFormat } from "../media/chunks.ts";
import { videoFormatOf } from "../media/encoder.ts";
import {
  encodeRecording,
  type RecordedFrame,
  recordScreencast,
} from "../media/screencast.ts";

/** What `--video` asked for. */
export type ShotVideo = {
  path: string;
  format: VideoFormat;
  /** Stop after this long; null = until Ctrl-C. */
  durationMs: number | null;
};

/** Flags that shape ONE picture. A video is not one picture, so each is
 *  refused by name rather than ignored. */
const STILL_ONLY = [
  "--full",
  "--selector",
  "--check",
  "--update",
  "--threshold",
  "--max-diff",
  "--out",
];

const nameOf = (a: string) => a.split("=", 1)[0]!;

/** Pure: the video `args` ask for — null when there is no `--video` — or the
 *  refusal. `stamp` names the default file (`<appId>-<stamp>.mp4`). */
export function shotVideoOptions(
  args: readonly string[],
  appId: string,
  stamp: string,
): { ok: true; value: ShotVideo | null } | { ok: false; error: string } {
  const video = args.find((a) => a === "--video" || a.startsWith("--video="));
  const duration = args.find((a) =>
    a === "--duration" || a.startsWith("--duration=")
  );
  if (!video) {
    return duration
      ? {
        ok: false,
        error: "--duration is how long a VIDEO records — add --video " +
          "(am shot --video --duration=10)",
      }
      : { ok: true, value: null };
  }
  const still = args.filter((a) => STILL_ONLY.includes(nameOf(a)));
  if (still.length > 0) {
    return {
      ok: false,
      error:
        `${[...new Set(still.map(nameOf))].join(", ")} shape${
          still.length === 1 ? "s" : ""
        } a screenshot, not a video — ` +
        (still.some((a) => nameOf(a) === "--out")
          ? "a video's file goes in --video=<file.mp4>"
          : "drop them, or take a screenshot without --video"),
    };
  }
  const path = video === "--video" ? `${appId}-${stamp}.mp4` : video.slice(8);
  if (!path) {
    return {
      ok: false,
      error: "--video= needs a file (demo.mp4 or demo.webm)",
    };
  }
  let format: VideoFormat;
  try {
    format = videoFormatOf(path);
  } catch (e) {
    return {
      ok: false,
      error: (e as Error).message.replace(/^\[aio:video\] /, ""),
    };
  }
  let durationMs: number | null = null;
  if (duration === "--duration") {
    // The space form would hand the number to the WINDOW INDEX positional.
    return { ok: false, error: "--duration needs =seconds (--duration=10)" };
  }
  if (duration) {
    const n = parseNumArg(
      duration.slice(11),
      "--duration (seconds)",
      { min: 0.1, max: 24 * 3600 },
    );
    if (!n.ok) return { ok: false, error: n.error };
    durationMs = Math.round(n.value * 1000);
  }
  return { ok: true, value: { path, format, durationMs } };
}

/** `Page.startScreencast` sends one frame as it starts (measured ~33 ms in),
 *  whether or not anything painted: the picture the start screenshot already
 *  shows. A frame this early is that one, not a paint. */
const INITIAL_FRAME_US = 200_000;

/** Pure: did the window send no picture after the first — one still for the
 *  whole recording? `frames[0]` is the start screenshot; the screencast's own
 *  initial frame is not counted. Counting it made the documented warning
 *  impossible: a never-changing window always had two frames. */
export function isStillRecording(
  frames: readonly RecordedFrame[],
  endUs: number,
): boolean {
  if (endUs < 1_500_000) return false;
  const paints = frames.slice(1);
  if (paints[0] && paints[0].us < INITIAL_FRAME_US) paints.shift();
  return paints.length === 0;
}

/** Resolves on Ctrl-C / SIGTERM / the duration; `dispose` removes the
 *  listeners and the timer so the CLI can exit. */
function stopSignal(durationMs: number | null) {
  let resolve!: () => void;
  const stop = new Promise<void>((r) => (resolve = r));
  const signals: Deno.Signal[] = Deno.build.os === "windows"
    ? ["SIGINT"]
    : ["SIGINT", "SIGTERM"];
  for (const s of signals) Deno.addSignalListener(s, resolve);
  const timer = durationMs === null
    ? undefined
    : setTimeout(resolve, durationMs);
  let disposed = false;
  return {
    stop,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const s of signals) Deno.removeSignalListener(s, resolve);
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** Progress for `am shot --video` — said BEFORE the recording ends.
 *
 *  Pretty and `--json` both print on stderr: stdout must stay the ONE final
 *  document (`{file, bytes, …}`), the contract every other verb keeps. `--json`
 *  used to stay silent until that document, so a script driving a scene into
 *  the recorder could not tell whether recording had started — and drove a
 *  whole demo into a dead one (field report §15). Quiet stays quiet.
 *
 *  Same channel rule as `restartNote` in am-cmd-process.ts. */
export function shotVideoProgress(mode: OutputMode, line: string): void {
  if (mode === "quiet") return;
  sayErr(line);
}

/** The line that means "recording has started". Greppable; `--json` scripts
 *  watch stderr for it while awaiting the final stdout document. */
export function shotVideoRecordingLine(
  url: string,
  opts: Pick<ShotVideo, "path" | "durationMs">,
): string {
  return `recording ${url} → ${opts.path} — ${
    opts.durationMs === null
      ? "Ctrl-C to stop"
      : `for ${opts.durationMs / 1000}s (Ctrl-C stops early)`
  }`;
}

/** Record the window behind `cdp` and write the video. Exits 1 on failure. */
export async function recordShotVideo(
  cdp: CdpSession,
  url: string,
  opts: ShotVideo,
  mode: OutputMode,
): Promise<void> {
  // Before recording, not after: a path that cannot be written must fail
  // before someone performs a two-minute demo into it.
  await Deno.mkdir(dirname(opts.path) || ".", { recursive: true });
  const frameDir = await Deno.makeTempDir({ prefix: "aio-video-" });
  let keepFrames = false;
  const signal = stopSignal(opts.durationMs);
  try {
    // Said NOW, on stderr in every non-quiet mode — including `--json` — so a
    // script knows the recorder is alive before it drives a scene into it.
    shotVideoProgress(mode, shotVideoRecordingLine(url, opts));
    const rec = await recordScreencast(cdp, frameDir, signal.stop);
    signal.dispose();
    if (rec.lost) {
      keepFrames = true;
      outError(
        `the window went away while recording, taking the encoder with it — ` +
          `nothing was written to ${opts.path}. The ${rec.frames.length} ` +
          `frame(s) recorded so far are JPEGs in ${frameDir}`,
        mode,
      );
      Deno.exit(1);
    }
    const seconds = rec.endUs / 1e6;
    const still = isStillRecording(rec.frames, rec.endUs);
    // Encoding chatter: pretty-only. `--json` already knows recording started
    // and only wants the final document; progress mid-encode is noise there.
    if (mode === "pretty") {
      shotVideoProgress(
        mode,
        `encoding ${rec.frames.length} frame(s), ${seconds.toFixed(1)}s…`,
      );
    }
    const started = Date.now();
    const done = await encodeRecording(cdp, rec, opts.format);
    await Deno.writeFile(opts.path, done.bytes);
    const warning = still
      ? `the window painted nothing after the first frame — nothing changed on ` +
        `screen, or it is hidden, minimised or occluded (a window that is not ` +
        `composited paints nothing). The video is one still picture.`
      : undefined;
    out(
      mode === "pretty"
        ? `wrote ${opts.path} (${mb(done.bytes.length)}, ${
          seconds.toFixed(1)
        }s, ${rec.frames.length} frames, ${done.width}×${done.height} ${done.codec}, encoded in ${
          ((Date.now() - started) / 1000).toFixed(1)
        }s) — ${url}` + (warning ? `\n  ! ${warning}` : "")
        : {
          file: opts.path,
          bytes: done.bytes.length,
          seconds,
          frames: rec.frames.length,
          width: done.width,
          height: done.height,
          codec: done.codec,
          url,
          ...(warning ? { warning } : {}),
        },
      mode,
    );
  } finally {
    signal.dispose();
    if (!keepFrames) await Deno.remove(frameDir, { recursive: true });
  }
}
