// Under `PRAGMA synchronous = FULL` an accepted sync op is TWO synced commits:
// its row, by itself, before the reduce runs — and its `settled` mark, before
// the ack.
//
// The row could ride its mark's `fsync` (one sync per op, ≈5 ms saved on
// NVMe) — and then a power cut between the dispatch and the mark loses the
// row of an op whose reduce already ran: its author's resend is a FIRST
// delivery, and an external effect that reduce started runs twice. An app
// that asked for FULL was promised at most once. What is pinned here is the
// setting each statement actually committed under, read by SQLite itself in
// the statement (`pragma_synchronous`: 1 = NORMAL, 2 = FULL), and WHEN: a
// second connection sees only what is committed, and it is asked from inside
// the dispatch and from inside the ack's send.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { createDB } from "../src/db/async-db.ts";
import { SYNC_SCHEMA } from "../src/sync/compact.ts";
import { createServerSyncHandler } from "../src/sync/server-handler.ts";
import {
  _resetServerTsForTest,
  persistOp,
  settleOp,
} from "../src/sync/server-store.ts";
import type { HLC } from "../src/sync/types.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const op = (id: string) => ({
  id,
  hlc: [Date.now(), 0, "c1"] as HLC,
  cell: "notes",
  action: "add",
  payload: { args: [id] },
});

/** A file database under `synchronous = FULL` whose every write to
 *  `sync_ops` records the setting it ran under. `committed()` reads through
 *  ANOTHER connection, synchronously: what is on the file at that instant. */
async function fullDb(prefix: string) {
  const dir = await tempDir(prefix);
  const path = join(dir, "state.db");
  const db = createDB(path, { pragmas: ["PRAGMA synchronous = FULL"] });
  for (const stmt of SYNC_SCHEMA) await db.execute(stmt);
  await db.execute("CREATE TABLE seen (what TEXT, id TEXT, level INTEGER)");
  for (
    const [what, ev, row] of [["insert", "INSERT", "NEW"], [
      "mark",
      "UPDATE",
      "NEW",
    ], ["delete", "DELETE", "OLD"]]
  ) {
    await db.execute(
      `CREATE TRIGGER seen_${what} AFTER ${ev} ON sync_ops BEGIN
         INSERT INTO seen SELECT '${what}', ${row}.id, synchronous
           FROM pragma_synchronous;
       END`,
    );
  }
  const reader = new DatabaseSync(path, { readOnly: true });
  return {
    db,
    committed: () =>
      (reader.prepare("SELECT what, id, level FROM seen ORDER BY rowid")
        .all() as { what: string; id: string; level: number }[]).map((r) =>
          `${r.what} ${r.id} @${r.level}`
        ),
    async [Symbol.asyncDispose]() {
      reader.close();
      await db.close();
      await dropTempDir(dir);
    },
  };
}

Deno.test("sync op under synchronous = FULL: the row is committed under FULL by itself, and so is its mark — with or without a journal told", async () => {
  _resetServerTsForTest();
  await using t = await fullDb("sync-row-synced-");
  await persistOp(t.db, op("a"));
  assertEquals(t.committed(), ["insert a @2"], "the row, before any mark");
  await settleOp(t.db, "a");
  await persistOp(t.db, op("b"), 0, () => {});
  assertEquals(t.committed(), ["insert a @2", "mark a @2", "insert b @2"]);
});

Deno.test("sync op under synchronous = FULL: the row's synced commit is on the file when the reduce runs, the mark's when the ack is sent", async () => {
  _resetServerTsForTest();
  await using t = await fullDb("sync-row-before-reduce-");
  const at: Record<string, string[]> = {};
  const socket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: (m: string) => {
      if ((JSON.parse(m) as { t: string }).t === "sync-ack") {
        at.ack = t.committed();
      }
    },
  } as unknown as WebSocket;
  const errors: string[] = [];
  const handler = createServerSyncHandler({
    // The reduce — and every effect it starts — runs from here.
    dispatch: () => {
      at.reduce = t.committed();
    },
    db: t.db,
    syncCellIds: ["notes"],
    getCellState: () => ({ items: [] }),
    getClientCellState: () => ({ items: [] }),
    broadcastRaw: { fn: () => {} },
    log: { debug: () => {}, warn: () => {}, error: (m) => errors.push(m) },
  });
  await handler.handleOp(op("a"), { id: "c1" }, socket);
  assertEquals(errors, []);
  assertEquals(at, {
    reduce: ["insert a @2"],
    ack: ["insert a @2", "mark a @2"],
  });
});
