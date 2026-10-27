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

// An update's successor inherits the old process's environment — the OLD
// runtime's pid, which exits with the old process: the relaunched app shut
// down 2 s after "confirmed healthy" (field report, aio-launcher §2).
Deno.test({
  name:
    "AppRun: an update's successor watches its OWN runtime, not the old one that exits; a launcher's pid is kept",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const tmp = await tempDir("apprun-relaunch-");
    try {
      const dir = join(tmp, "appimage_extracted_cafe");
      await Deno.mkdir(dir, { recursive: true });
      const out = join(tmp, "out");
      await Deno.writeTextFile(join(dir, "AppRun"), _appRun("notes"));
      // First run: start the successor the way an update does (a new runtime
      // process running AppRun with the relaunch flag), then exit — and the
      // old runtime with it. The successor reports whether the pid it
      // watches is still there once the old one is gone.
      await Deno.writeTextFile(
        join(dir, "notes"),
        `#!/bin/sh
case "$*" in
*--__aio-relaunch-after=*)
  sleep 0.5
  if kill -0 "$AIO_PARENT_PID" 2>/dev/null; then r=up; else r=gone; fi
  echo "$r \${AIO_PARENT_PID_FROM:-}" > "$OUT" ;;
*) sh -c '"$0" "$@"; :' "$(dirname "$0")/AppRun" --__aio-relaunch-after=$$ & ;;
esac
`,
      );
      await Deno.chmod(join(dir, "AppRun"), 0o755);
      await Deno.chmod(join(dir, "notes"), 0o755);
      const result = async (env: Record<string, string>) => {
        await Deno.remove(out).catch(() => {});
        // `; :` keeps the shell as AppRun's parent — the runtime, extracted.
        await new Deno.Command("/bin/sh", {
          args: ["-c", '"$0"; :', join(dir, "AppRun")],
          env: { PATH: "/usr/bin:/bin", OUT: out, ...env },
          clearEnv: true,
        }).output();
        for (let i = 0; i < 100; i++) {
          const got = await Deno.readTextFile(out).catch(() => "");
          if (got.endsWith("\n")) return got.trim();
          await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error("the successor never reported");
      };
      assertEquals(await result({}), "up");
      // A launcher's pid (this process, alive) is marked and kept.
      assertEquals(
        await result({ AIO_PARENT_PID: String(Deno.pid) }),
        "up launcher",
      );
    } finally {
      await dropTempDir(tmp);
    }
  },
});
