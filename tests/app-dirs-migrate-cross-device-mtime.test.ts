// The legacy move across filesystems keeps the database's mtime.
//
// Where `rename` cannot cross devices, `moveFile` copies → verifies → unlinks.
// The copy got a NEW mtime — so when a death then stranded the `-wal` in the
// old directory, `finishDatabaseMove` saw a database "written since" the WAL
// and refused to carry it over, every time, with a misleading reason: the
// database had not been written, only copied. Every write in the WAL stayed
// behind, reported as FAILED. The copy now carries the source's times.
//
// The child is the migration as boot runs it, with `renameSync` refusing like
// a cross-device rename and the `-wal`'s copy SIGKILLing the process.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { appDirs } from "../src/server/app-dirs.ts";
import { migrateLegacyLayout } from "../src/server/app-dirs-migrate.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const MIGRATE = new URL("../src/server/app-dirs-migrate.ts", import.meta.url)
  .href;
const DIRS = new URL("../src/server/app-dirs.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;
const APP_ID = "cross-device-mtime-probe";

const LEGACY = `
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(Deno.env.get("CWD") + "/data.db");
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA wal_autocheckpoint = 0");
db.exec("CREATE TABLE aio_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
db.prepare("INSERT INTO aio_kv (k, v) VALUES (?, ?)").run("state", '{"box":{"n":42}}');
Deno.kill(Deno.pid, "SIGKILL");
`;

const MOVE = `
import { dirname } from "@std/path";
import { migrateLegacyLayout } from "${MIGRATE}";
import { appDirs } from "${DIRS}";
const ROOT = Deno.env.get("ROOT");
const rename = Deno.renameSync;
Deno.renameSync = (from, to) => {
  // A real EXDEV only ever crosses filesystems: within one directory it moves.
  if (dirname(String(from)) === dirname(String(to))) return rename(from, to);
  const e = new Error("Invalid cross-device link (os error 18)");
  e.code = "EXDEV";
  throw e;
};
const copy = Deno.copyFileSync;
Deno.copyFileSync = (from, to) => {
  if (String(from).endsWith("-wal")) {
    Deno.writeTextFileSync(ROOT + "/killed-at", String(from));
    Deno.kill(Deno.pid, "SIGKILL");
  }
  copy(from, to);
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

Deno.test("migrate: a cross-device copy keeps the database's mtime, so its stranded WAL is still carried over", async () => {
  const root = await tempDir("aio-migrate-xdev-");
  try {
    const cwd = join(root, "project");
    await Deno.mkdir(cwd, { recursive: true });
    await Deno.mkdir(join(root, "xdg"), { recursive: true });
    await Deno.writeTextFile(join(root, "legacy.ts"), LEGACY);
    await Deno.writeTextFile(join(root, "move.ts"), MOVE);
    await child(root, "legacy.ts", cwd);
    // The move happens later than the legacy app's last write.
    await new Promise((r) => setTimeout(r, 50));
    const moveLog = await child(root, "move.ts", cwd);
    await Deno.readTextFile(join(root, "killed-at")).catch(() => {
      throw new Error(`the kill never landed:\n${moveLog}`);
    });

    const dirs = appDirs(APP_ID, join(root, "home"));
    const r = migrateLegacyLayout({
      appId: APP_ID,
      dirs,
      cwd,
      legacyXdgDir: join(root, "xdg"),
    });
    assertEquals(
      r.moves.filter((m) => m.outcome === "failed"),
      [],
      "the copied database was not written since — only copied",
    );
    const db = new DatabaseSync(dirs.stateDb);
    let rows: unknown[];
    try {
      rows = db.prepare("SELECT v FROM aio_kv WHERE k = 'state'").all();
    } catch (e) {
      rows = [String(e)];
    } finally {
      db.close();
    }
    assertEquals(rows, [{ v: '{"box":{"n":42}}' }]);
  } finally {
    await dropTempDir(root);
  }
});
