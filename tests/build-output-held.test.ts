// Rebuilding an app that is still running. On Windows a running program
// cannot be replaced, and `deno compile` says only `error: Access is denied.
// (os error 5)` — no file, no cause. The build now names the file and says
// what to stop (`outputHeld`, asked by `runCompile` after a failed compile).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { outputHeld } from "../src/build/minify-server.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const argv = (out: string) => ["compile", "-A", "-o", out, "src/app.ts"];

Deno.test("build: an output that is absent, or free, is not called held", async () => {
  const dir = await tempDir("aio-output-held-");
  try {
    assertEquals(await outputHeld(dir, argv("app"), "windows"), null);
    await Deno.writeTextFile(join(dir, "app.exe"), "x");
    assertEquals(await outputHeld(dir, argv("app"), "windows"), null);
    assertEquals(await outputHeld(dir, argv("app.exe"), "windows"), null);
    assertEquals(await outputHeld(dir, ["info", "x"], "windows"), null);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test({
  name:
    "build: a compile over a RUNNING program is told which file is in use — and no longer once it stopped",
  ignore: Deno.build.os !== "windows", // only Windows refuses to replace a running program
  async fn() {
    const dir = await tempDir("aio-output-held-");
    try {
      const exe = join(dir, "app.exe");
      await Deno.copyFile(Deno.execPath(), exe);
      const child = new Deno.Command(exe, {
        args: ["eval", "setInterval(() => {}, 1000)"],
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).spawn();
      try {
        // Spelled as the build spells it: relative, without the `.exe`.
        const said = await outputHeld(dir, argv("app"));
        assert(said, "a running program's file must be reported as held");
        assertStringIncludes(said, exe);
        assertStringIncludes(said, "still running");
        // Linux and macOS replace it: nothing to say there.
        assertEquals(await outputHeld(dir, argv("app"), "linux"), null);
      } finally {
        child.kill("SIGKILL");
        await child.status;
      }
      // Its exit is reported a moment before the file is free again.
      const end = Date.now() + 10_000;
      let after = await outputHeld(dir, argv("app"));
      while (after && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 20));
        after = await outputHeld(dir, argv("app"));
      }
      assertEquals(after, null);
    } finally {
      await dropTempDir(dir);
    }
  },
});
