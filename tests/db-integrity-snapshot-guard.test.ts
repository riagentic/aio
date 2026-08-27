// Audit 2026-08-27 (MEDIUM): recovery trusted the snapshot without checking it,
// and quarantine copies were never pruned.
//
//  • the snapshot was restored unconditionally, so an app whose disk damaged
//    BOTH files booted on the second corrupt one — and quarantined that on the
//    next boot, leaving nothing to come back to.
//  • `.corrupt-<ts>` copies are full-size copies of the database. Nothing ever
//    removed them, and `am backup` archives every one.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createDB } from "../src/db/mod.ts";
import {
  checkAndRecover,
  QUARANTINE_KEEP,
  quarantinePathFor,
  snapshotPathFor,
} from "../src/server/db-integrity.ts";

function logs() {
  const out: string[] = [];
  const push = (m: string) => out.push(m);
  return { out, log: { info: push, warn: push, error: push } };
}

async function seeded(dir: string) {
  const path = join(dir, "state.db");
  const db = createDB(path);
  await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  await db.execute("INSERT INTO t (v) VALUES ('important')");
  return { db, path };
}

/** Scribble past the 100-byte header so the file still opens. */
async function damage(path: string) {
  const bytes = await Deno.readFile(path);
  bytes.fill(0x5a, 100, bytes.length);
  await Deno.writeFile(path, bytes);
}

Deno.test("integrity: a DAMAGED snapshot is not restored — and not deleted", async () => {
  const dir = await Deno.makeTempDir({ prefix: "integ-snap-bad-" });
  try {
    const { db, path } = await seeded(dir);
    const snap = snapshotPathFor(path);
    await db.snapshot!(snap);
    await db.close();

    await damage(path);
    await damage(snap); // the disk took both

    const db2 = createDB(path);
    const l = logs();
    const outcome = await checkAndRecover({
      db: db2,
      dbPath: path,
      log: l.log,
    });

    assertEquals(
      outcome.action,
      "quarantined",
      "booting on a second corrupt file is not a recovery",
    );
    const said = l.out.join("\n");
    assertStringIncludes(said, "is ALSO damaged");
    assertStringIncludes(said, "was NOT restored");
    // Both casualties are still on disk for a real recovery tool.
    assert((await Deno.stat(snap)).isFile, "the damaged snapshot is kept");
    assert(
      (await Deno.stat(outcome.quarantinedTo!)).isFile,
      "the damaged database is kept",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("integrity: old quarantine copies are pruned to the most recent few", async () => {
  const dir = await Deno.makeTempDir({ prefix: "integ-prune-" });
  try {
    const { db, path } = await seeded(dir);
    await db.close();
    // Casualties from earlier boots.
    const olds: string[] = [];
    for (let i = 0; i < QUARANTINE_KEEP + 2; i++) {
      const p = quarantinePathFor(
        path,
        new Date(Date.UTC(2020, 0, 1 + i, 0, 0, 0)),
      );
      await Deno.writeTextFile(p, `casualty ${i}`);
      olds.push(p);
    }
    await damage(path);

    const db2 = createDB(path);
    const l = logs();
    const outcome = await checkAndRecover({
      db: db2,
      dbPath: path,
      log: l.log,
    });
    assertEquals(outcome.action, "quarantined");

    const kept: string[] = [];
    for await (const e of Deno.readDir(dir)) {
      if (e.name.includes(".corrupt-")) kept.push(e.name);
    }
    assertEquals(
      kept.length,
      QUARANTINE_KEEP,
      `only the ${QUARANTINE_KEEP} newest are kept — saw ${kept.sort()}`,
    );
    // The one this boot just made is among them, and the oldest is gone.
    assert(
      kept.some((k) =>
        path.endsWith("state.db") && k.startsWith("state.db.corrupt-")
      ),
    );
    assertEquals(
      kept.some((k) => k.includes("2020-01-01")),
      false,
      "the oldest went first",
    );
    assertStringIncludes(l.out.join("\n"), "removed an old quarantined copy");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
