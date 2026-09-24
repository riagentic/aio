// `launch.json` lives in the app's HOME, and is written like any file there.
//
// It briefly went through the LOCK dir's rules (chmod 0700, refuse what is not
// ours) — and a home on exFAT/NTFS/CIFS, or owned by another uid, cannot be
// chmodded: the refusal was swallowed, launch.json silently not written, and
// `am restart` came back without the `--env-file` the app was started with (a
// field bug, twice). Plain mkdir again; a write that fails says so.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { _resetAppDirs, appDirs } from "../src/server/app-dirs.ts";
import {
  readLaunchInfo,
  writeLaunchInfo,
} from "../src/server/single-instance-lock.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const POSIX = Deno.build.os !== "windows";

async function withApps(fn: (apps: string) => void): Promise<void> {
  const apps = await tempDir("launch-home-");
  const prev = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", apps);
  _resetAppDirs();
  try {
    fn(apps);
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
    _resetAppDirs();
    await dropTempDir(apps);
  }
}

Deno.test({
  name: "writeLaunchInfo: the home keeps its mode, and the record is written",
  ignore: !POSIX,
  fn: () =>
    withApps(() => {
      const home = appDirs("lh").home;
      Deno.mkdirSync(home, { recursive: true, mode: 0o755 });
      Deno.chmodSync(home, 0o755);
      const flags = ["--env-file=.env.prod", "--port=8140"];
      assertEquals(writeLaunchInfo("lh", { flags, entry: "main.ts" }), null);
      assertEquals(readLaunchInfo("lh")?.flags, flags);
      // aio-ok(umask): asserts bits PRESENT (0755, set by chmod above) — a restrictive umask cannot hide a narrowing chmod.
      assertEquals(Deno.statSync(home).mode! & 0o777, 0o755, "not chmodded");
    }),
});

Deno.test("writeLaunchInfo: a launch that cannot be recorded says so", () =>
  withApps(() => {
    const home = appDirs("lf").home;
    Deno.mkdirSync(join(home, ".."), { recursive: true });
    Deno.writeTextFileSync(home, "a FILE where the home should be");
    const said = writeLaunchInfo("lf", { flags: ["--env-file=.env"] });
    assert(said !== null, "a failed write must not be silent");
    assertStringIncludes(said, "am restart");
    assertStringIncludes(said, "--env-file");
  }));
