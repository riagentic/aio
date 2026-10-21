/**
 * @module
 * `am shot --video[=file.mp4|.webm]` — record the live Electron window until
 * Ctrl-C (or `--duration=`), then write a video. Same `--cdp` gate and window
 * choice as a screenshot; the recorder and encoder are `media/`'s, shared with
 * `testUI --video=`.
 */

import { dirname, join } from "@std/path";
import type { OutputMode } from "./am-types.ts";
import { out, outError, sayErr } from "./am-output.ts";
import { parseNumArg } from "./am-utils.ts";
import type { CdpSession } from "../media/cdp.ts";
import type { VideoFormat } from "../media/chunks.ts";
import { videoFormatOf } from "../media/encoder.ts";
import {
  encodeRecording,
  jpegSize,
  type RecordedFrame,
  recordScreencast,
} from "../media/screencast.ts";
import {
  announceRecording,
  markersFromJournal,
  markersPathFor,
} from "./am-markers.ts";

/** What `--video` asked for. */
export type ShotVideo = {
  path: string;
  format: VideoFormat;
  /** Stop after this long; null = until Ctrl-C. */
  durationMs: number | null;
  /** `--markers`: write `<video>.markers.json` with every `am trigger` that
   *  lands while recording (see am-markers.ts). */
  markers?: true;
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
  const mk = args.find((a) => nameOf(a) === "--markers");
  if (mk !== undefined && mk !== "--markers") {
    return {
      ok: false,
      error: "--markers takes no value (am shot --video --markers)",
    };
  }
  const markers = mk !== undefined;
  if (!video && markers) {
    return {
      ok: false,
      error: "--markers notes `am trigger` steps in a VIDEO — add --video " +
        "(am shot --video --markers)",
    };
  }
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
  return {
    ok: true,
    value: { path, format, durationMs, ...(markers ? { markers: true } : {}) },
  };
}

/** `Page.startScreencast` sends one frame as it starts (measured 12–40 ms
 *  after the call), whether or not anything painted: the picture the start
 *  screenshot already shows. A frame this early is that one, not a paint.
 *  Counted from the CALL (`Recording.startedUs`), not from the recording's
 *  zero: the start screenshot comes first and takes as long as the machine
 *  lets it — on a loaded one the initial frame was stamped 416 ms in, read as
 *  a paint, and a window that never changed got no "still" warning. */
const INITIAL_FRAME_US = 200_000;

/** Pure: did the window send no picture after the first — one still for the
 *  whole recording? `frames[0]` is the start screenshot; the screencast's own
 *  initial frame is not counted. Counting it made the documented warning
 *  impossible: a never-changing window always had two frames. */
export function isStillRecording(
  frames: readonly RecordedFrame[],
  endUs: number,
  startedUs = 0,
): boolean {
  if (endUs < 1_500_000) return false;
  const paints = frames.slice(1);
  if (paints[0] && paints[0].us < startedUs + INITIAL_FRAME_US) paints.shift();
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

/** The `--json` start event (one stderr line): `t0` is the epoch ms of the
 *  video's time zero, so a moment `t` ms into the video happened at `t0 + t`
 *  on the caller's clock. Printed once frame 0 is taken — `performance.now()`
 *  at the "recording …" line was off by the screencast's startup. */
export function shotVideoStartEvent(file: string, t0: number): string {
  return JSON.stringify({ event: "recording", file, t0 });
}

/** The page's viewport width in CSS px — what a trigger's rect is measured
 *  in; the first frame's width over it is video px per CSS px. */
async function cssViewportWidth(cdp: CdpSession): Promise<number | null> {
  const m = await cdp.call("Page.getLayoutMetrics") as {
    cssVisualViewport?: { clientWidth?: number };
    cssLayoutViewport?: { clientWidth?: number };
  } | null;
  const w = m?.cssVisualViewport?.clientWidth ??
    m?.cssLayoutViewport?.clientWidth;
  return typeof w === "number" && w > 0 ? w : null;
}

/** Record the window behind `cdp` and write the video. Exits 1 on failure.
 *  `app` names the app the window belongs to — `--markers` needs it: it is
 *  where `am trigger` finds this recording. */
export async function recordShotVideo(
  cdp: CdpSession,
  url: string,
  opts: ShotVideo,
  mode: OutputMode,
  app?: { appId: string; pid: number },
): Promise<void> {
  // Before recording, not after: a path that cannot be written must fail
  // before someone performs a two-minute demo into it.
  await Deno.mkdir(dirname(opts.path) || ".", { recursive: true });
  const frameDir = await Deno.makeTempDir({ prefix: "aio-video-" });
  let keepFrames = false;
  const signal = stopSignal(opts.durationMs);
  let unannounce: (() => Promise<void>) | undefined;
  try {
    let markers: { journal: string; cssWidth: number } | undefined;
    if (opts.markers) {
      const cssWidth = await cssViewportWidth(cdp);
      if (!app || cssWidth === null) {
        outError(
          `--markers: ${
            app
              ? "the window did not say its viewport width, so a trigger's " +
                "rect cannot be put in video pixels"
              : "no app to take triggers from"
          } — nothing was recorded`,
          mode,
        );
        Deno.exit(1);
      }
      const journal = join(frameDir, "markers.jsonl");
      await Deno.writeTextFile(journal, "");
      unannounce = await announceRecording(app.appId, app.pid, journal);
      markers = { journal, cssWidth };
    }
    // Said NOW, on stderr in every non-quiet mode — including `--json` — so a
    // script knows the recorder is alive before it drives a scene into it.
    shotVideoProgress(mode, shotVideoRecordingLine(url, opts));
    const rec = await recordScreencast(
      cdp,
      frameDir,
      signal.stop,
      mode === "json"
        ? (t0) => sayErr(shotVideoStartEvent(opts.path, t0))
        : undefined,
    );
    signal.dispose();
    // A trigger after the stop is not in this video.
    await unannounce?.();
    unannounce = undefined;
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
    const still = isStillRecording(rec.frames, rec.endUs, rec.startedUs);
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
    let marked: { file: string; count: number } | undefined;
    if (markers) {
      const frameW = jpegSize(await Deno.readFile(rec.frames[0]!.path))
        ?.width ?? done.width;
      const list = markersFromJournal(
        await Deno.readTextFile(markers.journal),
        rec.t0!,
        rec.endUs / 1000,
        frameW / markers.cssWidth,
      );
      marked = { file: markersPathFor(opts.path), count: list.length };
      await Deno.writeTextFile(
        marked.file,
        JSON.stringify(list, null, 2) + "\n",
      );
    }
    const warning = still
      ? `the window painted nothing after the first frame — nothing changed on ` +
        `screen, or it is hidden, minimised or occluded (a window that is not ` +
        `composited paints nothing). The video is one still picture.`
      : undefined;
    // The encode's own speed, said: the in-page encoder can run far slower
    // than real time, and "encoded in 780s" alone does not say which one ran.
    const encodeSeconds = (Date.now() - started) / 1000;
    const speed = `${(seconds / Math.max(encodeSeconds, 0.001)).toFixed(1)}×`;
    out(
      mode === "pretty"
        ? `wrote ${opts.path} (${mb(done.bytes.length)}, ${
          seconds.toFixed(1)
        }s, ${rec.frames.length} frames, ${done.width}×${done.height} ${done.codec}, encoded in ${
          encodeSeconds.toFixed(1)
        }s by ${done.encoder} — ${speed} real time) — ${url}` +
          (marked ? `\n  markers: ${marked.count} → ${marked.file}` : "") +
          (warning ? `\n  ! ${warning}` : "") +
          (done.fallback ? `\n  ! ${done.fallback}` : "")
        : {
          file: opts.path,
          bytes: done.bytes.length,
          seconds,
          frames: rec.frames.length,
          width: done.width,
          height: done.height,
          codec: done.codec,
          encoder: done.encoder,
          encodeSeconds,
          ...(done.fallback ? { encoderFallback: done.fallback } : {}),
          url,
          t0: rec.t0,
          ...(marked ? { markers: marked } : {}),
          ...(warning ? { warning } : {}),
        },
      mode,
    );
  } finally {
    signal.dispose();
    await unannounce?.();
    if (!keepFrames) await Deno.remove(frameDir, { recursive: true });
  }
}
