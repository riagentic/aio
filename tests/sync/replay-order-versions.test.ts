// tests/sync/replay-order-versions.test.ts — M3 regression.
//
// The boot replay sorted the op-log by the cell `version` each op was written
// under, then by load order. That is only equivalent to chronological order
// while version is monotonic in server_ts — i.e. while an older build never
// runs again. It does: a downgraded build QUARANTINES the cell and (before
// H2) kept accepting writes, stamping fresh ops with the OLDER version, and
// those ops then sorted AHEAD of chronologically earlier ones. The replay then
// folds a sequence the live server never applied — a different state, kept
// forever, with nothing to compare it against.
//
// server_ts IS the order the server applied them (`loadOpsSince` returns it).
// Version is for the migration ladder only, and an op written under a shape
// the state has already been migrated PAST cannot be folded at all — that must
// be loud, not quietly reordered into something that "works".
import { assert, assertEquals } from "@std/assert";
import { replaySyncOps } from "../../src/server/aio-boot.ts";
import {
  _resetServerTsForTest,
  persistOp,
  seedSyncSnapshot,
} from "../../src/sync/server-store.ts";
import type { HLC } from "../../src/sync/types.ts";
import { createTestDb } from "./_test-db.ts";

const CELL = "log";
const hlc = (n: number): HLC => [1000 + n, 0, "n1"];

type S = { log: Record<string, unknown> };
const initial: S = { log: { entries: [] } };

/** v2 shape: entries are `{ text }`. A v1 payload (a bare string) throws, the
 *  way a real reducer does when the shape moved under it. */
function reduceV2(s: S, a: { type: string; payload?: unknown }): S {
  if (a.type !== "log:add") return s;
  const p = a.payload as { text: string };
  if (typeof p !== "object" || p === null) {
    throw new TypeError("Cannot read properties of undefined (reading 'text')");
  }
  return {
    log: { entries: [...(s.log.entries as unknown[]), p.text] },
  };
}

const onMigrate = (
  state: Record<string, unknown>,
  from: number,
): Record<string, unknown> =>
  from < 2
    ? { ...state, entries: (state.entries as string[]).map((t) => t) }
    : state;

const capture = () => {
  const l = {
    info: [] as string[],
    warn: [] as string[],
    error: [] as string[],
    debug: [] as string[],
  };
  return {
    l,
    log: {
      info: (m: string) => l.info.push(m),
      warn: (m: string) => l.warn.push(m),
      error: (m: string) => l.error.push(m),
      debug: (m: string) => l.debug.push(m),
    },
  };
};

const migrations = new Map([[CELL, {
  version: 2,
  initialState: initial.log,
  onMigrate,
}]]);

Deno.test("M3: replay folds in server_ts order, not version order", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    await seedSyncSnapshot(db, CELL, { entries: [] }, 2);
    // All v2, written in this chronological order.
    for (const [i, text] of ["a", "b", "c"].entries()) {
      await persistOp(
        db,
        {
          id: `o${i}`,
          hlc: hlc(i),
          cell: CELL,
          action: "add",
          payload: { text },
        },
        2,
      );
    }
    const c = capture();
    const state = await replaySyncOps(
      db,
      [CELL],
      reduceV2,
      structuredClone(initial),
      c.log,
      {
        dev: false,
        versions: { [CELL]: 2 },
        migrations,
        initialState: initial,
      },
    );
    assertEquals((state.log as Record<string, unknown>).entries, [
      "a",
      "b",
      "c",
    ]);
  } finally {
    close();
  }
});

Deno.test("M3: an older-shape op written AFTER a newer one is refused, not reordered", async () => {
  // The downgrade case: v1 op, then a v2 op, then the old build runs again and
  // writes another v1 op. Version-first sorting silently moved that last op to
  // the FRONT and folded a history that never happened.
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    await seedSyncSnapshot(db, CELL, { entries: [] }, 1);
    await persistOp(
      db,
      { id: "v1-early", hlc: hlc(1), cell: CELL, action: "add", payload: "a" },
      1,
    );
    await persistOp(
      db,
      {
        id: "v2-mid",
        hlc: hlc(2),
        cell: CELL,
        action: "add",
        payload: { text: "b" },
      },
      2,
    );
    await persistOp(
      db,
      { id: "v1-late", hlc: hlc(3), cell: CELL, action: "add", payload: "c" },
      1,
    );

    const c = capture();
    const quarantined = new Set<string>();
    await replaySyncOps(
      db,
      [CELL],
      // The v1 world is a bare string; onMigrate carries it to v2.
      (s: S, a: { type: string; payload?: unknown }) => {
        if (a.type !== "log:add") return s;
        const p = a.payload;
        const text = typeof p === "string" ? p : (p as { text: string }).text;
        return { log: { entries: [...(s.log.entries as unknown[]), text] } };
      },
      structuredClone(initial),
      c.log,
      {
        dev: false,
        versions: { [CELL]: 2 },
        migrations,
        quarantined,
        initialState: initial,
      },
    );

    assertEquals(
      [...quarantined],
      [CELL],
      "an op that cannot be placed in the shape ladder must quarantine the cell",
    );
    const err = c.l.error.join("\n");
    assert(
      err.includes("v1-late"),
      `the refusal must name the op — got ${err}`,
    );
    assert(
      /older build|already been migrated/.test(err),
      `the refusal must say WHY (an older build wrote after a newer one) — got ${err}`,
    );
  } finally {
    close();
  }
});
