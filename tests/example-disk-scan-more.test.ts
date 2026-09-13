// examples/disk said "stopped at this scan's budget … Rescan to continue", and
// Rescan could never continue: it re-ran the SAME walk, with the same limits,
// over the same readDir order — so a folder with more than `maxEntries` (200)
// children showed the same first 200 on every click, forever, under a note
// promising the rest. A partial answer is only honest if there is a way to the
// whole one. `more()` resumes where the last scan stopped and APPENDS.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { testCell } from "../src/testing/cell-test.ts";
import { disk } from "../examples/disk/src/cell.ts";

Deno.test("example disk: scanFolders resumes past the folders it already sized", async () => {
  const io = await import("../examples/disk/src/disk.server.ts");
  const root = await Deno.makeTempDir({ prefix: "aio-disk-more-" });
  try {
    for (let i = 0; i < 12; i++) await Deno.mkdir(join(root, `d${i}`));
    const limits = { ...io.DEFAULT_LIMITS, maxEntries: 5 };
    const seen = new Set<string>();
    let rounds = 0;
    for (;;) {
      const r = await io.scanFolders(
        root,
        new AbortController().signal,
        limits,
        seen,
      );
      rounds++;
      for (const e of r.entries) {
        assert(!seen.has(e.name), `${e.name} was sized twice`);
        seen.add(e.name);
      }
      if (!r.more) break;
      assert(rounds < 10, "the scan never reached the end");
    }
    assertEquals(seen.size, 12, "every child is reached");
    assertEquals(rounds, 3, "5 + 5 + 2");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

testCell(
  disk,
  "more() continues a capped scan to the end instead of repeating it",
  async (t) => {
    const root = await Deno.makeTempDir({ prefix: "aio-disk-more-cell-" });
    try {
      // One over the default cap of 200, plus a few.
      for (let i = 0; i < 205; i++) await Deno.mkdir(join(root, `d${i}`));
      await t.send.open(root);
      let s = t.getState();
      assertEquals(s.entries.length, 200, "the first scan stops at its cap");
      assert(s.partial && s.hasMore, "and says there is more");

      await t.send.more();
      s = t.getState();
      assertEquals(s.path, root);
      assertEquals(s.entries.length, 205, "the rest is appended");
      assertEquals(
        new Set(s.entries.map((e) => e.name)).size,
        205,
        "with no folder listed twice",
      );
      assertEquals(s.hasMore, false);
      assertEquals(s.partial, false, "and the answer is now whole");
      assertEquals(s.scanning, false);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
);
