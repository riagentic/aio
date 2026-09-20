// `db.snapshot()` must be DURABLE, not only atomic.
//
// It wrote `VACUUM INTO <tmp>`, verified the copy, and renamed it over the
// destination — atomic at every instant, but nothing was fsynced. After a
// power cut the rename can be on disk while the copy's data blocks are not
// (a zero-length or torn snapshot under the good name — the file
// `checkIntegrityOnBoot` restores from), or the rename itself can be lost
// (the previous snapshot back). The copy is now synced before the rename and
// the directory after it.
import { assert } from "@std/assert";
import { join } from "@std/path";
import { createDB } from "../src/db/async-db.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("db.snapshot: the copy is fsynced before its rename, and the directory after", async () => {
  const dir = await tempDir("aio-snapshot-durable-");
  const db = createDB(join(dir, "a.db"));
  const ops: string[] = [];
  const opened = new WeakMap<Deno.FsFile, string>();
  const origOpen = Deno.open;
  const origRename = Deno.rename;
  const proto = Deno.FsFile.prototype;
  const origSync = proto.sync;
  const origSyncData = proto.syncData;
  const mine = (p: string) => p.startsWith(dir);
  try {
    await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    await db.execute("INSERT INTO t (v) VALUES ('one')");
    const snap = join(dir, "a.db.snapshot");
    Deno.open = (async (p: string | URL, o?: Deno.OpenOptions) => {
      const f = await origOpen(p, o);
      opened.set(f, String(p));
      return f;
    }) as typeof Deno.open;
    Deno.rename = (async (a: string | URL, b: string | URL) => {
      if (mine(String(b))) ops.push(`rename ${a} -> ${b}`);
      return await origRename(a, b);
    }) as typeof Deno.rename;
    const record = (f: Deno.FsFile) => {
      const p = opened.get(f);
      if (p && mine(p)) ops.push(`sync ${p}`);
    };
    proto.sync = function (this: Deno.FsFile) {
      record(this);
      return origSync.call(this);
    };
    proto.syncData = function (this: Deno.FsFile) {
      record(this);
      return origSyncData.call(this);
    };
    await db.snapshot!(snap);
    const rename = ops.findIndex((o) => o.startsWith("rename "));
    assert(rename >= 0, ops.join("\n"));
    const tmp = ops[rename]!.slice("rename ".length).split(" -> ")[0]!;
    assert(
      ops.slice(0, rename).includes(`sync ${tmp}`),
      `the copy was not fsynced before the rename:\n${ops.join("\n")}`,
    );
    if (Deno.build.os !== "windows") {
      assert(
        ops.slice(rename + 1).includes(`sync ${dir}`),
        `the directory was not fsynced after the rename:\n${ops.join("\n")}`,
      );
    }
  } finally {
    Deno.open = origOpen;
    Deno.rename = origRename;
    proto.sync = origSync;
    proto.syncData = origSyncData;
    await db.close();
    await dropTempDir(dir);
  }
});
