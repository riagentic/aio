// A mid-run log-budget rotation keeps the pending "repeated N times" count.
//
// Repeat suppression holds identical consecutive lines as a COUNT, written as
// "… last message repeated N times" when a different line arrives. The mid-run
// budget pass reset that memo (`_lastLine.clear()`) after rotating, so repeats
// counted while the pass ran vanished: the log showed the line once and never
// said it had happened N more times — a storm read as a single event.
import { assert, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { AioLogger } from "../src/diagnostics/logger.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("logger: a mid-run budget rotation keeps the pending repeat count", async () => {
  const dir = await tempDir("aio-logrepeat-");
  const logger = new AioLogger({
    dir,
    level: "info",
    console: false,
    heartbeat: 0,
    logBudget: 64 * 1024, // checked every 64 KB
    backupLogs: true,
    backupKeep: 2,
  });
  try {
    await logger.init();
    let app = "";
    for (let round = 0; round < 10; round++) {
      for (let i = 0; i < 80; i++) {
        logger.pub("info", "test", `r${round} line ${i} ${"z".repeat(1000)}`);
      }
      const flushed = logger.flush(); // writes, then starts the budget pass
      // …and while that pass is in flight, a burst of one identical line.
      for (let i = 0; i < 20; i++) logger.pub("info", "test", "repeat me");
      await flushed;
      logger.pub("info", "test", `round ${round} done`);
      await logger.flush();
      app = await Deno.readTextFile(join(dir, "app.log"));
      if (app.includes("reached mid-run")) break;
    }
    assert(app.includes("reached mid-run"), "no mid-run rotation happened");
    assertStringIncludes(
      app,
      "last message repeated 19 times",
      "the repeats counted across the rotation were dropped",
    );
  } finally {
    logger.onStop();
    await logger.flush();
    await dropTempDir(dir);
  }
});
