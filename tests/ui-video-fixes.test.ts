// `testUI --video=` — what a hunt found, each run as a real `deno test` of an
// unchanged UI test:
//   · a video that cannot be made behind a FAILING test was swallowed
//   · the wrapper form took its look from the cwd, not the test's project
//   · same-named tests in two FILES overwrote one video
//   · a wrong $CHROMIUM_BIN / an unwritable dir failed after the whole render
//   · a handle-form mount could not be named, and `unmount()` kept its claim
//   · the light/dark scheme was the recording machine's desktop
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { findChromium } from "../src/testing/chromium.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const CHROME = findChromium();
const REPO = new URL("../", import.meta.url).pathname;
const TODO = `${REPO}examples/todo/`;

async function hasTool(name: string): Promise<boolean> {
  try {
    return (await new Deno.Command(name, {
      args: ["-version"],
      stdout: "null",
      stderr: "null",
    }).output()).success;
  } catch {
    return false; // not installed — the checks that need it are skipped
  }
}
const FFMPEG = await hasTool("ffmpeg");

const HEAD = `import { testUI } from "aio/testing";
import { assertEquals } from "@std/assert";
import App from ${JSON.stringify(TODO + "src/App.tsx")};
`;

/** `deno test` over `files` (name → body), with `cwd` and `config`. */
async function runTests(o: {
  dir: string;
  files: Record<string, string>;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  config?: string;
}) {
  const paths: string[] = [];
  for (const [name, body] of Object.entries(o.files)) {
    const p = `${o.dir}/${name}`;
    await Deno.mkdir(p.slice(0, p.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(p, HEAD + body);
    paths.push(p);
  }
  const out = await new Deno.Command(Deno.execPath(), {
    args: [
      "test",
      "-A",
      "--config",
      o.config ?? `${TODO}deno.json`,
      ...paths,
      ...(o.args ?? []),
    ],
    cwd: o.cwd ?? TODO,
    env: {
      ...Deno.env.toObject(),
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      ...(o.env ?? {}),
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = (new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr)).replace(/\x1b\[[0-9;]*m/g, "");
  return { code: out.code, text };
}

async function exists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false; // the answer, not an error
  }
}

/** Mean luma (0–255) of a video's last frame, via ffmpeg: every frame
 *  scaled to one grey pixel, the last byte kept. */
async function lastLuma(file: string): Promise<number> {
  const o = await new Deno.Command("ffmpeg", {
    args: [
      "-v",
      "error",
      "-i",
      file,
      "-vf",
      "scale=1:1,format=gray",
      "-f",
      "rawvideo",
      "-",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(o.success && o.stdout.length > 0, new TextDecoder().decode(o.stderr));
  return o.stdout[o.stdout.length - 1]!;
}

const gated = { ignore: !CHROME, sanitizeResources: false }; // aio-ok: each child process is awaited through .output(); its pipes are ours

Deno.test({
  ...gated,
  name:
    "a video that cannot be made behind a FAILING test is said, next to the test's own error",
  async fn() {
    const dir = await tempDir("ui-video-fix-");
    try {
      // The file path is made a DIRECTORY by the body — after the mount's
      // write probe — so the video fails only when it is written.
      const r = await runTests({
        dir,
        files: {
          "fail.test.tsx": `testUI(App, "fails", async (ui) => {
  await Deno.mkdir(${
            JSON.stringify(`${dir}/v/fails.mp4`)
          }, { recursive: true });
  ui.WhatNeedsToBeDoneInput.type("x");
  await ui.settle();
  assertEquals(1, 2);
});`,
        },
        args: ["--", `--video=${dir}/v/`, "--video-pace=100"],
      });
      assert(r.code !== 0, r.text);
      assertStringIncludes(r.text, "fails ... FAILED");
      assertStringIncludes(r.text, "Values are not equal");
      assertStringIncludes(r.text, "[aio:video] no video for this failed test");
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  ...gated,
  name:
    "the wrapper form takes its look from the TEST's project, whatever the cwd",
  async fn() {
    const dir = await tempDir("ui-video-fix-");
    try {
      const project = `${dir}/proj`;
      await Deno.mkdir(`${project}/src`, { recursive: true });
      await Deno.writeTextFile(
        `${project}/deno.json`,
        JSON.stringify({
          compilerOptions: {
            lib: ["deno.ns", "deno.unstable", "dom", "dom.iterable"],
            jsx: "react-jsx",
            jsxImportSource: "aio",
          },
          imports: {
            aio: `${REPO}mod.ts`,
            "aio/air": `${REPO}src/air.ts`,
            "aio/ui": `${REPO}src/ui/mod.ts`,
            "aio/jsx-runtime": `${REPO}src/jsx-runtime.ts`,
            "aio/testing": `${REPO}src/cell-test.ts`,
            "happy-dom": "npm:happy-dom@17.6.3",
            "immer": "npm:immer@10.2.0",
            "@std/path": "jsr:@std/path@1.1.3",
            "@std/assert": "jsr:@std/assert@1.0.19",
          },
        }),
      );
      await Deno.writeTextFile(
        `${project}/src/app.ts`,
        `import { aio } from "aio";\nawait aio.run({ appId: "look-probe", ui: { theme: "auto" } });\n`,
      );
      const elsewhere = `${dir}/elsewhere`;
      await Deno.mkdir(elsewhere);
      const r = await runTests({
        dir: project,
        files: {
          "tests/look.test.tsx":
            `testUI(App, "look", async (ui) => { await ui.settle(); });`,
        },
        args: ["--", `--video=${dir}/v/`, "--video-pace=100"],
        cwd: elsewhere,
        config: `${project}/deno.json`,
      });
      assertEquals(r.code, 0, r.text);
      assertStringIncludes(r.text, `look from ${project}/src/app.ts`);
      assertStringIncludes(r.text, 'appId "look-probe"');
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  ...gated,
  name:
    "same-named tests in two FILES get two videos, in one run and in --parallel",
  async fn() {
    const dir = await tempDir("ui-video-fix-");
    try {
      for (const parallel of [false, true]) {
        const out = `${dir}/v${parallel ? "p" : "s"}`;
        const r = await runTests({
          dir,
          files: {
            "one.test.tsx":
              `testUI(App, "same name", async (ui) => { await ui.settle(); });`,
            "two.test.tsx":
              `testUI(App, "same name", async (ui) => { await ui.settle(); });`,
          },
          args: [
            ...(parallel ? ["--parallel"] : []),
            "--",
            `--video=${out}/`,
            "--video-pace=100",
          ],
        });
        assertEquals(r.code, 0, r.text);
        assert(await exists(`${out}/same-name.mp4`), r.text);
        assert(await exists(`${out}/same-name-2.mp4`), r.text);
      }
      // A RE-RUN is not a second claimant: it overwrites, and names nothing -3.
      const again = await runTests({
        dir,
        files: {
          "one.test.tsx":
            `testUI(App, "same name", async (ui) => { await ui.settle(); });`,
        },
        args: ["--", `--video=${dir}/vs/`, "--video-pace=100"],
      });
      assertEquals(again.code, 0, again.text);
      assertStringIncludes(again.text, `${dir}/vs/same-name.mp4`);
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  ...gated,
  name:
    "a wrong $CHROMIUM_BIN and an unwritable directory fail at mount, before the body runs",
  async fn() {
    const dir = await tempDir("ui-video-fix-");
    try {
      const body = `testUI(App, "never", async (ui) => {
  console.log("BODY" + "RAN");
  await ui.settle();
});`;
      const bin = await runTests({
        dir,
        files: { "bin.test.tsx": body },
        args: ["--", `--video=${dir}/v/`],
        env: { CHROMIUM_BIN: "/nonexistent/chromium" },
      });
      assert(bin.code !== 0, bin.text);
      assertStringIncludes(bin.text, "$CHROMIUM_BIN=/nonexistent/chromium");
      assert(!bin.text.includes("BODYRAN"), bin.text);

      await Deno.writeTextFile(`${dir}/file`, "");
      const unwritable = await runTests({
        dir,
        files: { "dir.test.tsx": body },
        args: ["--", `--video=${dir}/file/sub/`],
      });
      assert(unwritable.code !== 0, unwritable.text);
      assertStringIncludes(unwritable.text, "[aio:video] cannot write");
      assert(!unwritable.text.includes("BODYRAN"), unwritable.text);
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  ...gated,
  name:
    "handle form: { name } names the video, and unmount() gives its name back",
  async fn() {
    const dir = await tempDir("ui-video-fix-");
    try {
      const r = await runTests({
        dir,
        files: {
          "handle.test.tsx": `Deno.test("dropped", async () => {
  const ui = await testUI(App, { name: "my flow" });
  await ui.settle();
  ui.unmount();
});
Deno.test("kept", async () => {
  await using ui = await testUI(App, { name: "my flow" });
  await ui.settle();
});`,
        },
        args: ["--", `--video=${dir}/v/`, "--video-pace=100"],
      });
      assertEquals(r.code, 0, r.text);
      assert(await exists(`${dir}/v/my-flow.mp4`), r.text);
      assert(!(await exists(`${dir}/v/my-flow-2.mp4`)), r.text);
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  ...gated,
  name:
    "the scheme is pinned (light by default), chosen by --video-scheme, and printed",
  async fn() {
    const dir = await tempDir("ui-video-fix-");
    try {
      const files = {
        "scheme.test.tsx":
          `testUI(App, "scheme", async (ui) => { await ui.settle(); });`,
      };
      const light = await runTests({
        dir,
        files,
        args: ["--", `--video=${dir}/light/`, "--video-pace=100"],
      });
      assertEquals(light.code, 0, light.text);
      assertStringIncludes(light.text, "scheme light");
      const dark = await runTests({
        dir,
        files,
        args: [
          "--",
          `--video=${dir}/dark/`,
          "--video-pace=100",
          "--video-scheme=dark",
        ],
      });
      assertEquals(dark.code, 0, dark.text);
      assertStringIncludes(dark.text, "scheme dark");
      if (FFMPEG) {
        const l = await lastLuma(`${dir}/light/scheme.mp4`);
        const d = await lastLuma(`${dir}/dark/scheme.mp4`);
        assert(l > 150, `light video is dark: luma ${l}`);
        assert(d < 100, `dark video is light: luma ${d}`);
      }
    } finally {
      await dropTempDir(dir);
    }
  },
});
