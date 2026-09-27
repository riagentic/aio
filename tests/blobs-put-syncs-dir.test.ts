// A blob put renames `.tmp-*` to its hash. A rename is atomic, not durable:
// until the blob DIRECTORY is fsynced, a power cut can undo it — the app's
// state (already committed) then holds a blob id whose file is gone. put()
// used to fsync the bytes and never the directory.
import { assert } from "@std/assert";
import { join, resolve } from "@std/path";
import { _resetBlobStores, openBlobStore } from "../src/server/blobs.ts";
import { appDirs } from "../src/server/app-dirs.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test({
  name: "blobs: put() fsyncs the blob directory after the rename",
  ignore: Deno.build.os === "windows", // syncDir is a no-op there
  fn: async () => {
    const home = await tempDir("aio-blob-dirsync-");
    _resetBlobStores();
    const realOpen = Deno.open;
    const synced: string[] = [];
    try {
      const store = openBlobStore("blobdirsync", home);
      const dir = resolve(join(appDirs("blobdirsync", home).files, "blobs"));
      (Deno as { open: typeof Deno.open }).open = async (path, opts) => {
        const f = await realOpen(path, opts);
        const p = resolve(String(path));
        const realSync = f.sync.bind(f);
        f.sync = async () => {
          await realSync();
          synced.push(p);
        };
        return f;
      };
      const { id } = await store.put(new TextEncoder().encode("durable"));
      assert((await Deno.stat(join(dir, id))).isFile);
      assert(
        synced.includes(dir),
        `blob dir never fsynced; synced: ${JSON.stringify(synced)}`,
      );
    } finally {
      (Deno as { open: typeof Deno.open }).open = realOpen;
      _resetBlobStores();
      await dropTempDir(home);
    }
  },
});
