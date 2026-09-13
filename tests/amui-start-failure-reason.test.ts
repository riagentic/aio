// amui's "failed to start" reason came from the last 6 lines of the launcher
// capture — and the last lines of a crash are its stack frames, so the one
// line that said WHAT failed was cut off above them.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import * as proc from "../amui/src/server/proc.server.ts";

const startFailureReason = (text: string, n?: number) =>
  proc.startFailureReason(text, n);

Deno.test("amui start failure: the error line wins over the stack frames after it", async () => {
  const log = [
    "\x1b[32m[aio]\x1b[0m booting todo",
    "error: Uncaught (in promise) AddrInUse: Address already in use (os error 98)",
    ...Array.from(
      { length: 8 },
      (_, i) => `    at listen (ext:deno_net/${i}.js:1:1)`,
    ),
  ].join("\n");
  // Through the file amui's launcher writes and `awaitBoot` reads back.
  const dir = await tempDir("amui-start-reason-");
  try {
    await Deno.writeTextFile(proc.startLogPath(dir), log);
    const reason = await proc.startLogTail(dir);
    assertStringIncludes(reason, "AddrInUse: Address already in use");
    assertEquals(reason.includes("    at "), false, "no stack frames");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("amui start failure: `not found` and an ERROR log level count as the reason", () => {
  const log = [
    "loading",
    'error: Module not found "file:///app/src/cells.ts".',
    "    at file:///app/src/app.ts:3:8",
  ].join("\n");
  assertEquals(
    startFailureReason(log),
    'error: Module not found "file:///app/src/cells.ts".',
  );
  const levelled = [
    "2026-09-13 INFO starting",
    "2026-09-13 ERROR cell todo threw in init",
    "2026-09-13 INFO shutting down",
  ].join("\n");
  assertEquals(
    startFailureReason(levelled),
    "2026-09-13 ERROR cell todo threw in init",
  );
});

Deno.test("amui start failure: no error line — the last lines, frames dropped", () => {
  const log = ["one", "two", "    at x (y.ts:1:1)", "three"].join("\n");
  assertEquals(startFailureReason(log, 2), "two · three");
  assertEquals(
    startFailureReason("    at a\n    at b", 6),
    "    at a ·     at b",
  );
  assertEquals(startFailureReason(""), "");
});
