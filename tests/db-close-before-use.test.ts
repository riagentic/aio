// Round 2 (db tier): `close()` on a handle that never ran a statement (or
// whose pool had already died) returned early WITHOUT marking it closed, so
// the next late `db.query()` spawned a whole new worker pool that nothing
// would ever close — the live worker then held the process open forever.

import { assertRejects } from "@std/assert";
import { join } from "@std/path";
import { createDB } from "../src/db/async-db.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("db: a handle closed before its first statement refuses later calls", async () => {
  const dir = await tempDir("db-close-before-use-");
  const db = createDB(join(dir, "state.db"));
  try {
    await db.close();
    await assertRejects(() => db.query("SELECT 1"), Error, "CLOSED");
    await assertRejects(
      () => db.execute("CREATE TABLE t (a)"),
      Error,
      "CLOSED",
    );
  } finally {
    await db.close();
    await dropTempDir(dir);
  }
});
