// `am profile --out=<file>` exports a `.aioapp` — and that file CONTAINS the
// app key, the forever credential that grants raw state reads, arbitrary
// dispatch and SQL to anyone holding it under `--expose`. The server keeps
// that key 0600 inside a 0700 directory (app-key.ts); the export wrote it at
// the process umask default (0644) into $HOME or /tmp, handing it to every
// local user on the machine.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { cmdProfile } from "../src/am/am-cmd-inspect.ts";
import { removeLock, writeLock } from "../src/server/single-instance-lock.ts";
import type { GlobalFlags } from "../src/am/am-types.ts";

const isWindows = Deno.build.os === "windows";

async function exportProfile(
  appId: string,
  file: string,
): Promise<void> {
  const realLog = console.log;
  console.log = () => {};
  try {
    await cmdProfile(
      [`--out=${file}`],
      { json: true, app: appId } as GlobalFlags,
    );
  } finally {
    console.log = realLog;
  }
}

Deno.test({
  name: "am profile --out: the exported key file is owner-only (0600)",
  ignore: isWindows, // no POSIX modes
  async fn() {
    const appId = `am-profile-perm-${Deno.pid}`;
    const dir = await Deno.makeTempDir({ prefix: "am-profile-" });
    const file = join(dir, "app.aioapp");
    writeLock({
      appId,
      pid: Deno.pid,
      port: 8123,
      startedAt: Date.now(),
      status: "started",
      cwd: Deno.cwd(),
      discovery: { title: "T", tls: false, needsAuth: true },
    });
    try {
      await exportProfile(appId, file);
      const mode = (await Deno.stat(file)).mode! & 0o777;
      assertEquals(
        mode.toString(8),
        "600",
        "a credential file must not be world-readable",
      );

      // …and a file that ALREADY exists keeps no looser mode: `mode` in
      // writeTextFile only applies at creation, so an export over yesterday's
      // 0644 file would have stayed 0644.
      await Deno.writeTextFile(file, "stale");
      await Deno.chmod(file, 0o644);
      await exportProfile(appId, file);
      assertEquals(
        ((await Deno.stat(file)).mode! & 0o777).toString(8),
        "600",
        "re-exporting must tighten an existing file, not inherit its mode",
      );
      assert(
        (await Deno.readTextFile(file)).includes(`"name"`),
        "and it really wrote the profile",
      );
    } finally {
      removeLock(appId);
      await Deno.remove(dir, { recursive: true });
    }
  },
});
