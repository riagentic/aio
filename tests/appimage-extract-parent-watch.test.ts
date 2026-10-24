// An AppImage started in extract-and-run mode (`APPIMAGE_EXTRACT_AND_RUN=1`,
// how it runs with no FUSE) runs AppRun as the runtime's CHILD, and the
// runtime forwards no signal: measured with appimagetool 1.9.1, a SIGTERM to
// the AppImage's pid ended the runtime and left the app and its window
// running. So AppRun hands the app the runtime's pid as `AIO_PARENT_PID`
// there (the app stops when it goes) — and only there: mounted over FUSE,
// AppRun IS the AppImage's pid and gets the signal itself.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { _appRun } from "../src/build/build-electron.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test({
  name:
    "AppRun: extracted by the AppImage runtime, the app watches the runtime's pid; mounted, nothing is set; a launcher's own pid is kept",
  ignore: Deno.build.os === "windows", // an AppImage is Linux's
  fn: async () => {
    const tmp = await tempDir("apprun-parent-");
    try {
      const run = async (dirName: string, env: Record<string, string> = {}) => {
        const dir = join(tmp, dirName);
        await Deno.mkdir(dir, { recursive: true });
        await Deno.writeTextFile(join(dir, "AppRun"), _appRun("notes"));
        await Deno.writeTextFile(
          join(dir, "notes"),
          `#!/bin/sh\necho "\${AIO_PARENT_PID-unset}"\n`,
        );
        await Deno.chmod(join(dir, "AppRun"), 0o755);
        await Deno.chmod(join(dir, "notes"), 0o755);
        const out = await new Deno.Command(join(dir, "AppRun"), {
          env,
          clearEnv: true,
          stdout: "piped",
        }).output();
        return new TextDecoder().decode(out.stdout).trim();
      };
      // AppRun's parent here is this process — as the runtime is, extracted.
      assertEquals(
        await run("appimage_extracted_0123abcd"),
        String(Deno.pid),
      );
      assertEquals(await run(".mount_notesAbC123"), "unset");
      assertEquals(
        await run("appimage_extracted_feed", { AIO_PARENT_PID: "4242" }),
        "4242",
      );
    } finally {
      await dropTempDir(tmp);
    }
  },
});
