// The one-time move into `~/.<appId>/` must not strand a database's WAL.
//
// `moveDatabase` renames `data.db` and THEN its `-wal`/`-shm`. A death between
// the two (SIGKILL, power cut) left the committed frames of a crash-left WAL
// behind in the old directory — and the next boot never looked again: the
// legacy `data.db` was gone, so "nothing legacy left", and `state.db` opened
// WITHOUT its WAL. Every write the legacy app had committed since its last
// checkpoint was gone (measured: the `aio_kv` table itself missing).
//
// The kill is announced: `Deno.renameSync` is hooked in the child so the rename
// of the `-wal` itself SIGKILLs the process, after a marker the test asserts.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { appDirs } from "../src/server/app-dirs.ts";
import {
  migrateLegacyLayout,
  movingRecordFor,
} from "../src/server/app-dirs-migrate.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const MIGRATE = new URL("../src/server/app-dirs-migrate.ts", import.meta.url)
  .href;
const DIRS = new URL("../src/server/app-dirs.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;
const APP_ID = "stranded-wal-probe";

// A legacy app that committed and then died: its writes are in the WAL only.
const LEGACY = `
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(Deno.env.get("CWD") + "/data.db");
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA wal_autocheckpoint = 0");
db.exec("CREATE TABLE aio_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
db.prepare("INSERT INTO aio_kv (k, v) VALUES (?, ?)").run("state", '{"box":{"n":42}}');
Deno.kill(Deno.pid, "SIGKILL");
`;

// The migration exactly as boot runs it, dying at the sidecar's rename.
const MOVE = `
import { migrateLegacyLayout } from "${MIGRATE}";
import { appDirs } from "${DIRS}";
const ROOT = Deno.env.get("ROOT");
const rename = Deno.renameSync;
Deno.renameSync = (from, to) => {
  if (String(from).endsWith("-wal")) {
    Deno.writeTextFileSync(ROOT + "/killed-at", String(from));
    Deno.kill(Deno.pid, "SIGKILL");
  }
  rename(from, to);
};
migrateLegacyLayout({
  appId: "${APP_ID}",
  dirs: appDirs("${APP_ID}", ROOT + "/home"),
  cwd: Deno.env.get("CWD"),
  legacyXdgDir: ROOT + "/xdg",
});
Deno.writeTextFileSync(ROOT + "/finished", "the kill never landed");
`;

async function child(root: string, file: string, cwd: string) {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, join(root, file)],
    env: { ROOT: root, CWD: cwd },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
}

Deno.test("migrate: a death between moving data.db and its -wal loses no committed write", async () => {
  const root = await tempDir("aio-stranded-wal-");
  try {
    const cwd = join(root, "project");
    await Deno.mkdir(cwd, { recursive: true });
    await Deno.mkdir(join(root, "xdg"), { recursive: true });
    await Deno.writeTextFile(join(root, "legacy.ts"), LEGACY);
    await Deno.writeTextFile(join(root, "move.ts"), MOVE);

    await child(root, "legacy.ts", cwd);
    const wal = await Deno.stat(join(cwd, "data.db-wal"));
    assert(wal.size > 0, "the legacy app's writes sit in its WAL");

    const moveLog = await child(root, "move.ts", cwd);
    await Deno.readTextFile(join(root, "killed-at")).catch(() => {
      throw new Error(`the kill never landed:\n${moveLog}`);
    });

    // The next boot: migrate again, then open the database it hands over.
    const dirs = appDirs(APP_ID, join(root, "home"));
    migrateLegacyLayout({
      appId: APP_ID,
      dirs,
      cwd,
      legacyXdgDir: join(root, "xdg"),
    });
    const db = new DatabaseSync(dirs.stateDb);
    let rows: unknown[];
    try {
      rows = db.prepare("SELECT v FROM aio_kv WHERE k = 'state'").all();
    } catch (e) {
      rows = [String(e)];
    } finally {
      db.close();
    }
    assertEquals(
      rows,
      [{ v: '{"box":{"n":42}}' }],
      "the WAL's committed frames must travel with the database",
    );
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("migrate: a stranded WAL is NOT applied to a database written since — it is kept and reported", async () => {
  const root = await tempDir("aio-stranded-wal-newer-");
  try {
    const cwd = join(root, "project");
    await Deno.mkdir(cwd, { recursive: true });
    const dirs = appDirs(APP_ID, join(root, "home"));
    await Deno.mkdir(dirs.data, { recursive: true });
    await Deno.writeTextFile(dirs.stateDb, "MOVED, THEN WRITTEN AGAIN");
    // The record this build writes before the first rename of a move.
    await Deno.writeTextFile(
      movingRecordFor(dirs.stateDb),
      JSON.stringify({ from: join(cwd, "data.db") }),
    );
    await Deno.writeTextFile(join(cwd, "data.db-wal"), "OLD WAL");
    const t = new Date("2026-01-01T00:00:00Z");
    await Deno.utime(join(cwd, "data.db-wal"), t, t);

    const r = migrateLegacyLayout({
      appId: APP_ID,
      dirs,
      cwd,
      legacyXdgDir: join(root, "xdg"),
    });
    const failed = r.moves.filter((m) => m.outcome === "failed");
    assertEquals(failed.length, 1, JSON.stringify(r.moves));
    assert(failed[0]!.error?.includes("NOT applied"), failed[0]!.error);
    assertEquals(
      await Deno.readTextFile(join(cwd, "data.db-wal")),
      "OLD WAL",
      "kept where it was",
    );
    const applied = await Deno.stat(dirs.stateDb + "-wal").then(
      () => true,
      () => false,
    );
    assertEquals(applied, false, "never put beside a database it may not fit");
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("migrate: a stranded WAL is NOT put beside a database that has a WAL of its own", async () => {
  const root = await tempDir("aio-stranded-wal-own-");
  try {
    const cwd = join(root, "project");
    await Deno.mkdir(cwd, { recursive: true });
    const dirs = appDirs(APP_ID, join(root, "home"));
    await Deno.mkdir(dirs.data, { recursive: true });
    // The moved database is OLDER than the stranded WAL — the mtime alone
    // would let it through — but it has been opened since: its own WAL.
    await Deno.writeTextFile(dirs.stateDb, "MOVED");
    // The record this build writes before the first rename of a move.
    await Deno.writeTextFile(
      movingRecordFor(dirs.stateDb),
      JSON.stringify({ from: join(cwd, "data.db") }),
    );
    await Deno.writeTextFile(dirs.stateDb + "-wal", "ITS OWN WAL");
    const t = new Date("2026-01-01T00:00:00Z");
    await Deno.utime(dirs.stateDb, t, t);
    await Deno.writeTextFile(join(cwd, "data.db-wal"), "STRANDED WAL");

    const r = migrateLegacyLayout({
      appId: APP_ID,
      dirs,
      cwd,
      legacyXdgDir: join(root, "xdg"),
    });
    const failed = r.moves.filter((m) => m.outcome === "failed");
    assertEquals(failed.length, 1, JSON.stringify(r.moves));
    assertEquals(await Deno.readTextFile(dirs.stateDb + "-wal"), "ITS OWN WAL");
    assertEquals(
      await Deno.readTextFile(join(cwd, "data.db-wal")),
      "STRANDED WAL",
    );
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("migrate: the legacy auth.db's stranded WAL is finished the same way", async () => {
  const root = await tempDir("aio-stranded-wal-auth-");
  try {
    const cwd = join(root, "project");
    const xdg = join(root, "xdg");
    await Deno.mkdir(cwd, { recursive: true });
    await Deno.mkdir(xdg, { recursive: true });
    const dirs = appDirs(APP_ID, join(root, "home"));
    await Deno.mkdir(dirs.data, { recursive: true });
    await Deno.writeTextFile(dirs.authDb, "MOVED AUTH");
    // The record this build writes before the first rename of a move.
    await Deno.writeTextFile(
      movingRecordFor(dirs.authDb),
      JSON.stringify({ from: join(xdg, "auth.db") }),
    );
    const t = new Date("2026-01-01T00:00:00Z");
    await Deno.utime(dirs.authDb, t, t);
    await Deno.writeTextFile(join(xdg, "auth.db-wal"), "AUTH WAL");

    const r = migrateLegacyLayout({
      appId: APP_ID,
      dirs,
      cwd,
      legacyXdgDir: xdg,
    });
    assertEquals(
      r.moves.map((m) => m.outcome),
      ["moved"],
      JSON.stringify(r.moves),
    );
    assertEquals(await Deno.readTextFile(dirs.authDb + "-wal"), "AUTH WAL");
  } finally {
    await dropTempDir(root);
  }
});
