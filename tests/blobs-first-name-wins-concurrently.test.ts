// "First name wins" held only in sequence. Two concurrent puts of the same
// bytes both read "no name yet", both wrote their own, and the last write won
// on disk — while the other caller was handed back ITS name, which `info()`
// contradicted a moment later. A put must report the name that is recorded.
import { assert, assertEquals } from "@std/assert";
import { _resetBlobStores, openBlobStore } from "../src/server/blobs.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

Deno.test("blobs: concurrent puts of the same bytes agree on ONE recorded name", async () => {
  const home = await tempDir("aio-blobs-name-race-");
  _resetBlobStores();
  try {
    const store = openBlobStore("blobnamerace", home);
    for (let round = 0; round < 20; round++) {
      const bytes = new TextEncoder().encode(`same bytes ${round}`);
      const names = ["a.txt", "b.txt", "c.txt", "d.txt"];
      const results = await Promise.all(
        names.map((name) => store.put(bytes, { name })),
      );
      const recorded = (await store.info(results[0]!.id))?.name;
      assert(recorded !== undefined, "a name was recorded");
      assertEquals(results.length, names.length);
      for (const r of results) {
        assertEquals(
          r.name,
          recorded,
          `round ${round}: every put must report the name on disk`,
        );
      }
    }
    // No temp metadata is left behind.
    const left: string[] = [];
    for await (const e of Deno.readDir(store.dir)) {
      if (e.name.startsWith(".tmp-")) left.push(e.name);
    }
    assertEquals(left, []);
  } finally {
    _resetBlobStores();
  }
});
