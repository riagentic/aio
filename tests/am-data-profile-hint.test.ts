// `am backup --profile=p1` refused a running p1 with
// `Run "am stop --app=<id>" first, or "am backup --force"` — commands with no
// `--profile`, so run as written they stopped (or backed up) the DEFAULT
// instance while p1 kept running. Measured as a user with both instances up.
// Every "stop it first" hint names the instance the verb was aimed at.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { cmdBackup, cmdRestore } from "../src/am/am-cmd-data.ts";
import { _resetHomePin, targetHome } from "../src/am/am-utils.ts";
import {
  _resetAppDirs,
  appDirs,
  ensureAppDirs,
  profileHome,
  writeAppMeta,
} from "../src/server/app-dirs.ts";
import { AppLock } from "../src/server/single-instance-lock.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { join } from "@std/path";

const APP = "hintprof";
const SUITE_HOME = Deno.env.get("AIO_APPS_DIR");

async function run(
  fn: (args: string[], flags: Record<string, unknown>) => Promise<void>,
  args: string[],
): Promise<{ error: string; exited: number | null }> {
  const chunks: string[] = [];
  const [log, err, exit] = [console.log, console.error, Deno.exit];
  let exited: number | null = null;
  console.log = (...a: unknown[]) => chunks.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => chunks.push(a.map(String).join(" "));
  // deno-lint-ignore no-explicit-any
  (Deno as any).exit = (code = 0) => {
    exited = code;
    throw new Error("__exit__");
  };
  try {
    await fn(args, { app: APP, json: true, profile: "p1" });
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "__exit__") throw e;
  } finally {
    console.log = log;
    console.error = err;
    // deno-lint-ignore no-explicit-any
    (Deno as any).exit = exit;
  }
  const doc = JSON.parse(chunks.join("\n") || "{}") as { error?: string };
  return { error: doc.error ?? "", exited };
}

Deno.test("am backup/restore --profile: the 'stop it first' hint names the profile", async () => {
  const base = await tempDir("am-data-hint-");
  Deno.env.set("AIO_APPS_DIR", join(base, "apps"));
  _resetAppDirs();
  _resetHomePin();
  // What `am.ts` binds for `--profile=p1` before any verb runs.
  targetHome(APP, profileHome(APP, "p1"), "p1");
  const d = appDirs(APP);
  ensureAppDirs(d);
  Deno.writeTextFileSync(d.stateDb, "LIVE");
  writeAppMeta(d, { appId: APP, aio: "1.0.0-test", profile: "p1" });
  const archive = join(base, "archive");
  Deno.mkdirSync(archive);
  Deno.writeTextFileSync(join(archive, "state.db"), "ARCHIVE");
  // The running p1 instance: its lock, held by this (live) process.
  const lock = new AppLock(APP, d.home, "p1");
  try {
    const got = await lock.acquire(0);
    assertEquals(got.ok, true);
    const results = [
      await run(cmdBackup, [join(base, "bk")]),
      await run(cmdRestore, [archive]),
    ];
    assertEquals(results.length, 2);
    for (const r of results) {
      assertEquals(r.exited, 1, r.error);
      assertStringIncludes(r.error, `am stop --app=${APP} --profile=p1`);
    }
    assertStringIncludes(
      results[0]!.error,
      `am backup --app=${APP} --profile=p1 --force`,
    );
    assertEquals(Deno.readTextFileSync(d.stateDb), "LIVE");
  } finally {
    lock.release();
    _resetAppDirs();
    _resetHomePin();
    if (SUITE_HOME === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", SUITE_HOME);
    await dropTempDir(base);
  }
});
