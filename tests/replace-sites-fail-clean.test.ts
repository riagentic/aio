// When the rename at the end of "write a temp, rename it over" fails, each
// site that does it must: say so (throw or log), leave NO temp file behind,
// and leave the file it meant to replace exactly as it was. And a site that
// MOVES data (the legacy database, a damaged one) must still have its source.
//
// One failing rename, injected at the shared helper's seam, per site.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { _renameDeps } from "../src/diagnostics/rename-over.ts";
import { setLogger } from "../src/diagnostics/logger-api.ts";
import type { LogSink } from "../src/diagnostics/logger-types.ts";
import { createCheckpoint } from "../src/diagnostics/checkpoint.ts";
import { createActionLog } from "../src/diagnostics/action-log.ts";
import { createDB } from "../src/db/async-db.ts";
import { _resetBlobStores, openBlobStore } from "../src/server/blobs.ts";
import { appDirs } from "../src/server/app-dirs.ts";
import { migrateLegacyLayout } from "../src/server/app-dirs-migrate.ts";
import {
  finishInterruptedRestore,
  restoringPathFor,
} from "../src/server/db-integrity.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const FULL = () => new Error("No space left on device (os error 28): rename");

/** Run `fn` with every rename refused; returns the log lines said. */
async function refused<T>(
  fn: () => T | Promise<T>,
): Promise<{ out: T; said: string[]; renames: number }> {
  const real = { ..._renameDeps };
  const said: string[] = [];
  let renames = 0;
  _renameDeps.rename = () => {
    renames++;
    throw FULL();
  };
  _renameDeps.renameAsync = () => {
    renames++;
    return Promise.reject(FULL());
  };
  setLogger({
    pub: (lvl: string, cat: string, msg: string) =>
      void said.push(`${lvl} ${cat} ${msg}`),
  } as unknown as LogSink);
  try {
    return { out: await fn(), said, renames };
  } finally {
    Object.assign(_renameDeps, real);
    setLogger(null);
  }
}

function* walk(dir: string): Generator<string> {
  for (const e of Deno.readDirSync(dir)) {
    const p = join(dir, e.name);
    if (e.isDirectory) yield* walk(p);
    else yield p;
  }
}
/** Every file under `dir` that looks like a temp of one of these writers. */
const temps = (dir: string) =>
  [...walk(dir)].filter((p) => /\.tmp\b|\.partial$|\.fusing$/.test(p));

Deno.test("checkpoint: a failed replace is reported, leaves no temp, keeps the last checkpoint", async () => {
  const dir = await tempDir("site-checkpoint-");
  try {
    const data = (n: number) => ({
      ts: n,
      state: { n },
      recentActions: [],
      cells: {},
    });
    const cp = createCheckpoint(dir, 0);
    await cp.write(data(1));
    const before = Deno.readTextFileSync(join(dir, "checkpoint.json"));

    const a = await refused(() => assertRejects(() => cp.write(data(2))));
    assert(String(a.out).includes("os error 28"), String(a.out));
    assertEquals(a.renames, 1);
    const s = await refused(() => cp.rewriteNow(data(3)));
    assertEquals(s.renames, 1);
    assertEquals(
      s.said.filter((l) => l.startsWith("error ") && l.includes("os error 28"))
        .length,
      1,
      s.said.join("\n"),
    );
    assertEquals(temps(dir), []);
    assertEquals(Deno.readTextFileSync(join(dir, "checkpoint.json")), before);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("action log scrub: a failed replace rejects, leaves no temp, keeps the log", async () => {
  const dir = await tempDir("site-actionlog-");
  try {
    const path = join(dir, "actions.jsonl");
    const alog = createActionLog(path, 100);
    await alog.append("vault:unlock", { passphrase: "hunter2" });
    await alog.flush();
    const before = Deno.readTextFileSync(path);
    assert(before.includes("hunter2"));
    const r = await refused(() =>
      assertRejects(() => alog.scrub(() => true, "[withheld]"))
    );
    assert(String(r.out).includes("os error 28"), String(r.out));
    assertEquals(r.renames, 1);
    assertEquals(temps(dir), []);
    assertEquals(Deno.readTextFileSync(path), before);
    // …and with the rename back, the same call lands.
    assertEquals(await alog.scrub(() => true, "[withheld]"), 1);
    assert(!Deno.readTextFileSync(path).includes("hunter2"));
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("db.snapshot: a failed install rejects, leaves no temp, keeps the previous snapshot", async () => {
  const dir = await tempDir("site-snapshot-");
  const db = createDB(join(dir, "a.db"));
  try {
    await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    await db.execute("INSERT INTO t (v) VALUES ('one')");
    const snap = join(dir, "a.db.snapshot");
    await db.snapshot!(snap);
    const before = Deno.readFileSync(snap);
    await db.execute("INSERT INTO t (v) VALUES ('two')");
    const r = await refused(() => assertRejects(() => db.snapshot!(snap)));
    assert(String(r.out).includes("os error 28"), String(r.out));
    assertEquals(r.renames, 1);
    assertEquals(
      [...walk(dir)].filter((p) => !/a\.db(-wal|-shm|\.snapshot)?$/.test(p)),
      [],
      "nothing but the database and its snapshot may be left",
    );
    assertEquals(Deno.readFileSync(snap), before);
  } finally {
    await db.close();
    await dropTempDir(dir);
  }
});

Deno.test("blobs.put: a failed rename rejects and leaves no temp", async () => {
  const dir = await tempDir("site-blobs-");
  try {
    _resetBlobStores();
    const store = openBlobStore("site-blobs", dir);
    const r = await refused(() =>
      assertRejects(() => store.put(new TextEncoder().encode("the bytes")))
    );
    assert(String(r.out).includes("os error 28"), String(r.out));
    assertEquals(r.renames, 1);
    assertEquals([...walk(dir)], [], "no temp, no half-named blob");
    // …and the same put lands once the rename works.
    const info = await store.put(new TextEncoder().encode("the bytes"));
    assertEquals([...walk(dir)].filter((p) => p.endsWith(info.id)).length, 1);
  } finally {
    _resetBlobStores();
    await dropTempDir(dir);
  }
});

Deno.test("legacy layout move: a database that cannot be renamed into place is reported, not lost, and leaves no partial copy", async () => {
  const dir = await tempDir("site-migrate-");
  try {
    const cwd = join(dir, "cwd"), home = join(dir, "home");
    Deno.mkdirSync(cwd);
    Deno.mkdirSync(join(dir, "xdg"));
    Deno.writeTextFileSync(join(cwd, "data.db"), "THE LEGACY DATABASE");
    const dirs = appDirs("site-migrate", home);
    const r = await refused(() =>
      migrateLegacyLayout({
        appId: "site-migrate",
        dirs,
        cwd,
        legacyXdgDir: join(dir, "xdg"),
      })
    );
    const failed = r.out.moves.filter((m) => m.outcome === "failed");
    assert(failed.length >= 1, JSON.stringify(r.out));
    assert(failed[0]!.error?.includes("os error 28"), JSON.stringify(failed));
    // The move (kept source) was tried, then the copy's install (a temp).
    assert(r.renames >= 2, `renames: ${r.renames}`);
    assertEquals(
      Deno.readTextFileSync(join(cwd, "data.db")),
      "THE LEGACY DATABASE",
      "the original must still be where it was",
    );
    assertEquals(temps(dir), []);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("interrupted restore: a staged copy that cannot be installed stays staged (the default file ops)", async () => {
  const dir = await tempDir("site-restore-");
  try {
    const dbPath = join(dir, "state.db");
    const staged = restoringPathFor(dbPath);
    Deno.writeTextFileSync(staged, "THE VERIFIED COPY");
    const log = { error: () => {}, warn: () => {} };
    const r = await refused(() =>
      assertRejects(() => finishInterruptedRestore({ dbPath, log }))
    );
    assert(String(r.out).includes("os error 28"), String(r.out));
    assertEquals(r.renames, 1);
    assertEquals(
      Deno.readTextFileSync(staged),
      "THE VERIFIED COPY",
      "the only verified copy must survive a failed install",
    );
    // …and the next boot installs it.
    assert(await finishInterruptedRestore({ dbPath, log }));
    assertEquals(Deno.readTextFileSync(dbPath), "THE VERIFIED COPY");
  } finally {
    await dropTempDir(dir);
  }
});
