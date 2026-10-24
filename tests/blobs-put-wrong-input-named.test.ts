// blobs.put() handed a Blob/File (what `req.formData()` gives an upload
// route), an ArrayBuffer or a string used to fail as "data is not async
// iterable" — no store, no fix. It now names what it got and what to pass,
// and leaves no temp file behind.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { _resetBlobStores, openBlobStore } from "../src/server/blobs.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("blobs.put: a Blob, ArrayBuffer or string is refused by name, with the fix", async () => {
  const home = await tempDir("aio-blobs-input-");
  _resetBlobStores();
  try {
    const store = openBlobStore("blobinput", home);
    const bytes = new TextEncoder().encode("hello");
    const cases: [unknown, string][] = [
      [new File([bytes], "a.txt"), "file.stream()"],
      [new Blob([bytes]), "file.stream()"],
      [bytes.buffer, "new Uint8Array(buffer)"],
      ["hello", "TextEncoder"],
    ];
    for (const [input, fix] of cases) {
      const e = await assertRejects(
        () => store.put(input as Uint8Array),
        TypeError,
      );
      assert(e.message.startsWith("blobs: put()"), e.message);
      assert(e.message.includes(fix), e.message);
    }
    // The fix the message names works.
    const info = await store.put(new File([bytes], "a.txt").stream());
    assertEquals(info.size, 5);
    // Any async iterable of chunks still works, as it did before.
    async function* gen() {
      yield bytes;
      yield bytes;
    }
    const twice = await store.put(
      gen() as unknown as ReadableStream<Uint8Array>,
    );
    assertEquals(twice.size, 10);
    // …and so do sync iterables of chunks: an array, a generator.
    function* syncGen() {
      yield bytes;
      yield bytes;
      yield bytes;
    }
    for (
      const [input, size] of [
        [[bytes, bytes], 10],
        [syncGen(), 15],
      ] as const
    ) {
      const got = await store.put(
        input as unknown as ReadableStream<Uint8Array>,
      );
      assertEquals(got.size, size);
    }
    const left = [];
    for await (const f of Deno.readDir(store.dir)) {
      if (f.name.startsWith(".tmp-")) left.push(f.name);
    }
    assertEquals(left, []);
  } finally {
    _resetBlobStores();
    await dropTempDir(home);
  }
});
