// `db.snapshot(path)` works when the folder is reached through a symlink.
//
// macOS's SQLite refuses to CREATE a database file whose path passes through
// a symlink ("unable to open database"), and on macOS every temp dir is one
// (`/var/folders/…` → `/private/var/folders/…`), as is a home on another
// volume. `VACUUM INTO` and the verifying `ATTACH` both create/open by path,
// so a snapshot there rejected — and a snapshot is what boot recovery
// restores from. Field report, real Apple-silicon Mac. Linux never shows it,
// so this makes the link itself: the path shape is the same on every OS.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createDB } from "../src/db/async-db.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test({
  name: "db.snapshot: a destination folder behind a symlink gets the snapshot",
  // Creating a symlink needs a privilege on a stock Windows; the defect is
  // macOS's, and `tests/sql.test.ts` covers snapshot on a plain path there.
  async fn() {
    const dir = await Deno.realPath(await tempDir("db-snap-link-"));
    try {
      const real = join(dir, "real");
      const link = join(dir, "link");
      await Deno.mkdir(real);
      await Deno.symlink(real, link);
      const db = createDB(join(real, "a.db"));
      try {
        await db.execute("CREATE TABLE t(x INTEGER)");
        await db.execute("INSERT INTO t VALUES (7)");
        const snap = join(link, "snap.db");
        await db.snapshot!(snap);
        // A second one replaces the first: the rolling-snapshot recipe.
        await db.snapshot!(snap);
      } finally {
        await db.close();
      }
      const copy = createDB(join(real, "snap.db"), { readonly: true });
      try {
        assertEquals((await copy.query("SELECT x FROM t")).rows, [{ x: 7 }]);
      } finally {
        await copy.close();
      }
      // Nothing half-made is left beside it.
      const left = [...Deno.readDirSync(real)].map((e) => e.name)
        .filter((n) => n.includes(".tmp-"));
      assert(left.length === 0, `temp files left: ${left.join(", ")}`);
    } finally {
      await dropTempDir(dir);
    }
  },
});
