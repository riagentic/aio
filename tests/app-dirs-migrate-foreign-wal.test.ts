// A stranded legacy WAL is carried over only to the database it came from.
//
// `finishDatabaseMove` exists for one case: a death between renaming
// `data.db` to `state.db` and renaming its `-wal`. It judged "is this the
// WAL's database" from mtimes alone — so a `data.db-wal` next to NO
// `data.db` was put beside ANY `state.db` older than it. The case that
// reaches it: the new layout was already live, so the legacy `data.db` was
// KEPT (never moved), and was later deleted by hand, its WAL left behind.
// That WAL belongs to a different database; SQLite replays it over
// `state.db` on the next open.
//
// Provenance is recorded now: the move writes `<state.db>.moving` naming the
// file it moves before the first rename, and a stranded WAL is finished only
// under that record. Without one it is reported and left where it is.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { appDirs } from "../src/server/app-dirs.ts";
import {
  migrateLegacyLayout,
  movingRecordFor,
} from "../src/server/app-dirs-migrate.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const APP_ID = "foreign-wal-probe";
const exists = (p: string) => Deno.lstat(p).then(() => true, () => false);

Deno.test("migrate: a WAL left by a KEPT legacy database deleted by hand is not put beside state.db", async () => {
  const root = await tempDir("aio-migrate-foreign-wal-");
  try {
    const cwd = join(root, "project");
    await Deno.mkdir(cwd, { recursive: true });
    const dirs = appDirs(APP_ID, join(root, "home"));
    await Deno.mkdir(dirs.data, { recursive: true });
    // The new layout is live; a legacy data.db sits beside the project.
    await Deno.writeTextFile(dirs.stateDb, "THE LIVE DATABASE");
    await Deno.writeTextFile(join(cwd, "data.db"), "LEGACY DATABASE");
    const first = migrateLegacyLayout({
      appId: APP_ID,
      dirs,
      cwd,
      legacyXdgDir: join(root, "xdg"),
    });
    assertEquals(
      first.moves.map((m) => m.outcome),
      ["skipped-exists"],
      "kept — nothing overwritten",
    );
    // …later: the legacy file is deleted by hand, its WAL is not, and it is
    // newer than the live database.
    await Deno.remove(join(cwd, "data.db"));
    await Deno.writeTextFile(join(cwd, "data.db-wal"), "FOREIGN WAL");
    const t = new Date("2026-01-01T00:00:00Z");
    await Deno.utime(dirs.stateDb, t, t);

    const r = migrateLegacyLayout({
      appId: APP_ID,
      dirs,
      cwd,
      legacyXdgDir: join(root, "xdg"),
    });
    assertEquals(
      await exists(dirs.stateDb + "-wal"),
      false,
      "a WAL of another database is never put beside state.db",
    );
    assertEquals(
      await Deno.readTextFile(join(cwd, "data.db-wal")),
      "FOREIGN WAL",
    );
    const failed = r.moves.filter((m) => m.outcome === "failed");
    assertEquals(failed.length, 1, JSON.stringify(r.moves));
    assert(failed[0]!.error?.includes("NOT applied"), failed[0]!.error);
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("migrate: a completed move leaves no record behind, and a record left by a death after the last rename is dropped", async () => {
  const root = await tempDir("aio-migrate-record-");
  try {
    const cwd = join(root, "project");
    await Deno.mkdir(cwd, { recursive: true });
    const dirs = appDirs(APP_ID, join(root, "home"));
    await Deno.writeTextFile(join(cwd, "data.db"), "DB");
    await Deno.writeTextFile(join(cwd, "data.db-wal"), "WAL");
    const r = migrateLegacyLayout({
      appId: APP_ID,
      dirs,
      cwd,
      legacyXdgDir: join(root, "xdg"),
    });
    assertEquals(r.moves.map((m) => m.outcome), ["moved", "moved"]);
    assertEquals(await Deno.readTextFile(dirs.stateDb + "-wal"), "WAL");
    assertEquals(await exists(movingRecordFor(dirs.stateDb)), false);

    // A death after the last rename, before the record went.
    await Deno.writeTextFile(
      movingRecordFor(dirs.stateDb),
      JSON.stringify({ from: join(cwd, "data.db") }),
    );
    migrateLegacyLayout({
      appId: APP_ID,
      dirs,
      cwd,
      legacyXdgDir: join(root, "xdg"),
    });
    assertEquals(await exists(movingRecordFor(dirs.stateDb)), false);
  } finally {
    await dropTempDir(root);
  }
});
