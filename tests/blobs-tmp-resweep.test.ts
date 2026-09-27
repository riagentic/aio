// blobs.ts header: "a crash leaves only a `.tmp-*` file (swept on the next
// put)". The sweep is wired to `ensureDir()`, which runs its body ONCE per
// store per process — so a stale temp file that appears after the first put
// (a crash whose restart came < 1h later, so the boot-time sweep judged it
// too young) is never swept again for the life of a long-running process.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { _resetBlobStores, openBlobStore } from "../src/server/blobs.ts";
import { appDirs } from "../src/server/app-dirs.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("blobs: a stale .tmp-* left behind is swept by a later put, not only the first", async () => {
  const home = await tempDir("aio-r7-blobtmp-");
  _resetBlobStores();
  try {
    const store = openBlobStore("r7blobtmp", home);
    const first = await store.put(new TextEncoder().encode("first"));
    const dir = join(appDirs("r7blobtmp", home).files, "blobs");
    // The blob landed in the dir we think it did.
    assert((await Deno.stat(join(dir, first.id))).isFile);
    // Let the first put's background sweep finish.
    await new Promise((r) => setTimeout(r, 100));

    // A crashed put's leftover, two hours old — well past the 1h threshold.
    const stale = join(dir, ".tmp-crashed-put");
    await Deno.writeTextFile(stale, "partial bytes");
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
    await Deno.utime(stale, twoHoursAgo, twoHoursAgo);

    // The re-sweep is rate-limited (at most every 10 minutes — a readdir per
    // put would be the cost of a large blob dir), so a put 11 minutes later.
    const realNow = Date.now;
    const later = realNow() + 11 * 60_000;
    Date.now = () => later;
    try {
      await store.put(new TextEncoder().encode("second"));
    } finally {
      Date.now = realNow;
    }
    await new Promise((r) => setTimeout(r, 200));

    let stillThere = true;
    try {
      await Deno.stat(stale);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) stillThere = false;
      else throw e;
    }
    assertEquals(
      stillThere,
      false,
      "a >1h-old .tmp-* must be swept by a later put (blobs.ts header)",
    );
  } finally {
    _resetBlobStores();
    await dropTempDir(home);
  }
});
