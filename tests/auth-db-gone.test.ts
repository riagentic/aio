// auth.db deleted under a running app must fail loud, never commit into the
// unlinked inode.
//
// state.db already refuses (`_dbFileGone` in persistence.ts). auth.db did not:
// delete it (a cleared tmp dir, a volume that was not really persistent) and
// SQLite went on committing into the unlinked file — signup answered 201, a
// login issued a working session, and after the restart the account and every
// session were simply gone.
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { openUserStore } from "../src/server/auth-users.ts";
import { openSessionStore } from "../src/server/sessions.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("auth.db deleted under a running app: writes throw, reads still answer", async () => {
  const dir = await tempDir("aio-authdb-gone-");
  const path = join(dir, "auth.db");
  const users = openUserStore(path);
  const sessions = openSessionStore(path);
  try {
    await users.create("alice", "password123");
    for (const f of ["auth.db", "auth.db-wal", "auth.db-shm"]) {
      await Deno.remove(join(dir, f)).catch((e) => {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      });
    }
    await assertRejects(
      () => users.create("bob", "password123"),
      Error,
      "GONE",
    );
    assertThrows(
      () => sessions.issue({ id: "alice", role: "user" }),
      Error,
      "GONE",
    );
    assertEquals(users.get("alice")?.id, "alice", "reads are not refused");
  } finally {
    users.close();
    sessions.close();
    await dropTempDir(dir);
  }
});

// Reading an EXPIRED session deletes its row on the way (hygiene). With
// auth.db gone that delete is refused — and the read threw with it. The WS
// session sweep reads on a timer, so the throw was an uncaughtException: one
// expired session socket after auth.db was deleted took the whole app down.
Deno.test("auth.db deleted: reading an expired session answers null, never throws", async () => {
  const dir = await tempDir("aio-authdb-gone-exp-");
  const path = join(dir, "auth.db");
  const sessions = openSessionStore(path, 30);
  try {
    const token = sessions.issue({ id: "alice", role: "user" });
    for (const f of ["auth.db", "auth.db-wal", "auth.db-shm"]) {
      await Deno.remove(join(dir, f)).catch((e) => {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      });
    }
    await new Promise((r) => setTimeout(r, 60));
    assertEquals(sessions.get(token), null);
  } finally {
    sessions.close();
    await dropTempDir(dir);
  }
});

Deno.test("auth.db guard: an in-memory store is never refused", async () => {
  const users = openUserStore(":memory:");
  const sessions = openSessionStore(":memory:");
  try {
    await users.create("alice", "password123");
    assertEquals(
      typeof sessions.issue({ id: "alice", role: "user" }),
      "string",
    );
  } finally {
    users.close();
    sessions.close();
  }
});
