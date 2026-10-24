// amui's Logs tab, "Combined" source: there are three stdout captures — `am
// start`'s `stdout.log`, amui's own `.aio-amui-start.log`, the legacy
// `.aio.log` — and only the launcher of the CURRENT process writes its own.
// The fixed name order read `stdout.log` whenever it existed, so an app that
// was `am start`ed once and then restarted from amui showed the dead
// process's output as its live log, forever.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { readLogs } from "../amui/src/server/proc.server.ts";
import { appDirs } from "../src/server/app-dirs.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const at = (p: string, text: string, sec: number) =>
  Deno.writeTextFile(p, text).then(() => Deno.utime(p, sec, sec));

Deno.test("amui readLogs combined: the NEWEST capture wins, a stale one never shadows it", async () => {
  const dir = await tempDir("amui-log-fresh-");
  try {
    const home = join(dir, "home");
    const logs = appDirs("logapp", home).logs;
    await Deno.mkdir(logs, { recursive: true });
    const now = Math.floor(Date.now() / 1000);
    // am start's capture from an hour ago; amui's restart capture now.
    await at(join(logs, "stdout.log"), "old run\n", now - 3600);
    await at(join(dir, ".aio-amui-start.log"), "new run\n", now);
    await at(join(logs, "app.log"), "framework\n", now);
    const r = await readLogs(dir, "combined", 500, "logapp", home);
    assertEquals(r.lines, ["new run"]);

    // No capture for this run at all (started from a terminal): the framework
    // log, not either stale capture.
    await Deno.utime(join(dir, ".aio-amui-start.log"), now - 1800, now - 1800);
    const t = await readLogs(dir, "combined", 500, "logapp", home);
    assertEquals(t.lines, ["framework"]);

    // A capture that is current keeps its precedence over app.log (richer).
    await Deno.utime(join(logs, "stdout.log"), now, now);
    const u = await readLogs(dir, "combined", 500, "logapp", home);
    assertEquals(u.lines, ["old run"]);
  } finally {
    await dropTempDir(dir);
  }
});
