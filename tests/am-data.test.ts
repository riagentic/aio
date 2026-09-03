// `am data` / `am backup` / `am restore` — the three commands that only make
// sense because an app's durable state is ONE directory
// (docs/specs/2026-07-26-data-dir-and-updates.md).
//
// The interesting behaviour is the refusals, not the copy: a backup taken from
// under a running writer, and a restore of another app's archive over live data,
// are the two ways a "safe" command destroys data. Both are tested here, plus
// the fact that a restore keeps the data it replaced.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { lockPath } from "../src/server/single-instance-lock.ts";
import {
  cmdBackup,
  cmdData,
  cmdRestore,
  defaultBackupDest,
  renderData,
} from "../src/am/am-cmd-data.ts";
import {
  _resetAppDirs,
  appDirs,
  ensureAppDirs,
} from "../src/server/app-dirs.ts";
import { writeAppMeta } from "../src/server/app-dirs.ts";

/** Run a command with stdout captured and Deno.exit neutralised — these are CLI
 *  entry points, so "it exited 1 with this message" IS the behaviour. */
function run(
  fn: (args: string[], flags: Record<string, unknown>) => void,
  args: string[],
  flags: Record<string, unknown>,
): { out: string; exited: number | null } {
  const chunks: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const origExit = Deno.exit;
  let exited: number | null = null;
  console.log = (...a: unknown[]) => chunks.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => chunks.push(a.map(String).join(" "));
  // deno-lint-ignore no-explicit-any
  (Deno as any).exit = (code = 0) => {
    exited = code;
    throw new Error("__exit__");
  };
  try {
    fn(args, flags);
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "__exit__") throw e;
  } finally {
    console.log = origLog;
    console.error = origError;
    // deno-lint-ignore no-explicit-any
    (Deno as any).exit = origExit;
  }
  return { out: chunks.join("\n"), exited };
}

// The test task pins AIO_APPS_DIR for the whole suite so no test can write into
// the real home. These tests need their OWN root, so they repoint it and then put
// it back EXACTLY as it was — an unconditional delete() unpins every test that
// runs afterwards, which shows up as a failure in an unrelated file.
const SUITE_HOME = Deno.env.get("AIO_APPS_DIR");

function pin(home: string): void {
  Deno.env.set("AIO_APPS_DIR", home);
  _resetAppDirs();
}

function unpin(): void {
  if (SUITE_HOME === undefined) Deno.env.delete("AIO_APPS_DIR");
  else Deno.env.set("AIO_APPS_DIR", SUITE_HOME);
  _resetAppDirs();
}

/** A populated data dir for `appId`, rooted in a temp home. */
function seedApp(appId: string, home: string): ReturnType<typeof appDirs> {
  const d = appDirs(appId, join(home, appId));
  ensureAppDirs(d);
  Deno.writeTextFileSync(d.stateDb, "STATE");
  Deno.writeTextFileSync(d.authDb, "AUTH");
  Deno.writeTextFileSync(d.appKey, "secret-key");
  Deno.mkdirSync(d.tls, { recursive: true });
  Deno.writeTextFileSync(join(d.tls, "tls-cert.pem"), "CERT");
  writeAppMeta(d, { appId, aio: "1.0.0-test" });
  return d;
}

Deno.test("am data: lists the three tiers and names the backup unit", async () => {
  const home = await Deno.makeTempDir({ prefix: "am-data-" });
  // AIO_APPS_DIR is how the command resolves the same root seedApp() used.
  pin(home);
  try {
    seedApp("dtest", home);
    // `am` emits JSON whenever stdout isn't a tty — which is every test run, so
    // the machine shape is what the command produces here…
    const { out, exited } = run(cmdData, [], { app: "dtest" });
    assertEquals(exited, null);
    const info = JSON.parse(out) as Parameters<typeof renderData>[0];
    assertEquals(info.appId, "dtest");
    assertEquals(info.running, false);
    assertEquals(info.data, join(home, "dtest", "data"));
    assertEquals(info.backup, info.data, "the backup unit IS data/");
    assert(info.sizes.data > 0, "data/ was seeded, so its size is non-zero");
    // …and the terminal rendering is a pure function of it.
    const pretty = renderData(info);
    assertStringIncludes(pretty, "dtest");
    assertStringIncludes(pretty, "data ①");
    assertStringIncludes(pretty, "logs ②");
    assertStringIncludes(pretty, "runtime ③");
    assertStringIncludes(pretty, "back this up");
  } finally {
    unpin();
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("am backup: copies every file, keeps modes, refuses to overwrite", async () => {
  const home = await Deno.makeTempDir({ prefix: "am-backup-" });
  pin(home);
  try {
    seedApp("btest", home);
    const dest = join(home, "archive");
    const first = run(cmdBackup, [dest], { app: "btest" });
    assertEquals(first.exited, null, first.out);
    assertEquals(Deno.readTextFileSync(join(dest, "state.db")), "STATE");
    assertEquals(Deno.readTextFileSync(join(dest, "auth.db")), "AUTH");
    // Nested dirs come along — the TLS material is inside data/tls/.
    assertEquals(
      Deno.readTextFileSync(join(dest, "tls", "tls-cert.pem")),
      "CERT",
    );
    assertEquals(
      JSON.parse(first.out).files,
      5,
      "state.db + auth.db + app.key + meta.json + tls/tls-cert.pem",
    );

    // Second run at the same destination must refuse rather than merge.
    const again = run(cmdBackup, [dest], { app: "btest" });
    assertEquals(again.exited, 1);
    assertStringIncludes(again.out, "already exists");
    assertEquals(Deno.readTextFileSync(join(dest, "state.db")), "STATE");
  } finally {
    unpin();
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("am restore: refuses another app's archive, keeps replaced data", async () => {
  const home = await Deno.makeTempDir({ prefix: "am-restore-" });
  pin(home);
  try {
    seedApp("rtest", home);
    const other = seedApp("other-app", home);

    // Wrong app: meta.json says "other-app", target is "rtest" → refuse.
    const wrong = run(cmdRestore, [other.data], { app: "rtest" });
    assertEquals(wrong.exited, 1);
    assertStringIncludes(wrong.out, "belongs to");
    assertStringIncludes(wrong.out, "other-app");
    // …and nothing was touched.
    assertEquals(
      Deno.readTextFileSync(appDirs("rtest", join(home, "rtest")).stateDb),
      "STATE",
    );

    // A real archive of the SAME app restores, and the replaced data is kept.
    const archive = join(home, "rtest-archive");
    const backup = run(cmdBackup, [archive], { app: "rtest" });
    assertEquals(backup.exited, null, backup.out);
    Deno.writeTextFileSync(join(archive, "state.db"), "RESTORED");

    const ok = run(cmdRestore, [archive], { app: "rtest" });
    assertEquals(ok.exited, null, ok.out);
    const d = appDirs("rtest", join(home, "rtest"));
    assertEquals(Deno.readTextFileSync(d.stateDb), "RESTORED");
    const aside = (JSON.parse(ok.out) as { replaced?: string }).replaced;
    assert(aside, "restore must report where the replaced data went");
    assertEquals(Deno.readTextFileSync(join(aside, "state.db")), "STATE");
  } finally {
    unpin();
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("am restore: needs an argument and a real directory", async () => {
  const home = await Deno.makeTempDir({ prefix: "am-restore-args-" });
  pin(home);
  try {
    const none = run(cmdRestore, [], { app: "xtest" });
    assertEquals(none.exited, 1);
    assertStringIncludes(none.out, "usage: am restore");

    const missing = run(cmdRestore, [join(home, "nope")], { app: "xtest" });
    assertEquals(missing.exited, 1);
    assertStringIncludes(missing.out, "no backup directory");
  } finally {
    unpin();
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("am backup: says so when the app never ran", async () => {
  const home = await Deno.makeTempDir({ prefix: "am-backup-empty-" });
  pin(home);
  try {
    const r = run(cmdBackup, [join(home, "out")], { app: "ghost" });
    assertEquals(r.exited, 1);
    assertStringIncludes(r.out, "ever run?");
  } finally {
    unpin();
    await Deno.remove(home, { recursive: true });
  }
});

// The refusals that exist to protect data, driven through a real lock file.
// A backup of a live SQLite database can capture a torn write, and a restore
// under a running app is overwritten by that app's in-memory pages — so these
// two paths are the whole reason the commands exist rather than `cp -r`.
Deno.test("am backup/restore: refuse while the app is running", async () => {
  const home = await Deno.makeTempDir({ prefix: "am-live-" });
  pin(home);
  const appId = "livetest";
  const lock = lockPath(appId);
  try {
    seedApp(appId, home);
    // Our own pid is, by construction, alive.
    Deno.writeTextFileSync(
      lock,
      JSON.stringify({ appId, pid: Deno.pid, port: 65123 }),
    );

    const blocked = run(cmdBackup, [join(home, "out")], { app: appId });
    assertEquals(blocked.exited, 1);
    assertStringIncludes(blocked.out, "is running");
    assertStringIncludes(blocked.out, "am stop");

    // --force is the documented escape hatch, and it must actually copy.
    const forced = run(cmdBackup, [join(home, "out"), "--force"], {
      app: appId,
    });
    assertEquals(forced.exited, null, forced.out);
    assertEquals(JSON.parse(forced.out).tornRisk, true);
    assertEquals(
      Deno.readTextFileSync(join(home, "out", "state.db")),
      "STATE",
    );

    // Restore has NO escape hatch — there is no safe way to do it live.
    const noRestore = run(cmdRestore, [join(home, "out"), "--force"], {
      app: appId,
    });
    assertEquals(noRestore.exited, 1);
    assertStringIncludes(noRestore.out, "is running");
  } finally {
    unpin();
    await Deno.remove(lock).catch(() => {});
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("am backup: refuses a destination inside data/ (the copy would recurse into its own output)", async () => {
  const home = await Deno.makeTempDir({ prefix: "am-backup-inside-" });
  pin(home);
  try {
    const d = seedApp("intest", home);
    const inside = run(cmdBackup, [join(d.data, "backups", "b1")], {
      app: "intest",
    });
    assertEquals(inside.exited, 1);
    assertStringIncludes(inside.out, "inside");
    // …and nothing was written into data/.
    let leaked = false;
    for (const e of Deno.readDirSync(d.data)) {
      if (e.name === "backups") leaked = true;
    }
    assertEquals(leaked, false, "no partial copy may land in data/");
  } finally {
    unpin();
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("am restore: refuses a source overlapping data/ (the move-aside would take the source with it)", async () => {
  const home = await Deno.makeTempDir({ prefix: "am-restore-overlap-" });
  pin(home);
  try {
    const d = seedApp("ovtest", home);
    // src INSIDE data/…
    const insideSrc = join(d.data, "old-copy");
    Deno.mkdirSync(insideSrc, { recursive: true });
    const a = run(cmdRestore, [insideSrc], { app: "ovtest" });
    assertEquals(a.exited, 1);
    assertStringIncludes(a.out, "overlaps");
    // …and data/'s PARENT as src (data/ inside src).
    const b = run(cmdRestore, [join(home, "ovtest")], { app: "ovtest" });
    assertEquals(b.exited, 1);
    assertStringIncludes(b.out, "overlaps");
    assertEquals(Deno.readTextFileSync(d.stateDb), "STATE", "untouched");
  } finally {
    unpin();
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("am restore: a corrupt meta.json refuses (the wrong-app check is blind), --force proceeds", async () => {
  const home = await Deno.makeTempDir({ prefix: "am-restore-corrupt-" });
  pin(home);
  try {
    seedApp("ctest", home);
    const archive = join(home, "ctest-archive");
    const backup = run(cmdBackup, [archive], { app: "ctest" });
    assertEquals(backup.exited, null, backup.out);
    // A live --force backup can tear meta.json mid-write — simulate the tear.
    Deno.writeTextFileSync(join(archive, "meta.json"), '{"appId": "ct');

    const blind = run(cmdRestore, [archive], { app: "ctest" });
    assertEquals(blind.exited, 1);
    assertStringIncludes(blind.out, "cannot be parsed");

    const forced = run(cmdRestore, [archive, "--force"], { app: "ctest" });
    assertEquals(forced.exited, null, forced.out);
  } finally {
    unpin();
    await Deno.remove(home, { recursive: true });
  }
});

// A directory that is not an archive at all passed every guard: a null meta is
// the legitimate "hand-made copy" case, so `am restore ~/Downloads` moved the
// live data aside, copied zero files, and reported
// `{"files":0,"replaced":"…/data.replaced-…"}` with exit 0 — the data dir left
// EMPTY, with only the .replaced-* copy between the user and total loss.
// `files: 0` is never a successful restore.
Deno.test("am restore: refuses a directory that is not a backup", async () => {
  const home = await Deno.makeTempDir({ prefix: "am-restore-notabackup-" });
  pin(home);
  try {
    const d = seedApp("ntest", home);
    const notAnArchive = join(home, "downloads");
    Deno.mkdirSync(notAnArchive, { recursive: true });
    Deno.writeTextFileSync(join(notAnArchive, "notes.txt"), "hello");

    const r = run(cmdRestore, [notAnArchive], { app: "ntest" });
    assertEquals(r.exited, 1, r.out);
    assertStringIncludes(r.out, "is not an aio backup");
    // The live data is where it was — nothing moved aside, nothing emptied.
    assertEquals(Deno.readTextFileSync(d.stateDb), "STATE");
    assertEquals(
      [...Deno.readDirSync(appDirs("ntest").home)].some((e) =>
        e.name.startsWith("data.replaced-")
      ),
      false,
      "a refused restore must not have moved anything",
    );
    // --force is for "the wrong archive", not for "no archive".
    const forced = run(cmdRestore, [notAnArchive, "--force"], { app: "ntest" });
    assertEquals(forced.exited, 1);
    assertEquals(Deno.readTextFileSync(d.stateDb), "STATE");

    // A hand-made copy with no meta.json but a real state.db IS restorable —
    // the guard must not turn into "only am's own archives".
    const handMade = join(home, "handmade");
    Deno.mkdirSync(handMade, { recursive: true });
    Deno.writeTextFileSync(join(handMade, "state.db"), "OLDER");
    const ok = run(cmdRestore, [handMade], { app: "ntest" });
    assertEquals(ok.exited, null, ok.out);
    assertEquals(Deno.readTextFileSync(d.stateDb), "OLDER");
  } finally {
    unpin();
    await Deno.remove(home, { recursive: true });
  }
});

// The default destination used to be `<cwd>/<app>-backup-<stamp>` — the cwd of
// `am backup` is the app's git checkout, so the default dropped a copy of
// auth.db, the app key and the TLS key into the working tree, uncovered by the
// scaffold's .gitignore, and `git status` showed it the moment it returned.
Deno.test("am backup: the default destination is not the user's checkout", async () => {
  const home = await Deno.makeTempDir({ prefix: "am-backup-default-" });
  const checkout = await Deno.makeTempDir({ prefix: "am-backup-cwd-" });
  const prevCwd = Deno.cwd();
  pin(home);
  try {
    seedApp("dfl", home);
    Deno.chdir(checkout);
    const r = run(cmdBackup, [], { app: "dfl" });
    assertEquals(r.exited, null, r.out);
    const dest = JSON.parse(r.out).dest as string;
    assertEquals(
      defaultBackupDest("dfl", "STAMP"),
      join(appDirs("dfl").home, "backups", "dfl-backup-STAMP"),
    );
    assert(
      dest.startsWith(join(appDirs("dfl").home, "backups")),
      `the default backup went to ${dest}`,
    );
    assertEquals(
      [...Deno.readDirSync(checkout)],
      [],
      "nothing may be written into the directory the command was typed in",
    );
    assertEquals(Deno.readTextFileSync(join(dest, "state.db")), "STATE");
  } finally {
    Deno.chdir(prevCwd);
    unpin();
    await Deno.remove(home, { recursive: true });
    await Deno.remove(checkout, { recursive: true });
  }
});
