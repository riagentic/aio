// Profile integrity — the strongest remaining ask from a field report, and the
// ~150 lines every app storing user data eventually writes by hand.
//
// A corrupt SQLite file is the worst kind of failure: the app boots, the file
// is unreadable in places, and it either crashes on a query nobody expected to
// fail or quietly serves half the data. The recovery has to be conservative —
// a step that loses data is worse than the corruption it answers — so these
// tests pin what happens to the USER'S BYTES in each branch.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createDB } from "../src/server-entry.ts";
import {
  checkAndRecover,
  QUARANTINE_KEEP,
  quarantinePathFor,
  snapshotPathFor,
} from "../src/server/db-integrity.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

function logs() {
  const out: string[] = [];
  return {
    out,
    log: {
      info: (m: string) => out.push(m),
      warn: (m: string) => out.push(m),
      error: (m: string) => out.push(m),
    },
  };
}

async function seeded(dir: string) {
  const path = `${dir}/state.db`;
  const db = createDB(path);
  await db.execute("CREATE TABLE t (v TEXT NOT NULL)");
  await db.execute("INSERT INTO t (v) VALUES (?)", ["important"]);
  return { db, path };
}

Deno.test("db.snapshot(): a live database copies out consistently", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-integrity-" });
  try {
    const { db, path } = await seeded(dir);
    const snap = snapshotPathFor(path);
    await db.snapshot!(snap);
    // The copy is a real database holding the same rows…
    const copy = createDB(snap);
    const { rows } = await copy.query<{ v: string }>("SELECT v FROM t");
    assertEquals(rows.map((r) => r.v), ["important"]);
    // …and writes after the snapshot do not appear in it.
    await db.execute("INSERT INTO t (v) VALUES (?)", ["later"]);
    const { rows: again } = await copy.query<{ v: string }>("SELECT v FROM t");
    assertEquals(again.length, 1, "a snapshot is a point in time");
    await copy.close();
    await db.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("integrity: a sound database boots silently", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-integrity-" });
  try {
    const { db, path } = await seeded(dir);
    const l = logs();
    const outcome = await checkAndRecover({ db, dbPath: path, log: l.log });
    assertEquals(outcome.action, "none");
    assertEquals(l.out, [], "the common case says nothing at all");
    await db.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("integrity: a damaged file is QUARANTINED and restored from a snapshot", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-integrity-" });
  try {
    const { db, path } = await seeded(dir);
    await db.snapshot!(snapshotPathFor(path));
    await db.execute("INSERT INTO t (v) VALUES (?)", ["after-snapshot"]);
    await db.close();

    // Corrupt the middle of the file — past the header, so it opens and only
    // quick_check notices. This is what a bad sector or a torn write looks like.
    const bytes = await Deno.readFile(path);
    bytes.fill(0x5a, 4096, Math.min(8192, bytes.length));
    await Deno.writeFile(path, bytes);

    const db2 = createDB(path);
    const l = logs();
    const outcome = await checkAndRecover({
      db: db2,
      dbPath: path,
      log: l.log,
    });

    assertEquals(outcome.action, "restored");
    assert(outcome.quarantinedTo, "the damaged file is kept");
    assertEquals(
      (await Deno.stat(outcome.quarantinedTo!)).isFile,
      true,
      "nothing is ever deleted — a human can still run a recovery tool on it",
    );
    // The restored database is usable and holds the snapshot's contents.
    const db3 = createDB(path);
    const { rows } = await db3.query<{ v: string }>("SELECT v FROM t");
    assertEquals(rows.map((r) => r.v), ["important"]);
    await db3.close();
    // …and the loss is stated, not glossed over.
    const said = l.out.join("\n");
    assertStringIncludes(said, "INTEGRITY CHECK FAILED");
    assertStringIncludes(said, "not in it");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("integrity: with no snapshot it starts empty — and says so", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-integrity-" });
  try {
    const { db, path } = await seeded(dir);
    await db.close();
    const bytes = await Deno.readFile(path);
    bytes.fill(0x5a, 4096, Math.min(8192, bytes.length));
    await Deno.writeFile(path, bytes);

    const db2 = createDB(path);
    const l = logs();
    const outcome = await checkAndRecover({
      db: db2,
      dbPath: path,
      log: l.log,
    });

    assertEquals(outcome.action, "quarantined");
    assert(outcome.quarantinedTo);
    const said = l.out.join("\n");
    assertStringIncludes(said, "starting EMPTY");
    assertStringIncludes(said, "db.snapshot(path)"); // tells you how to prepare
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("integrity: a DB without the check is a no-op, not a crash", async () => {
  const l = logs();
  const outcome = await checkAndRecover({
    // A custom/legacy DB implementation: the members are optional.
    db: { close: () => Promise.resolve() } as never,
    dbPath: "/nonexistent/state.db",
    log: l.log,
  });
  assertEquals(outcome.action, "unavailable");
});

Deno.test("integrity: quarantine paths never collide", () => {
  const a = quarantinePathFor("/x/state.db", new Date("2026-01-01T00:00:00Z"));
  const b = quarantinePathFor("/x/state.db", new Date("2026-01-01T00:00:01Z"));
  assert(a !== b, "a second casualty must not overwrite the first");
  assert(!a.includes(":"), "colons are illegal in Windows filenames");
});

// The boot wiring, end to end: a real app whose database went bad between runs.
Deno.test("boot: checkIntegrityOnBoot recovers a corrupt app database", async () => {
  const { aio, cell, pk, table, text } = await import("../mod.ts");
  const { freePort } = await import("../src/testing/server-test.ts");
  const dir = await Deno.makeTempDir({ prefix: "aio-integrity-boot-" });
  const appId = `integ-${crypto.randomUUID().slice(0, 8)}`;
  const boot = () =>
    aio.run({
      cells: [cell("notes", { state: { n: 0 }, methods: {} })],
      appId,
      client: "server-only",
      libraryMode: true,
      singleton: false,
      port: freePort(),
      appDir: dir,
      checkIntegrityOnBoot: true,
      db: { rows: table({ id: pk(), v: text() }) },
    });

  try {
    // Run once so the app database exists and holds a row worth keeping.
    const app1 = await boot();
    const db1 = app1.db!;
    await db1.execute("INSERT INTO rows (id, v) VALUES (?, ?)", [1, "keep"]);
    const dbPath = `${dir}/data/state.db`;
    await db1.snapshot!(snapshotPathFor(dbPath));
    await app1.close();

    // …then the file goes bad while the app is down.
    const bytes = await Deno.readFile(dbPath);
    bytes.fill(0x5a, 4096, Math.min(12288, bytes.length));
    await Deno.writeFile(dbPath, bytes);

    // Boot must survive it and come up on the snapshot.
    const app2 = await boot();
    const { rows } = await app2.db!.query<{ v: string }>(
      "SELECT v FROM rows WHERE id = ?",
      [1],
    );
    assertEquals(rows[0]?.v, "keep", "the app boots on the recovered data");
    await app2.close();

    // The damaged original is still on disk for a human to inspect.
    const kept = [...Deno.readDirSync(`${dir}/data`)]
      .filter((e) => e.name.includes("corrupt-"));
    assertEquals(
      kept.length,
      1,
      "the damaged file is quarantined, not deleted",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// ── the quarantine keeps the copies it says it keeps ─────────────────────────
//
// This module's header promises the corrupt file is "QUARANTINED, never
// deleted … so a human (or a real recovery tool) still has every byte", and
// the prune's own log line names the number it keeps.
//
// It counted FILES. `moveSidecars` deliberately parks the crash-left
// `-wal`/`-shm` beside each quarantined database, and all three share the
// prefix the scan matched — so one copy counted as up to three, and keeping
// "the newest three" kept the newest COPY plus its two sidecars. Measured over
// four successive corruptions: exactly one database copy survived, while the
// log said three generations were kept. The ones it deleted were the older
// ones — which, after a corruption, are the ones a recovery tool wants.
Deno.test("db integrity: pruning keeps QUARANTINE_KEEP COPIES, sidecars and all", async () => {
  const dir = await tempDir("aio-quarantine-keep");
  try {
    const dbPath = `${dir}/state.db`;
    const enc = new TextEncoder();
    for (let i = 0; i < 5; i++) {
      // A corrupt database, with the crash-left sidecars a real one has.
      await Deno.writeTextFile(dbPath, `corrupt-${i}${"-".repeat(200)}`);
      await Deno.writeFile(`${dbPath}-wal`, enc.encode(`wal-${i}`));
      await Deno.writeFile(`${dbPath}-shm`, enc.encode(`shm-${i}`));
      const { log } = logs();
      const db = createDB(dbPath);
      await checkAndRecover({
        db,
        dbPath,
        log,
        now: new Date(Date.UTC(2026, 0, 1 + i)),
      });
      await db.close().catch(() => {});
    }

    const names: string[] = [];
    for await (const e of Deno.readDir(dir)) {
      if (e.isFile && e.name.startsWith("state.db.corrupt-")) {
        names.push(e.name);
      }
    }
    // A COPY is the bare `.corrupt-<ts>` name; `-wal`/`-shm` belong to it.
    const copies = names.filter((n) => !/-(?:wal|shm)$/.test(n)).sort();
    assertEquals(
      copies.length,
      QUARANTINE_KEEP,
      `the prune says it keeps ${QUARANTINE_KEEP} copies; it kept ` +
        `${copies.length}: ${JSON.stringify(names.sort())}`,
    );
    // …and the ones kept are the NEWEST, not whichever the sort happened to
    // leave behind.
    assertEquals(
      copies,
      [
        "state.db.corrupt-2026-01-03T00-00-00-000Z",
        "state.db.corrupt-2026-01-04T00-00-00-000Z",
        "state.db.corrupt-2026-01-05T00-00-00-000Z",
      ],
    );
    // A deleted copy takes its sidecars with it — a `-wal` with no database
    // beside it is a file nothing can ever read.
    const orphans = names.filter((n) =>
      /-(?:wal|shm)$/.test(n) &&
      !copies.includes(n.replace(/-(?:wal|shm)$/, ""))
    );
    assertEquals(orphans, [], "a sidecar outlived the copy it belongs to");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
