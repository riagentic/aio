// The suite runner names a test root whose filesystem cannot hold what the
// suite measures (an ecryptfs home: no creation time, `utime` in whole
// seconds) — instead of 36 assertions that each name only the symptom.
import { assertEquals } from "@std/assert";
import { testRootLacks } from "../scripts/test-shards.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("test root precheck: a filesystem with no creation time and whole-second utime is named for both", async () => {
  const dir = await tempDir("fs-probe-");
  try {
    const ecryptfs = (p: string): Deno.FileInfo => {
      const s = Deno.lstatSync(p);
      const m = s.mtime
        ? new Date(s.mtime.getTime() - s.mtime.getTime() % 1000)
        : null;
      return { ...s, birthtime: null, mtime: m };
    };
    assertEquals(testRootLacks(dir, ecryptfs), [
      "file creation times",
      "millisecond modification times set by utime",
    ]);
    // One that keeps both says nothing.
    const full = (p: string): Deno.FileInfo => {
      const s = Deno.lstatSync(p);
      return { ...s, birthtime: s.birthtime ?? new Date() };
    };
    const real = testRootLacks(dir);
    if (!real.includes("millisecond modification times set by utime")) {
      assertEquals(testRootLacks(dir, full), []);
    }
    // The probe leaves nothing behind.
    assertEquals([...Deno.readDirSync(dir)], []);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("test root precheck: a folder that cannot be written is said, not thrown", () => {
  const lacks = testRootLacks("/nonexistent-aio-test-root/x");
  assertEquals(lacks.length, 1);
  assertEquals(lacks[0]!.startsWith("a writable folder (NotFound"), true);
});
