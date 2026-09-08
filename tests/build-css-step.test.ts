// `build.css` — the door for a CSS toolchain.
//
// Two field reports said the same thing about Tailwind: for a large share of
// new projects it is not a preference, it is the assumed default, and aio's
// total silence about it ("`grep -ril tailwind docs/ src/` → zero hits") reads
// as "unsupported" even though nothing was blocked. The honest answer was "yes,
// if you run the CLI yourself, and nothing in the framework knows".
//
// The half that matters most here is FAIL LOUD. A CSS step that quietly did not
// run is the "pretends to work" class this project exists to refuse: the build
// succeeds, `dist/style.css` is yesterday's, and the app ships unstyled with
// every gate green. So a non-zero exit is an error and a command that cannot be
// spawned names itself — never a skip.
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { cssBuildStep, runCssBuild } from "../src/build/build-css.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("build.css: absent means absent — nothing runs, nothing changes", () => {
  assertEquals(cssBuildStep(undefined), null);
  assertEquals(cssBuildStep({}), null);
  assertEquals(cssBuildStep({ build: {} }), null);
  assertEquals(cssBuildStep({ build: { targets: ["cli"] } }), null);
});

Deno.test("build.css: a command string becomes argv, with no shell", () => {
  assertEquals(
    cssBuildStep({ build: { css: "deno run -A npm:x -i a.css -o b.css" } }),
    { argv: ["deno", "run", "-A", "npm:x", "-i", "a.css", "-o", "b.css"] },
  );
  // The array form is how an argument with spaces is expressed. There is no
  // shell here on purpose: `deno task` already exists for pipes and `&&`, and
  // a config value that reaches a shell can do anything a shell can.
  assertEquals(
    cssBuildStep({ build: { css: ["sh", "-c", "echo hi > out.css"] } }),
    { argv: ["sh", "-c", "echo hi > out.css"] },
  );
});

Deno.test("build.css: a malformed value is refused, not ignored", () => {
  for (
    const bad of [
      { build: { css: "" } },
      { build: { css: "   " } },
      { build: { css: 7 } },
      { build: { css: [] } },
      { build: { css: ["ok", 2] } },
      { build: { css: {} } },
    ]
  ) {
    assertThrows(
      () => cssBuildStep(bad),
      Error,
      undefined,
      `silently ignoring ${JSON.stringify(bad)} ships an unstyled build`,
    );
  }
});

async function appWith(css: unknown): Promise<string> {
  const dir = await tempDir("aio-cssstep-");
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ appId: "cssapp", build: { css } }, null, 2),
  );
  return dir;
}

Deno.test("build.css: a successful step runs and reports what it did", async () => {
  const dir = await appWith([
    "sh",
    "-c",
    "printf 'body{color:red}' > style.css",
  ]);
  try {
    const res = await runCssBuild(dir, { throwOnFail: true });
    assert(res.ran && res.ok, JSON.stringify(res));
    assertEquals(
      await Deno.readTextFile(join(dir, "style.css")),
      "body{color:red}",
      "the step's output is what the stylesheet copy will pick up",
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("build.css: a FAILING step fails the build", async () => {
  const dir = await appWith(["sh", "-c", "echo 'unknown class' >&2; exit 3"]);
  try {
    const e = await assertRejects(
      () => runCssBuild(dir, { throwOnFail: true }),
      Error,
    );
    assert(e.message.includes("exit 3"), e.message);
    assert(
      e.message.includes("unknown class"),
      `the tool's own output is the diagnosis — it must survive: ${e.message}`,
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("build.css: a MISSING command names the command and the reason", async () => {
  const dir = await appWith("definitely-not-a-real-binary-9f3 --build");
  try {
    const e = await assertRejects(
      () => runCssBuild(dir, { throwOnFail: true }),
      Error,
    );
    assert(
      e.message.includes("definitely-not-a-real-binary-9f3"),
      `"the tool is not installed" is the most common failure here and the ` +
        `least self-explanatory: ${e.message}`,
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("build.css: dev REPORTS a failure and keeps serving", async () => {
  // The dev/prod split, in the one allowed direction. A typo in a Tailwind
  // class must not kill the dev server you are using to fix it — but the same
  // failure still refuses a BUILD, so dev is not more permissive about what
  // ships.
  const dir = await appWith(["sh", "-c", "exit 1"]);
  try {
    const said: string[] = [];
    const res = await runCssBuild(dir, {
      throwOnFail: false,
      log: (m) => said.push(m),
    });
    assertEquals(res.ok, false);
    assertEquals(said.length, 1, "it reports rather than throwing");
  } finally {
    await dropTempDir(dir);
  }
});
