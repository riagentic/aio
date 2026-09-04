// A start that is about to be REFUSED must not touch the running app's files.
//
// `logger.init()` happens at the very top of boot; `acquireSingletonLock` is
// several phases later, after the port is decided. So a second `deno run` of
// the same app — refused a moment later with "Already running" — first
// ROTATED the live instance's logs: `app.log` became `app.log.1`, the running
// process kept appending to the renamed inode, and `am logs` then answered
// "no log file at …/logs/stdout.log" for a perfectly healthy app. That is the
// exact failure `logPathFor`'s own doc comment (am-cmd-inspect.ts) says was
// fixed.
//
// The same bug was already closed for `--help`/`--version` ("the logger had
// ROTATED the app's log files … one generation lost off the end of keep every
// time someone asked what the flags were"); the far more common case, a
// duplicate start, was left in. It fires on the port-already-in-use path too.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { AioLogger } from "../src/diagnostics/logger-core.ts";

async function lines(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(dir)) out.push(e.name);
  return out.sort();
}

Deno.test("logger.init({ rotate: false }) leaves the previous run's files alone", async () => {
  const dir = await Deno.makeTempDir({ prefix: "no-rotate-" });
  try {
    // Run 1 writes a log.
    const first = new AioLogger({
      dir,
      appName: "a",
      heartbeat: 0,
      console: false,
    });
    await first.init();
    first.pub("info", "test", "run one");
    await first.flush();
    assert(
      (await lines(dir)).includes("app.log"),
      `run 1 wrote no app.log: ${(await lines(dir)).join(", ")}`,
    );
    const inode = (await Deno.stat(join(dir, "app.log"))).ino;

    // A start that will be REFUSED: same directory, rotation suppressed.
    const refused = new AioLogger({
      dir,
      appName: "a",
      heartbeat: 0,
      console: false,
    });
    await refused.init({ rotate: false });
    await refused.flush();

    const after = await lines(dir);
    assert(
      after.includes("app.log"),
      `app.log was rotated away by a refused start: ${after.join(", ")}`,
    );
    assert(
      !after.includes("app.log.1"),
      `a refused start archived the live app.log: ${after.join(", ")}`,
    );
    assertEquals(
      (await Deno.stat(join(dir, "app.log"))).ino,
      inode,
      "the live app.log is a different file now — the running process is " +
        "appending to a renamed inode",
    );

    // …and a REAL start still rotates, which is the behaviour being protected.
    const real = new AioLogger({
      dir,
      appName: "a",
      heartbeat: 0,
      console: false,
    });
    await real.init();
    await real.flush();
    assert(
      (await lines(dir)).includes("app.log.1"),
      `an accepted start must still archive the previous run: ${
        (await lines(dir)).join(", ")
      }`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
