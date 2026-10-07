// A database file that failed to OPEN is not held open.
//
// `new DatabaseSync(path)` opens the file; "file is not a database" arrives
// with the first statement — a pragma, in the worker's `open`. The handle
// stayed with the worker, and `close()` terminates a worker whose open failed
// without sending it a `close`, so nothing ever released it. Linux and macOS
// hide that (an open file can be unlinked); Windows refuses the delete with
// "os error 32" until the process exits. Field report, real Windows 11: a
// damaged snapshot probed with `createDB` could never be pruned.
import { assert, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { createDB } from "../src/db/async-db.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

/** Open file descriptors of THIS process that point at `path` (Linux), or
 *  null where the OS gives no such list — there the delete is the proof. */
function fdsOn(path: string): number | null {
  if (Deno.build.os !== "linux") return null;
  let n = 0;
  for (const e of Deno.readDirSync("/proc/self/fd")) {
    try {
      if (Deno.readLinkSync(`/proc/self/fd/${e.name}`) === path) n++;
    } catch { /* aio-ok: an fd closed between the listing and the read */ }
  }
  return n;
}

Deno.test("createDB: a file that is not a database is released when the open fails", async () => {
  const dir = await tempDir("db-not-a-db-");
  try {
    const path = join(await Deno.realPath(dir), "bad.db");
    await Deno.writeTextFile(path, "this is not a sqlite file, at all\n");
    const db = createDB(path, { pragmas: ["PRAGMA journal_mode = WAL"] });
    await assertRejects(() => db.query("SELECT 1"));
    await db.close();
    const held = fdsOn(path);
    assert(held === null || held === 0, `${held} handle(s) still on ${path}`);
    // Windows: this is the line that failed with os error 32.
    await Deno.remove(path);
  } finally {
    await dropTempDir(dir);
  }
});
