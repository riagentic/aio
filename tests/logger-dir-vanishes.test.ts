// A log directory can disappear under a running app: /tmp gets cleaned, a deploy
// replaces the tree, a test removes its sandbox. The logger used to emit
// "[logger] write failed for …" for every line from then on — the app lost its
// voice until restart, and the noise trains people to ignore log output.
//
// Found while building the multi-client harness, which boots seven servers in one
// process: each teardown deleted a directory the (process-wide) logger still had
// buffered writes for. The harness made it visible; the behaviour was always wrong.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { AioLogger } from "../src/diagnostics/logger-core.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("logger: a deleted log directory is recreated, not endlessly reported", async () => {
  const base = await Deno.makeTempDir({ prefix: "aio-log-vanish-" });
  const dir = join(base, "logs");
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...a: unknown[]) => errors.push(a.map(String).join(" "));
  try {
    const logger = new AioLogger({ dir, console: false, level: "info" });
    await logger.init();
    logger.pub("info", "app", "before");
    await logger.flush(500);
    assert(
      (await Deno.stat(join(dir, "app.log"))).isFile,
      "the first write lands normally",
    );

    // The directory goes away underneath it.
    await Deno.remove(dir, { recursive: true });
    logger.pub("info", "app", "after the directory vanished");
    await logger.flush(500);
    await sleep(50);

    // It came back, with the line in it.
    const text = await Deno.readTextFile(join(dir, "app.log"));
    assert(
      text.includes("after the directory vanished"),
      `the line must survive: ${text}`,
    );
    assertEquals(
      errors.filter((e) => e.includes("[logger] write failed")),
      [],
      "and recovering must be silent — an app that logs about being unable to " +
        "log is worse than one that just fixes it",
    );
  } finally {
    console.error = origError;
    await Deno.remove(base, { recursive: true }).catch(() => {});
  }
});

Deno.test("logger: a genuinely unwritable path still reports (bounded)", async () => {
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...a: unknown[]) => errors.push(a.map(String).join(" "));
  try {
    // /proc is real and not writable — recreation cannot rescue this, so the
    // failure must still be reported rather than swallowed by the new path.
    const logger = new AioLogger({
      dir: "/proc/aio-cannot-write-here",
      console: false,
      level: "info",
    });
    await logger.init().catch(() => {});
    logger.pub("info", "app", "x");
    await logger.flush(500);
    await sleep(50);
    assert(
      errors.some((e) => e.includes("[logger]")),
      "a real permission failure is still loud",
    );
  } finally {
    console.error = origError;
  }
});
