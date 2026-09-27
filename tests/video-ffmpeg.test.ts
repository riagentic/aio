// `encodeRecording` with host ffmpeg: the fast path must write the SAME video
// the in-page WebCodecs encoder writes — container, frame times, keyframes,
// duration — and an ffmpeg that is present but broken must never produce a
// silent bad file (field report: the in-page encoder ran 15–30× slower than
// real time at 1600×900, so a demo's app autolocked mid-encode).
//
// The frames are JPEGs ffmpeg itself draws; the differential needs Chromium
// (the page encoder) and ffprobe (the independent reader) and skips without.
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  annexBUnits,
  ffmpegArgs,
  h264Samples,
  ivfFrames,
} from "../src/media/ffmpeg.ts";
import { encodeRecording, type Recording } from "../src/media/screencast.ts";
import type { CdpSession } from "../src/media/cdp.ts";
import {
  chromiumPage,
  findChromium,
  launchChromium,
} from "../src/testing/chromium.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

async function has(tool: string): Promise<boolean> {
  try {
    return (await new Deno.Command(tool, {
      args: ["-version"],
      stdout: "null",
      stderr: "null",
    }).output()).success;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
}
const FFMPEG = await has("ffmpeg");
const FFPROBE = await has("ffprobe");
const CHROME = findChromium();

/** A page encoder that must never be reached. */
const NO_PAGE = {
  call: () => Promise.reject(new Error("the page encoder was used")),
} as unknown as CdpSession;

/** `n` distinct 320×240 JPEG frames, 100 ms apart, recorded for 2.4 s. */
async function frames(dir: string, n = 12): Promise<Recording> {
  const o = await new Deno.Command("ffmpeg", {
    args: [
      ..."-v error -f lavfi -i testsrc=size=320x240:rate=10".split(" "),
      ...`-frames:v ${n} -q:v 3 ${dir}/%06d.jpg`.split(" "),
    ],
    stderr: "piped",
  }).output();
  assert(o.success, new TextDecoder().decode(o.stderr));
  return {
    frames: Array.from({ length: n }, (_, i) => ({
      us: i * 100_000,
      path: `${dir}/${String(i + 1).padStart(6, "0")}.jpg`,
    })),
    endUs: 2_400_000,
    lost: false,
  };
}

async function probe(path: string): Promise<string> {
  const o = await new Deno.Command("ffprobe", {
    args: [
      ..."-v error -count_frames -of compact -show_entries".split(" "),
      "stream=codec_name,width,height,r_frame_rate,nb_read_frames:format=format_name,duration:packet=pts_time,flags",
      path,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(new TextDecoder().decode(o.stderr), "", `ffprobe ${path}`);
  return new TextDecoder().decode(o.stdout);
}

Deno.test("annexBUnits + h264Samples: AUD-split frames, length-prefixed, SPS/PPS into avcC", () => {
  const sc = [0, 0, 0, 1];
  const aud = [9, 0xf0], sps = [0x67, 0x64, 0, 0x1f, 1], pps = [0x68, 2];
  const idr = [0x65, 7, 7], p = [0x41, 8];
  const stream = new Uint8Array(
    [sc, aud, sc, sps, [0, 0, 1], pps, sc, idr, sc, aud, sc, p].flat(),
  );
  assertEquals(annexBUnits(stream).length, 6);
  const { frames, avcC } = h264Samples(stream);
  assertEquals(frames.map((f) => f.key), [true, false]);
  assertEquals([...frames[0]!.data], [0, 0, 0, 3, ...idr]);
  assertEquals([...frames[1]!.data], [0, 0, 0, 2, ...p]);
  assertEquals([...avcC.subarray(0, 4)], [1, 0x64, 0, 0x1f]);
  assertEquals([...avcC.subarray(6, 8)], [0, sps.length]);
});

Deno.test("h264Samples / ivfFrames refuse what they cannot parse — no silent empty video", () => {
  assert(throwsWith(() => h264Samples(new Uint8Array([1, 2, 3])), "SPS/PPS"));
  assert(throwsWith(() => ivfFrames(new Uint8Array(40)), "IVF"));
});

Deno.test("ffmpegArgs: keyframes forced at the plan's indices, B-frames off, the crop at the origin", () => {
  const a = ffmpegArgs("mp4", 1600, 756, [0, 120, 240]).join(" ");
  assert(a.includes("-force_key_frames 0.000000,1.991667,3.991667"), a);
  assert(a.includes("-bf 0"), a);
  assert(a.includes("-level:v 4"), a); // what codecCandidates picks: avc1.640028
  assert(a.includes("crop=1600:756:0:0"), a);
  assert(a.includes("-fps_mode passthrough"), a);
  const w = ffmpegArgs("webm", 320, 240, [0]).join(" ");
  assert(w.includes("-auto-alt-ref 0") && w.includes("-f ivf"), w);
});

function throwsWith(f: () => unknown, msg: string): boolean {
  try {
    f();
  } catch (e) {
    return String(e).includes(msg);
  }
  return false;
}

Deno.test({
  name:
    "encodeRecording: host ffmpeg and the in-page encoder write the same video from the same frames",
  ignore: !FFMPEG || !FFPROBE || !CHROME,
  async fn() {
    const dir = await tempDir("video-ffmpeg-");
    const ac = new AbortController();
    const port = freePort();
    const server = Deno.serve(
      { port, hostname: "127.0.0.1", signal: ac.signal, onListen() {} },
      () =>
        new Response("<!doctype html><body>x", {
          headers: { "content-type": "text/html" },
        }),
    );
    let browser: Awaited<ReturnType<typeof launchChromium>> | null = null;
    let cdp: CdpSession | null = null;
    try {
      const rec = await frames(dir);
      browser = await launchChromium(CHROME!, [
        "--remote-debugging-port=0",
        `http://127.0.0.1:${port}/`,
      ]);
      cdp = await chromiumPage(browser);
      // WebCodecs needs the http://127.0.0.1 page (a secure context), not
      // the about:blank the tab starts on.
      for (let i = 0;; i++) {
        const r = await cdp.call("Runtime.evaluate", {
          expression: "isSecureContext && location.protocol === 'http:'",
          returnByValue: true,
        }).catch(() => null) as { result?: { value?: unknown } } | null;
        if (r?.result?.value === true) break;
        assert(i < 200, "the page never loaded");
        await new Promise((r) => setTimeout(r, 50));
      }
      for (const format of ["mp4", "webm"] as const) {
        const got: Record<string, string> = {};
        for (const encoder of ["page", "ffmpeg"] as const) {
          const done = await encodeRecording(cdp, rec, format, undefined, {
            encoder,
          });
          assertEquals(
            done.encoder.startsWith(encoder),
            true,
            `${encoder}: ${done.encoder}`,
          );
          assertEquals([done.width, done.height], [320, 240]);
          const file = `${dir}/${encoder}.${format}`;
          await Deno.writeFile(file, done.bytes);
          got[encoder] = await probe(file);
        }
        assert(got.page!.includes("nb_read_frames="), got.page);
        assertEquals(got.ffmpeg, got.page, format);
      }
    } finally {
      await cdp?.close();
      await browser?.close();
      ac.abort();
      await server.finished;
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "encodeRecording: an ffmpeg that is present but fails falls back to the page, loudly; forced, it throws",
  ignore: !FFMPEG,
  async fn() {
    const dir = await tempDir("video-ffmpeg-bad-");
    const bin = await tempDir("video-ffmpeg-bin-");
    const path = Deno.env.get("PATH") ?? "";
    const warn = console.warn;
    const warned: string[] = [];
    try {
      const rec = await frames(dir, 3);
      await Deno.writeTextFile(
        `${bin}/ffmpeg`,
        "#!/bin/sh\ncat >/dev/null\necho 'Unknown encoder libx264' >&2\nexit 1\n",
      );
      await Deno.chmod(`${bin}/ffmpeg`, 0o755);
      Deno.env.set("PATH", `${bin}:${path}`);
      console.warn = (...a: unknown[]) => warned.push(a.join(" "));
      // Forced: the failure is the answer.
      await assertRejects(
        () =>
          encodeRecording(NO_PAGE, rec, "mp4", undefined, {
            encoder: "ffmpeg",
          }),
        Error,
        "Unknown encoder libx264",
      );
      // Auto: the page encoder is asked instead (here, a page that refuses —
      // proving it was reached) and the reason was warned.
      await assertRejects(
        () => encodeRecording(NO_PAGE, rec, "mp4"),
        Error,
        "the page encoder was used",
      );
      assert(
        warned.some((w) => w.includes("Unknown encoder libx264")),
        warned.join("\n"),
      );
    } finally {
      console.warn = warn;
      Deno.env.set("PATH", path);
      await dropTempDir(dir);
      await dropTempDir(bin);
    }
  },
});

Deno.test({
  name:
    "encodeRecording: frames that change size (a resized window) are left to the page encoder, which fits them",
  ignore: !FFMPEG,
  async fn() {
    const dir = await tempDir("video-ffmpeg-size-");
    try {
      const rec = await frames(dir, 3);
      const o = await new Deno.Command("ffmpeg", {
        args: [
          ..."-v error -y -f lavfi -i testsrc=size=200x100 -frames:v 1".split(
            " ",
          ),
          rec.frames[2]!.path,
        ],
      }).output();
      assert(o.success);
      await assertRejects(
        () =>
          encodeRecording(NO_PAGE, rec, "mp4", undefined, {
            encoder: "ffmpeg",
          }),
        Error,
        "200×100",
      );
    } finally {
      await dropTempDir(dir);
    }
  },
});
