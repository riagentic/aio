// `<db>.restoring` is installed over the live path WITHOUT another check — so
// it must only ever exist as a COMPLETE, DURABLE copy of the verified snapshot.
//
// `checkAndRecover` used to `copyFile` the snapshot straight to that name. A
// death mid-copy left a TRUNCATED `.restoring`; with the damaged database gone
// from the live path (moved aside by hand — the thing an operator does after
// "INTEGRITY CHECK FAILED"), `finishInterruptedRestore` installed the torn
// half as "the verified copy". And nothing was fsynced before the quarantine
// rename: after a power cut the renames can be on disk while the copy's data
// blocks are not, leaving a ZERO-LENGTH live file — which SQLite opens as an
// empty database that passes every check: the empty-app-beside-a-snapshot
// outcome the staging exists to prevent.
//
// The kill is announced by the injected copy itself (half the bytes written,
// then SIGKILL) and asserted through a marker.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import type { DB } from "../src/db/types.ts";
import {
  checkAndRecover,
  finishInterruptedRestore,
  restoringPathFor,
  snapshotPathFor,
} from "../src/server/db-integrity.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const INTEGRITY = new URL("../src/server/db-integrity.ts", import.meta.url)
  .href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

const quiet = { info() {}, warn() {}, error() {} };
const damaged = () =>
  ({
    checkIntegrity: () =>
      Promise.resolve({ ok: false, problems: ["page 3: torn"] }),
    close: () => Promise.resolve(),
  }) as unknown as DB;
const exists = (p: string) => Deno.lstat(p).then(() => true, () => false);

async function seed(dir: string) {
  const dbPath = join(dir, "state.db");
  await Deno.writeTextFile(dbPath, "DAMAGED");
  const snap = new DatabaseSync(snapshotPathFor(dbPath));
  snap.exec("CREATE TABLE t (v TEXT)");
  snap.prepare("INSERT INTO t VALUES (?)").run("x".repeat(64 * 1024));
  snap.close();
  return dbPath;
}

// The recovery as boot runs it, dying HALFWAY through the snapshot copy.
const CRASH = `
import { checkAndRecover } from "${INTEGRITY}";
const dbPath = Deno.env.get("DB");
await checkAndRecover({
  db: { checkIntegrity: async () => ({ ok: false, problems: ["torn"] }),
        close: async () => {} },
  dbPath,
  log: { info() {}, warn() {}, error() {} },
  checkSnapshot: async () => null,
  fs: {
    rename: (a, b) => Deno.rename(a, b),
    stat: async (p) => ({ size: (await Deno.stat(p)).size }),
    remove: (p) => Deno.remove(p),
    copyFile: async (from, to) => {
      const bytes = await Deno.readFile(from);
      await Deno.writeFile(to, bytes.subarray(0, bytes.length >> 1));
      Deno.writeTextFileSync(dbPath + ".killed", to);
      Deno.kill(Deno.pid, "SIGKILL");
    },
  },
});
Deno.writeTextFileSync(dbPath + ".finished", "the kill never landed");
`;

Deno.test("integrity restore: a death mid-copy never leaves a torn .restoring to be installed", async () => {
  const dir = await tempDir("aio-restore-staging-");
  try {
    const dbPath = await seed(dir);
    await Deno.writeTextFile(join(dir, "crash.ts"), CRASH);
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--config", CONFIG, join(dir, "crash.ts")],
      env: { DB: dbPath },
      stdout: "piped",
      stderr: "piped",
    }).output();
    await Deno.readTextFile(dbPath + ".killed").catch(() => {
      throw new Error(
        `the kill never landed:\n${new TextDecoder().decode(out.stderr)}`,
      );
    });

    // The operator moves the damaged file aside by hand, and boots again.
    await Deno.rename(dbPath, dbPath + ".by-hand");
    await finishInterruptedRestore({ dbPath, log: quiet });

    const snapshot = await Deno.readFile(snapshotPathFor(dbPath));
    for (const p of [restoringPathFor(dbPath), dbPath]) {
      if (!(await exists(p))) continue;
      const bytes = await Deno.readFile(p);
      assertEquals(
        bytes.length,
        snapshot.length,
        `${p} is a TORN copy of the snapshot (${bytes.length} of ` +
          `${snapshot.length} bytes) — installed as if verified`,
      );
    }
    assertEquals(
      await exists(restoringPathFor(dbPath) + ".partial"),
      false,
      "the torn copy is dropped by the next boot, not left to accumulate",
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("integrity restore: the staged copy is durable BEFORE the damaged file moves", async () => {
  const dir = await tempDir("aio-restore-durable-");
  try {
    const dbPath = await seed(dir);
    const staged = restoringPathFor(dbPath);
    const ops: string[] = [];
    const rel = (p: string) => p.slice(dir.length + 1);
    const outcome = await checkAndRecover({
      db: damaged(),
      dbPath,
      log: quiet,
      checkSnapshot: () => Promise.resolve(null),
      fs: {
        rename: async (a, b) => {
          ops.push(`rename ${rel(a)} -> ${rel(b)}`);
          await Deno.rename(a, b);
        },
        copyFile: async (a, b) => {
          ops.push(`copy ${rel(a)} -> ${rel(b)}`);
          await Deno.copyFile(a, b);
        },
        stat: async (p) => ({ size: (await Deno.stat(p)).size }),
        remove: (p) => Deno.remove(p),
        sync: async (p) => {
          ops.push(`sync ${rel(p)}`);
          using f = await Deno.open(p, { read: true, write: true });
          await f.syncData();
        },
      },
    });
    assertEquals(outcome.action, "restored", ops.join("\n"));
    const quarantine = ops.findIndex((o) => o.startsWith("rename state.db ->"));
    const install = ops.indexOf(`rename ${rel(staged)} -> state.db`);
    assert(quarantine >= 0 && install > quarantine, ops.join("\n"));
    // The bytes that become the live database are on disk before anything is
    // moved — under whatever name they were written.
    const synced = ops.findIndex((o) => o.startsWith("sync "));
    assert(
      synced >= 0 && synced < quarantine,
      `no fsync of the staged copy before the quarantine:\n${ops.join("\n")}`,
    );
    assertEquals(
      await Deno.readFile(dbPath),
      await Deno.readFile(snapshotPathFor(dbPath)),
    );
    assertEquals(await exists(staged), false);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("finishInterruptedRestore: a staged copy beside a live database is dropped, the database untouched", async () => {
  const dir = await tempDir("aio-restore-both-");
  try {
    const dbPath = join(dir, "state.db");
    await Deno.writeTextFile(dbPath, "LIVE");
    await Deno.writeTextFile(restoringPathFor(dbPath), "STAGED");
    const warns: string[] = [];
    const r = await finishInterruptedRestore({
      dbPath,
      log: { warn: (m) => warns.push(m), error: (m) => warns.push(m) },
    });
    assertEquals(r, null);
    assertEquals(await Deno.readTextFile(dbPath), "LIVE");
    assertEquals(await exists(restoringPathFor(dbPath)), false);
    assert(warns.some((w) => w.includes(restoringPathFor(dbPath))), `${warns}`);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("finishInterruptedRestore: a staged copy with no database is installed, stale sidecars removed first", async () => {
  const dir = await tempDir("aio-restore-install-");
  try {
    const dbPath = join(dir, "state.db");
    await Deno.writeTextFile(restoringPathFor(dbPath), "STAGED");
    await Deno.writeTextFile(dbPath + "-wal", "OLD WAL");
    const errors: string[] = [];
    const r = await finishInterruptedRestore({
      dbPath,
      log: { warn: (m) => errors.push(m), error: (m) => errors.push(m) },
    });
    assertEquals(r?.action, "restored");
    assertEquals(await Deno.readTextFile(dbPath), "STAGED");
    assertEquals(await exists(dbPath + "-wal"), false);
    assertEquals(await exists(restoringPathFor(dbPath)), false);
    assert(errors.some((e) => e.includes("FINISHED")), `${errors}`);
    // Nothing staged: a plain boot is not touched and says nothing.
    const quietBoot: string[] = [];
    assertEquals(
      await finishInterruptedRestore({
        dbPath,
        log: {
          warn: (m) => quietBoot.push(m),
          error: (m) => quietBoot.push(m),
        },
      }),
      null,
    );
    assertEquals(quietBoot, []);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("checkAndRecover: an install that fails refuses the boot and keeps the staged copy; a failed quarantine drops it", async () => {
  const dir = await tempDir("aio-restore-refuse-");
  try {
    const dbPath = await seed(dir);
    const staged = restoringPathFor(dbPath);
    const fs = (failTo: (to: string) => boolean) => ({
      rename: async (a: string, b: string) => {
        if (failTo(b)) throw new Error("EIO (injected)");
        await Deno.rename(a, b);
      },
      copyFile: (a: string, b: string) => Deno.copyFile(a, b),
      stat: async (p: string) => ({ size: (await Deno.stat(p)).size }),
      remove: (p: string) => Deno.remove(p),
    });
    const err = await assertRejects(() =>
      checkAndRecover({
        db: damaged(),
        dbPath,
        log: quiet,
        checkSnapshot: () => Promise.resolve(null),
        fs: fs((to) => to === dbPath),
      })
    );
    assert(String(err).includes(staged), String(err));
    assertEquals(await exists(dbPath), false);
    assertEquals(
      await Deno.readFile(staged),
      await Deno.readFile(snapshotPathFor(dbPath)),
      "the verified copy waits for the next boot",
    );
    // …which installs it.
    assertEquals(
      (await finishInterruptedRestore({ dbPath, log: quiet }))?.action,
      "restored",
    );

    // Quarantine itself fails: nothing moved, nothing staged is left behind.
    const r = await checkAndRecover({
      db: damaged(),
      dbPath,
      log: quiet,
      checkSnapshot: () => Promise.resolve(null),
      fs: fs((to) =>
        to.includes(".corrupt-") && !to.endsWith("-wal") &&
        !to.endsWith("-shm")
      ),
    });
    assertEquals(r.action, "unavailable");
    assert(await exists(dbPath));
    assertEquals(await exists(staged), false);
  } finally {
    await dropTempDir(dir);
  }
});
