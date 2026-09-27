// auth.db is shared by two processes by design: the running app and the
// operator's `am auth …` ("works directly on the app's auth.db"). Both stores
// opened it with SQLite's default busy timeout of ZERO, so any write that met
// the other process's write failed at once with "database is locked" — an
// `am auth revoke` during a brute-force attack (every wrong password is a
// write) failed a quarter of the time in a measured loop, and so did the
// app's own logins. A store now waits for the lock instead of throwing.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { openSessionStore } from "../src/server/sessions.ts";
import { openUserStore } from "../src/server/auth-users.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

/** Another process holds auth.db's write lock for `ms`. Resolves once held. */
async function holdWriteLock(path: string, ms: number) {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      `import { DatabaseSync } from "node:sqlite";
       const db = new DatabaseSync(${JSON.stringify(path)});
       db.exec("BEGIN IMMEDIATE");
       console.log("held");
       const end = Date.now() + ${ms};
       while (Date.now() < end) {}
       db.exec("COMMIT");
       db.close();`,
    ],
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const reader = child.stdout.getReader();
  const { value } = await reader.read();
  assertEquals(new TextDecoder().decode(value).trim(), "held");
  return async () => {
    reader.releaseLock();
    await child.stdout.cancel();
    assert((await child.status).success);
  };
}

Deno.test("auth.db stores wait for another process's write lock", async () => {
  const dir = await tempDir("aio-authdb-busy-");
  const path = `${dir}/auth.db`;
  const sessions = openSessionStore(path);
  const users = openUserStore(path, { sessions: () => sessions });
  try {
    await users.create("alice", "password123");
    let done = await holdWriteLock(path, 300);
    const token = sessions.issue({ id: "alice", role: "user" });
    assert(sessions.get(token), "issued while the other process wrote");
    await done();

    done = await holdWriteLock(path, 300);
    assert(users.setRole("alice", "admin"), "role set after the lock cleared");
    await done();
  } finally {
    users.close();
    sessions.close();
    await dropTempDir(dir);
  }
});

// The wait is synchronous (DatabaseSync): the whole event loop — every socket,
// every timer — stands still while it lasts. 5 s froze the app for 5 s behind
// any long `am auth` write. It is bounded at about a second, and a lock held
// longer than that is a loud "database is locked", never a silent success.
Deno.test("auth.db stores give up after about a second — loudly", async () => {
  const dir = await tempDir("aio-authdb-busy-");
  const path = `${dir}/auth.db`;
  const sessions = openSessionStore(path);
  const users = openUserStore(path, { sessions: () => sessions });
  try {
    await users.create("alice", "password123");
    for (
      const write of [
        () => sessions.issue({ id: "alice", role: "user" }),
        () => users.setRole("alice", "admin"),
      ]
    ) {
      const done = await holdWriteLock(path, 2200);
      const t0 = performance.now();
      assertThrows(write, Error, "database is locked");
      const waited = performance.now() - t0;
      assert(waited >= 800 && waited < 2000, `blocked ${waited} ms`);
      await done();
    }
  } finally {
    users.close();
    sessions.close();
    await dropTempDir(dir);
  }
});
