// `am shot --video`: the flags a video refuses, and the recorder + encoder
// against a REAL Chromium page that keeps repainting — the same CDP calls an
// Electron window answers (measured on Electron 44: avc1 High, VP8 and VP9
// encode in the app page; one screencast frame per paint).
//
// Skipped when the box has no Chromium; ffprobe is the independent decoder
// when present.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { shotVideoOptions } from "../src/am/am-cmd-shot-video.ts";
import { unknownFlags } from "../src/am/am-flags.ts";
import {
  chromiumPage,
  findChromium,
  launchChromium,
} from "../src/testing/chromium.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { encodeRecording, recordScreencast } from "../src/media/screencast.ts";

const CHROME = findChromium();

Deno.test("shotVideoOptions: no --video is a screenshot; --video defaults to <appId>-<stamp>.mp4", () => {
  assertEquals(shotVideoOptions(["--out=a.png"], "app", "S"), {
    ok: true,
    value: null,
  });
  assertEquals(shotVideoOptions(["--video"], "app", "20260914-120000"), {
    ok: true,
    value: { path: "app-20260914-120000.mp4", format: "mp4", durationMs: null },
  });
  assertEquals(
    shotVideoOptions(["1", "--video=d/x.webm", "--duration=2.5"], "app", "S"),
    {
      ok: true,
      value: { path: "d/x.webm", format: "webm", durationMs: 2500 },
    },
  );
});

Deno.test("shotVideoOptions: what a video cannot honour is refused by name", () => {
  const refused: [string[], string][] = [
    [["--video", "--full"], "--full shapes a screenshot"],
    [
      ["--video", "--selector=#a", "--check=b.png"],
      "--selector, --check shape",
    ],
    [["--video", "--out=x.mp4"], "--video=<file.mp4>"],
    [["--duration=3"], "add --video"],
    [["--video", "--duration"], "--duration=10"],
    [["--video", "--duration=0"], "≥ 0.1"],
    [["--video", "--duration=5s"], "must be a number"],
    [["--video="], "needs a file"],
    [["--video=demo.gif"], ".mp4 or .webm"],
  ];
  for (const [args, msg] of refused) {
    const r = shotVideoOptions(args, "app", "S");
    assert(!r.ok, `${args.join(" ")} was accepted`);
    assertStringIncludes(r.error, msg, args.join(" "));
  }
});

Deno.test("am shot's flag gate lets --video and --duration through", () => {
  assertEquals(unknownFlags("shot", ["--video=a.mp4", "--duration=3"]), []);
  assertEquals(unknownFlags("shot", ["--videos"]), ["--videos"]);
});

/** A page that repaints every 40 ms, served over http://127.0.0.1 — a secure
 *  context, which WebCodecs requires (a data: URL is not one). */
function servePage() {
  const ac = new AbortController();
  const port = freePort();
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", signal: ac.signal, onListen() {} },
    () =>
      new Response(
        `<!doctype html><body style="margin:0;font:48px sans-serif">
<div id=n>0</div><script>let i=0;setInterval(()=>{n.textContent=++i;document.body.style.background=i%2?"#fde":"#def"},40)</script>`,
        { headers: { "content-type": "text/html" } },
      ),
  );
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => (ac.abort(), server.finished),
  };
}

async function ffprobe(path: string): Promise<Record<string, string> | null> {
  let o;
  try {
    o = await new Deno.Command("ffprobe", {
      args: [
        "-v",
        "error",
        "-count_frames",
        "-show_entries",
        "stream=codec_name,width,height,nb_read_frames",
        "-of",
        "default=nw=1",
        path,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch {
    return null; // not installed
  }
  assertEquals(
    new TextDecoder().decode(o.stderr).trim(),
    "",
    `ffprobe ${path}`,
  );
  return Object.fromEntries(
    new TextDecoder().decode(o.stdout).trim().split("\n").map((l) =>
      l.split("=") as [string, string]
    ),
  );
}

Deno.test({
  name:
    "recordScreencast + encodeRecording: a repainting page becomes a decodable MP4 and WebM",
  ignore: !CHROME,
  async fn() {
    const page = servePage();
    const browser = await launchChromium(CHROME!, [
      "--remote-debugging-port=0",
      "--window-size=640,480",
      page.url,
    ]);
    const dir = await tempDir("am-shot-video-");
    try {
      const cdp = await chromiumPage(browser);
      try {
        await cdp.call("Page.enable");
        const rec = await recordScreencast(
          cdp,
          dir,
          new Promise((r) => setTimeout(r, 1200)),
        );
        assertEquals(rec.lost, false);
        assert(
          rec.frames.length >= 5,
          `only ${rec.frames.length} frames from a page repainting every 40 ms`,
        );
        assertEquals(rec.frames[0]!.us, 0);
        assert(rec.endUs >= 1_150_000, `${rec.endUs}`);
        for (const format of ["mp4", "webm"] as const) {
          const done = await encodeRecording(cdp, rec, format);
          const file = `${dir}/out.${format}`;
          await Deno.writeFile(file, done.bytes);
          const p = await ffprobe(file);
          if (!p) continue;
          assertEquals(p.codec_name, format === "mp4" ? "h264" : "vp8");
          assertEquals([Number(p.width), Number(p.height)], [
            done.width,
            done.height,
          ]);
          assert(
            Number(p.nb_read_frames) >= 5,
            `${format}: ${p.nb_read_frames} frames`,
          );
        }
      } finally {
        await cdp.close();
      }
    } finally {
      await browser.close();
      await page.close();
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "recordScreencast: the window going away ends the recording as LOST, with the frames kept",
  ignore: !CHROME,
  async fn() {
    const page = servePage();
    const browser = await launchChromium(CHROME!, [
      "--remote-debugging-port=0",
      "--window-size=320,240",
      page.url,
    ]);
    const dir = await tempDir("am-shot-video-");
    try {
      const cdp = await chromiumPage(browser);
      try {
        await cdp.call("Page.enable");
        const never = new Promise<void>(() => {});
        const recording = recordScreencast(cdp, dir, never);
        await new Promise((r) => setTimeout(r, 400));
        await browser.close();
        const rec = await recording;
        assertEquals(rec.lost, true);
        assert(rec.frames.length >= 1);
        for (const f of rec.frames) {
          assert((await Deno.stat(f.path)).size > 0, f.path);
        }
      } finally {
        await cdp.close();
      }
    } finally {
      await browser.close();
      await page.close();
      await dropTempDir(dir);
    }
  },
});
