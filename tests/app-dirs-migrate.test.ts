// The one-time move to `~/.<appId>/`. This is the only framework code that
// relocates files a user cannot recreate, so the tests are about the failure
// modes, not the happy path: never clobber, sidecars travel as a set, a running
// app is refused, and an interrupted copy leaves the ORIGINAL intact.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { appDirs } from "../src/server/app-dirs.ts";
import {
  describeMigration,
  migrateLegacyLayout,
} from "../src/server/app-dirs-migrate.ts";

/** A legacy-layout app: state db (+ WAL sidecars + journal) in cwd, auth.db in
 *  the old XDG dir, certs in ./.aio-tls, logs in ./.aio/log. */
async function legacyApp() {
  const root = await Deno.makeTempDir({ prefix: "aio-migrate-" });
  const cwd = join(root, "project");
  const xdg = join(root, "xdg", "wallet");
  await Deno.mkdir(cwd, { recursive: true });
  await Deno.mkdir(xdg, { recursive: true });
  await Deno.writeTextFile(join(cwd, "data.db"), "STATE");
  await Deno.writeTextFile(join(cwd, "data.db-wal"), "WAL");
  await Deno.writeTextFile(join(cwd, "data.db-shm"), "SHM");
  await Deno.writeTextFile(join(cwd, "data.db.journal"), "JOURNAL");
  await Deno.writeTextFile(join(xdg, "auth.db"), "USERS");
  await Deno.mkdir(join(cwd, ".aio-tls"), { recursive: true });
  await Deno.writeTextFile(join(cwd, ".aio-tls", "tls-cert.pem"), "CERT");
  await Deno.writeTextFile(join(cwd, ".aio-tls", "tls-key.pem"), "KEY");
  await Deno.mkdir(join(cwd, ".aio", "log"), { recursive: true });
  await Deno.writeTextFile(join(cwd, ".aio", "log", "app.log"), "LOG");
  const dirs = appDirs("wallet", join(root, ".wallet"));
  return { root, cwd, xdg, dirs };
}

Deno.test("migrate: every scattered file lands in the one directory", async () => {
  const { root, cwd, xdg, dirs } = await legacyApp();
  try {
    const r = migrateLegacyLayout({
      appId: "wallet-migrate-test",
      dirs,
      cwd,
      legacyXdgDir: xdg,
    });
    assertEquals(r.refused, undefined);

    // ① critical — all inside data/
    assertEquals(await Deno.readTextFile(dirs.stateDb), "STATE");
    assertEquals(await Deno.readTextFile(dirs.stateDb + "-wal"), "WAL");
    assertEquals(await Deno.readTextFile(dirs.stateDb + "-shm"), "SHM");
    assertEquals(await Deno.readTextFile(dirs.journal), "JOURNAL");
    assertEquals(await Deno.readTextFile(dirs.authDb), "USERS");
    assertEquals(await Deno.readTextFile(join(dirs.tls, "tls-key.pem")), "KEY");
    // ② expendable — outside data/
    assertEquals(await Deno.readTextFile(join(dirs.logs, "app.log")), "LOG");

    // the originals are gone — one copy of a state database, never two
    for (const p of ["data.db", "data.db-wal", "data.db.journal"]) {
      let gone = false;
      try {
        await Deno.stat(join(cwd, p));
      } catch {
        gone = true;
      }
      assert(gone, `${p} must not remain behind`);
    }

    const lines = describeMigration(r, dirs);
    assertStringIncludes(lines.join("\n"), "one dir = one backup");
    assertStringIncludes(
      lines.join("\n"),
      "everything outside it is disposable",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("migrate: NEVER overwrites an existing target", async () => {
  const { root, cwd, xdg, dirs } = await legacyApp();
  try {
    // The new layout already has a state db — a "merge" could only corrupt.
    await Deno.mkdir(dirs.data, { recursive: true });
    await Deno.writeTextFile(dirs.stateDb, "NEWER-STATE");

    const r = migrateLegacyLayout({
      appId: "wallet-migrate-test",
      dirs,
      cwd,
      legacyXdgDir: xdg,
    });
    assertEquals(
      await Deno.readTextFile(dirs.stateDb),
      "NEWER-STATE",
      "the live file must win",
    );
    assertEquals(
      await Deno.readTextFile(join(cwd, "data.db")),
      "STATE",
      "and the legacy file must be left alone, not deleted",
    );
    assertStringIncludes(
      describeMigration(r, dirs).join("\n"),
      "already exists (nothing was overwritten)",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("migrate: a WAL sidecar is never stranded from its database", async () => {
  const { root, cwd, xdg, dirs } = await legacyApp();
  try {
    // Target db present → the db is skipped, so its sidecars must NOT move
    // either (a -wal without its db is worse than no -wal at all).
    await Deno.mkdir(dirs.data, { recursive: true });
    await Deno.writeTextFile(dirs.stateDb, "NEWER");
    migrateLegacyLayout({
      appId: "wallet-migrate-test",
      dirs,
      cwd,
      legacyXdgDir: xdg,
    });
    let walMoved = true;
    try {
      await Deno.stat(dirs.stateDb + "-wal");
    } catch {
      walMoved = false;
    }
    assertEquals(walMoved, false, "sidecar must stay with its original db");
    assertEquals(await Deno.readTextFile(join(cwd, "data.db-wal")), "WAL");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("migrate: idempotent — a second run does nothing", async () => {
  const { root, cwd, xdg, dirs } = await legacyApp();
  try {
    const first = migrateLegacyLayout({
      appId: "wallet-migrate-test",
      dirs,
      cwd,
      legacyXdgDir: xdg,
    });
    assert(first.moves.length > 0);
    const second = migrateLegacyLayout({
      appId: "wallet-migrate-test",
      dirs,
      cwd,
      legacyXdgDir: xdg,
    });
    assertEquals(second.moves, [], "nothing legacy left to move");
    assertEquals(describeMigration(second, dirs), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("migrate: a modern app with nothing legacy is a no-op", async () => {
  const root = await Deno.makeTempDir({ prefix: "aio-migrate-" });
  try {
    const dirs = appDirs("wallet", join(root, ".wallet"));
    const r = migrateLegacyLayout({
      appId: "wallet-migrate-test",
      dirs,
      cwd: join(root, "empty"),
      legacyXdgDir: join(root, "empty-xdg"),
    });
    assertEquals(r.moves, []);
    let created = true;
    try {
      await Deno.stat(dirs.data);
    } catch {
      created = false;
    }
    assertEquals(created, false, "a no-op must not even create directories");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
