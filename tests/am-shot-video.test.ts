// `am shot --video`: the flags a video refuses, and the recorder + encoder
// against a REAL Chromium page that keeps repainting — the same CDP calls an
// Electron window answers (measured on Electron 44: avc1 High, VP8 and VP9
// encode in the app page; one screencast frame per paint).
//
// Skipped when the box has no Chromium; ffprobe is the independent decoder
// when present.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  isStillRecording,
  shotVideoOptions,
} from "../src/am/am-cmd-shot-video.ts";
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

Deno.test("isStillRecording: the screencast's own first frame is not a paint", () => {
  const f = (...us: number[]) => us.map((u) => ({ us: u, path: "" }));
  // What a never-changing window measured: the start screenshot, then the
  // frame Page.startScreencast always sends ~33 ms in. One picture.
  assertEquals(isStillRecording(f(0, 33_000), 2_500_000), true);
  assertEquals(isStillRecording(f(0), 2_000_000), true);
  // A later paint is a change.
  assertEquals(isStillRecording(f(0, 33_000, 600_000), 2_500_000), false);
  assertEquals(isStillRecording(f(0, 900_000), 2_500_000), false);
  // Too short to call it still.
  assertEquals(isStillRecording(f(0, 33_000), 1_000_000), false);
});

Deno.test("am shot's flag gate lets --video and --duration through", () => {
  assertEquals(unknownFlags("shot", ["--video=a.mp4", "--duration=3"]), []);
  assertEquals(unknownFlags("shot", ["--videos"]), ["--videos"]);
});

/** A page that repaints every 40 ms, served over http://127.0.0.1 — a secure
 *  context, which WebCodecs requires (a data: URL is not one). */
function servePage(html: string | null = null) {
  const ac = new AbortController();
  const port = freePort();
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", signal: ac.signal, onListen() {} },
    () =>
      new Response(
        html ??
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

/** A headless Chromium on `page`, with its CDP page — everything it made is
 *  closed in `finally`, in order, whatever threw and wherever: the browser is
 *  killed AND its exit awaited even when a wait inside timed out (the full
 *  suite's load reported a leaked child process here). */
async function withBrowser(
  size: string,
  html: string | null,
  fn: (
    cdp: Awaited<ReturnType<typeof chromiumPage>>,
    browser: Awaited<ReturnType<typeof launchChromium>>,
    dir: string,
  ) => Promise<void>,
): Promise<void> {
  const page = servePage(html);
  let browser: Awaited<ReturnType<typeof launchChromium>> | null = null;
  let cdp: Awaited<ReturnType<typeof chromiumPage>> | null = null;
  let dir: string | null = null;
  try {
    dir = await tempDir("am-shot-video-");
    browser = await launchChromium(CHROME!, [
      "--remote-debugging-port=0",
      `--window-size=${size}`,
      page.url,
    ]);
    cdp = await chromiumPage(browser);
    await cdp.call("Page.enable");
    await fn(cdp, browser, dir);
  } finally {
    await cdp?.close();
    await browser?.close();
    await page.close();
    if (dir) await dropTempDir(dir);
  }
}

/** Stop a recording when it has both LASTED long enough and CAPTURED enough,
 *  by watching the frames land on disk.
 *
 *  A fixed wall-clock window was a race against the machine rather than a
 *  measurement of the code: under `check:release`, where several suites and a
 *  real Chromium share the box, the page repainting every 40 ms delivered
 *  ONE frame in 1.2 s and the test failed for the machine being busy. The
 *  question it asks — does a repainting page produce a decodable video — is
 *  answered by the frames, so it waits for the frames. The deadline is a
 *  backstop: reaching it hands the original assertion a real count to
 *  complain about, rather than hanging. */
async function recordedEnough(
  dir: string,
  minFrames: number,
  minMs: number,
): Promise<void> {
  const until = Date.now() + minMs;
  const deadline = Date.now() + 30_000;
  for (;;) {
    let n = 0;
    try {
      for await (const e of Deno.readDir(dir)) {
        if (e.name.endsWith(".jpg")) n++;
      }
    } catch {
      // aio-ok: the recorder is writing into this directory as we count; a
      // half-written listing is answered by the next poll, 50 ms later.
    }
    if (Date.now() >= until && n >= minFrames) return;
    if (Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

Deno.test({
  name:
    "recordScreencast + encodeRecording: a repainting page becomes a decodable MP4 and WebM",
  ignore: !CHROME,
  async fn() {
    await withBrowser("640,480", null, async (cdp, _browser, dir) => {
      const rec = await recordScreencast(
        cdp,
        dir,
        recordedEnough(dir, 5, 1200),
      );
      assertEquals(rec.lost, false);
      assert(
        rec.frames.length >= 5,
        `only ${rec.frames.length} frames from a page repainting every 40 ms`,
      );
      assertEquals(rec.frames[0]!.us, 0);
      assert(rec.endUs >= 1_150_000, `${rec.endUs}`);
      assertEquals(isStillRecording(rec.frames, rec.endUs), false);
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
    });
  },
});

Deno.test({
  name:
    "recordScreencast: a window that never changes is a STILL recording (the documented warning fires)",
  ignore: !CHROME,
  async fn() {
    await withBrowser(
      "320,240",
      `<!doctype html><body style="margin:0">static</body>`,
      async (cdp, _browser, dir) => {
        // First paint DONE, asked of the page — not a 300 ms guess, which
        // the parallel suite's load outran (a late paint = a second frame).
        // Asked again while the tab is still navigating off about:blank (that
        // destroys the context mid-question).
        for (let tries = 0;; tries++) {
          const r = await cdp.call("Runtime.evaluate", {
            expression:
              `location.protocol === "about:" ? false : new Promise((r) => { const go = () => requestAnimationFrame(() => requestAnimationFrame(() => r(true))); document.readyState === "complete" ? go() : addEventListener("load", go); })`,
            awaitPromise: true,
            returnByValue: true,
          }).catch(() => null) as { result?: { value?: unknown } } | null;
          if (r?.result?.value === true) break;
          assert(tries < 100, "the page never painted");
          await new Promise((r) => setTimeout(r, 50));
        }
        const rec = await recordScreencast(
          cdp,
          dir,
          new Promise((r) => setTimeout(r, 1700)),
        );
        assert(
          isStillRecording(rec.frames, rec.endUs),
          `frames at ${rec.frames.map((f) => f.us).join(", ")} µs`,
        );
      },
    );
  },
});

Deno.test({
  name:
    "recordScreencast: the window going away ends the recording as LOST, with the frames kept",
  ignore: !CHROME,
  async fn() {
    await withBrowser("320,240", null, async (cdp, browser, dir) => {
      const never = new Promise<void>(() => {});
      const recording = recordScreencast(cdp, dir, never);
      // Recording STARTED (its first frame is on disk) — not a 400 ms guess,
      // which the parallel suite's load outran: the window closed before the
      // first picture and the recording rightly had nothing to keep.
      for (let i = 0;; i++) {
        const ok = await Deno.stat(join(dir, "000000.jpg")).then(
          (s) => s.size > 0,
          () => false,
        );
        if (ok) break;
        assert(i < 200, "the recording never took its first frame");
        await new Promise((r) => setTimeout(r, 50));
      }
      await browser.close();
      const rec = await recording;
      assertEquals(rec.lost, true);
      assert(rec.frames.length >= 1);
      for (const f of rec.frames) {
        assert((await Deno.stat(f.path)).size > 0, f.path);
      }
    });
  },
});
