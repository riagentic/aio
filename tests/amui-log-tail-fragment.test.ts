// amui's Logs tab tails a big log by seeking to the last 512 KB. The seek lands
// mid-line, and that FRAGMENT (a half timestamp, a word cut in two, maybe a
// split UTF-8 sequence) was shown as the first line of the tail.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { readLogs } from "../amui/src/server/proc.server.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("amui readLogs: a seeked tail starts at a whole line, never a fragment", async () => {
  const dir = await tempDir("amui-log-tail-");
  try {
    // ~1 MB of whole lines, each one self-identifying, so any fragment shows.
    const lines: string[] = [];
    for (let i = 0; i < 12_000; i++) {
      lines.push(
        `2026-09-25 10:00:00.000  INFO  app  line ${i} ` + "é".repeat(30),
      );
    }
    await Deno.writeTextFile(join(dir, ".aio.log"), lines.join("\n") + "\n");
    const r = await readLogs(dir, "combined", 100_000);
    assert(r.truncated, "the fixture is past the tail window");
    assert(r.lines.length > 0);
    const whole = new Set(lines);
    const frag = r.lines.filter((l) => !whole.has(l));
    assertEquals(frag, [], "every tailed line must be a whole log line");
  } finally {
    await dropTempDir(dir);
  }
});
