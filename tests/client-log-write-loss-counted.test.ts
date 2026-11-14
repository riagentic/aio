// client.log write failures were reported three times, then nothing for the
// life of the process: no count of the lines lost, no periodic report, no
// "recovered" line — and the counter was module-global, so one app's broken
// directory muted every other app's reports. It now keeps the logger's own
// accounting (`noteWriteFailure`/`noteWriteSuccess` in logger-core), per file.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  disposeClientLog,
  flushClientLog,
  initClientLog,
  writeClientLog,
} from "../src/server/client-log.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("client.log: lost lines are counted, reported periodically, recovered loudly, per file", async () => {
  const a = await tempDir("aio-clientlog-loss-a-");
  const b = await tempDir("aio-clientlog-loss-b-");
  // A directory where the file should be: every append fails (EISDIR).
  await Deno.mkdir(join(a, "client.log"));
  await Deno.mkdir(join(b, "client.log"));
  const said: string[] = [];
  const orig = console.error;
  console.error = (...x: unknown[]) => said.push(x.map(String).join(" "));
  try {
    initClientLog(a);
    // Distinct client indices: under the per-client rate limit.
    for (let i = 0; i < 300; i++) {
      writeClientLog(i, { level: "error", msg: `line ${i}`, ts: Date.now() });
      await flushClientLog(); // one failure at a time: a deterministic count
    }
    const aReports = said.filter((s) => s.includes(`${a}/client.log`));
    // The first three, then every 100th — never silence.
    assertEquals(aReports.length, 6, said.join("\n"));
    assert(aReports.at(-1)!.includes("300 log line(s) lost"), aReports.at(-1));

    // Another file's first failure is its own — not muted by A's outage.
    initClientLog(b);
    writeClientLog(1000, { level: "error", msg: "b", ts: Date.now() });
    await flushClientLog();
    assert(
      said.some((s) =>
        s.includes(`${b}/client.log`) && s.includes("1 consecutive failure")
      ),
      said.join("\n"),
    );

    // A recovers: the outage's total is said, once.
    await Deno.remove(join(a, "client.log"));
    initClientLog(a);
    writeClientLog(2000, { level: "info", msg: "back", ts: Date.now() });
    await flushClientLog();
    const rec = said.filter((s) => s.includes("client.log writing recovered"));
    assertEquals(rec.length, 1, said.join("\n"));
    assert(rec[0]!.includes("after 300 failed write(s)"), rec[0]);
    assert(rec[0]!.includes("294 reports suppressed"), rec[0]);
    assert(rec[0]!.includes("300 log line(s) were lost"), rec[0]);
    assert((await Deno.readTextFile(join(a, "client.log"))).includes("back"));
  } finally {
    console.error = orig;
    disposeClientLog();
    await dropTempDir(a);
    await dropTempDir(b);
  }
});
