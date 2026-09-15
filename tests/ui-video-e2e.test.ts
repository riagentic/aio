// `testUI` + `--video=` end to end: a real `deno test` run of an unchanged UI
// test, a real headless Chromium drawing it, and the files checked by a
// decoder that is not ours.
//
// Skipped when the box has no Chromium — an environment that cannot draw must
// not report a pass. ffprobe is the independent check when present; without it
// the container magic is still asserted.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { findChromium } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

const CHROME = findChromium();
const TODO = new URL("../examples/todo/", import.meta.url).pathname;

async function hasFfprobe(): Promise<boolean> {
  try {
    return (await new Deno.Command("ffprobe", {
      args: ["-version"],
      stdout: "null",
      stderr: "null",
    }).output()).success;
  } catch {
    return false; // not installed — the magic-byte checks still run
  }
}
const FFPROBE = await hasFfprobe();

/** The fixture: a plain UI test, no video code in it. */
const fixture = (tests: string) =>
  `import { testUI } from "aio/testing";
import { assertEquals } from "@std/assert";
import App from ${JSON.stringify(TODO + "src/App.tsx")};
${tests}
`;

async function run(
  dir: string,
  tests: string,
  args: string[],
  env: Record<string, string> = {},
) {
  const file = `${dir}/todo.test.tsx`;
  await Deno.writeTextFile(file, fixture(tests));
  const o = await new Deno.Command(Deno.execPath(), {
    args: ["test", "-A", "--config", `${TODO}deno.json`, file, ...args],
    cwd: TODO,
    env: { ...Deno.env.toObject(), NO_COLOR: "1", FORCE_COLOR: "0", ...env },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = stripAnsi(
    new TextDecoder().decode(o.stdout) + new TextDecoder().decode(o.stderr),
  );
  return { code: o.code, text };
}

async function probe(path: string, codec: string) {
  const bytes = await Deno.readFile(path);
  if (codec === "h264") {
    assertEquals(new TextDecoder().decode(bytes.subarray(4, 8)), "ftyp", path);
  } else {
    assertEquals([...bytes.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3], path);
  }
  if (!FFPROBE) return;
  const o = await new Deno.Command("ffprobe", {
    args: [
      "-v",
      "error",
      "-count_frames",
      "-show_entries",
      "stream=codec_name,width,height,nb_read_frames:format=duration",
      "-of",
      "json",
      path,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const err = new TextDecoder().decode(o.stderr);
  assert(o.success && err.trim() === "", `ffprobe ${path}: ${err}`);
  const j = JSON.parse(new TextDecoder().decode(o.stdout));
  assertEquals(j.streams[0].codec_name, codec);
  assertEquals([j.streams[0].width, j.streams[0].height], [1024, 768]);
  assert(
    Number(j.streams[0].nb_read_frames) >= 3,
    `${path}: ${j.streams[0].nb_read_frames} frames`,
  );
  assert(Number(j.format.duration) >= 0.3, `${path}: ${j.format.duration}s`);
}

const ADD = `testUI(App, "adds an item", async (ui) => {
  ui.WhatNeedsToBeDoneInput.type("buy milk");
  ui.AddButton.click();
  await ui.settle();
});`;

Deno.test({
  name:
    "testUI --video=<dir>/: one MP4 per test, named after it, with no change to the test",
  ignore: !CHROME,
  sanitizeResources: false, // aio-ok: the child process is awaited; its pipes are ours
  async fn() {
    const dir = await tempDir("ui-video-e2e-");
    try {
      const r = await run(
        dir,
        `${ADD}
testUI(App, "checks an item", async (ui) => {
  ui.WhatNeedsToBeDoneInput.type("walk the dog");
  ui.AddButton.click();
  await ui.settle();
  ui.ToggleWalkTheDogCheckbox.check();
  await ui.settle();
});`,
        ["--", `--video=${dir}/videos/`, "--video-pace=150"],
      );
      assertEquals(r.code, 0, r.text);
      assertStringIncludes(r.text, 'appId "ex-todo"');
      assertEquals(
        r.text.split("[aio:video] look from").length,
        2,
        "the look is printed once per run",
      );
      for (const name of ["adds-an-item", "checks-an-item"]) {
        assertStringIncludes(r.text, `${dir}/videos/${name}.mp4`);
        await probe(`${dir}/videos/${name}.mp4`, "h264");
      }
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "AIO_VIDEO=<file>.webm: VP8 WebM; a second test claiming the same file is refused, not overwritten",
  ignore: !CHROME,
  sanitizeResources: false, // aio-ok: the child process is awaited; its pipes are ours
  async fn() {
    const dir = await tempDir("ui-video-e2e-");
    try {
      const r = await run(
        dir,
        `${ADD}
testUI(App, "second", async (ui) => { await ui.settle(); });`,
        [],
        { AIO_VIDEO: `${dir}/one.webm`, AIO_VIDEO_PACE: "100" },
      );
      assert(r.code !== 0, r.text);
      assertStringIncludes(r.text, "adds an item ... ok");
      assertStringIncludes(r.text, "names ONE file");
      await probe(`${dir}/one.webm`, "vp8");
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "a test that FAILS its assertion still gets its video — that is where it is most wanted",
  ignore: !CHROME,
  sanitizeResources: false, // aio-ok: the child process is awaited; its pipes are ours
  async fn() {
    const dir = await tempDir("ui-video-e2e-");
    try {
      const r = await run(
        dir,
        `testUI(App, "fails", async (ui) => {
  ui.WhatNeedsToBeDoneInput.type("x");
  ui.AddButton.click();
  await ui.settle();
  assertEquals(1, 2);
});`,
        ["--", `--video=${dir}/fail.mp4`, "--video-pace=100"],
      );
      assert(r.code !== 0, r.text);
      assertStringIncludes(r.text, "fails ... FAILED");
      await probe(`${dir}/fail.mp4`, "h264");
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test("without --video nothing launches a browser or writes a file", async () => {
  // Pure check of the default path: `openUiVideo` answers null before it
  // looks for Chromium, so a box without one runs UI tests as before.
  const { openUiVideo } = await import("../src/testing/ui-video.ts");
  assertEquals(
    openUiVideo({
      name: "x",
      doc: null,
      root: null,
      viewport: { width: 1, height: 1 },
      args: [],
      env: () => undefined,
    }),
    null,
  );
});
