// The boot hint for an unversioned sync cell says "declare version: 1 (and
// onMigrate when the shape changes)". Following it on an UNCHANGED shape — the
// exact situation the hint is printed in — must be silent and lossless: v0 and
// v1 describe the same shape, so there is nothing to migrate and no reason to
// warn "state may be stale", skip the old ops, or quarantine the cell.
import { assertEquals } from "@std/assert";
import { replaySyncOps } from "../../src/server/aio-boot.ts";
import {
  _resetServerTsForTest,
  persistOp,
  seedSyncSnapshot,
} from "../../src/sync/server-store.ts";
import { createTestDb } from "./_test-db.ts";

type S = { notes: { items: string[] } };
const reduce = (s: S, a: { type: string; payload?: unknown }): S =>
  a.type === "notes:add"
    ? { notes: { items: [...s.notes.items, String(a.payload)] } }
    : s;

Deno.test("sync version advice: declaring version: 1 on an unchanged v0 cell is silent and keeps every op", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    // Written by the build that declared no version (v0): a snapshot and a tail.
    await seedSyncSnapshot(db, "notes", { items: ["a"] }, 0);
    await persistOp(db, {
      id: "op1",
      hlc: [Date.now(), 0, "n1"],
      cell: "notes",
      action: "add",
      payload: "b",
    }, 0);
    const warn: string[] = [];
    const error: string[] = [];
    const report: { outcome: string }[] = [];
    // The next build followed the hint: `version: 1`, no onMigrate.
    const out = await replaySyncOps(
      db,
      ["notes"],
      reduce,
      { notes: { items: [] } } as S,
      {
        info: () => {},
        warn: (m: string) => void warn.push(m),
        error: (m: string) => void error.push(m),
      },
      { dev: true, versions: { notes: 1 }, report: report as never },
    );
    assertEquals(out.notes.items, ["a", "b"], "nothing skipped");
    assertEquals(warn, [], "following the framework's advice must not warn");
    assertEquals(error, []);
    assertEquals(
      report.filter((r) => r.outcome !== "migrated"),
      [],
      JSON.stringify(report),
    );
  } finally {
    close();
  }
});
