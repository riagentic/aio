// The sync store's schema fallbacks (`highWaterTs`, `hasSyncSnapshot`,
// `getCompactedTs`, `getOpServerTs`) exist for ONE case: a table or column an
// older store lacks. They caught EVERY error — a locked or unreadable file, a
// closed handle — and answered 0 / false / null, which a catch-up reads as
// "no snapshot, cursor 0": a client rebuilt from its own initial state, and a
// failed seed let the issuer stamp below cursors clients already hold.
import { assertEquals, assertRejects } from "@std/assert";
import type { DB } from "../src/db/types.ts";
import {
  _resetServerTsForTest,
  getCompactedTs,
  getOpServerTs,
  hasSyncSnapshot,
  persistOp,
  reserveServerTs,
} from "../src/sync/server-store.ts";

const failing = (msg: string): DB =>
  ({
    query: () => Promise.reject(new Error(msg)),
    execute: () => Promise.reject(new Error(msg)),
    transaction: () => Promise.reject(new Error(msg)),
  }) as unknown as DB;

Deno.test("sync store: a real DB error propagates instead of reading as an empty store", async () => {
  _resetServerTsForTest();
  const db = failing("disk I/O error");
  await assertRejects(() => reserveServerTs(db), Error, "disk I/O");
  await assertRejects(() => hasSyncSnapshot(db, "c"), Error, "disk I/O");
  await assertRejects(() => getCompactedTs(db, "c"), Error, "disk I/O");
  await assertRejects(() => getOpServerTs(db, "x"), Error, "disk I/O");
  _resetServerTsForTest();
});

Deno.test("sync store: a missing table / column is still the old-schema answer", async () => {
  _resetServerTsForTest();
  const t = failing("no such table: sync_ops");
  assertEquals(await hasSyncSnapshot(t, "c"), false);
  assertEquals(
    await getCompactedTs(failing("no such column: compacted_ts"), "c"),
    0,
  );
  assertEquals(
    await getOpServerTs(failing("no such column: server_ts"), "x"),
    null,
  );
  const hw = await reserveServerTs(t);
  assertEquals(hw, 0);
  _resetServerTsForTest();
});

Deno.test("sync store: a seed that failed is retried, so the issuer resumes above the durable mark", async () => {
  _resetServerTsForTest();
  const FAR = Date.now() + 10_000_000;
  let fail = true;
  const db = {
    query: (sql: string) => {
      if (fail) return Promise.reject(new Error("database is locked"));
      if (/MAX/.test(sql)) return Promise.resolve({ rows: [{ ts: FAR }] });
      return Promise.resolve({ rows: [] }); // isKnownOpId: unknown
    },
    execute: () => Promise.resolve({ changes: 1, rows: [] }),
  } as unknown as DB;
  const op = {
    id: "o1",
    hlc: [1, 0, "n"] as [number, number, string],
    cell: "c",
    action: "a",
    payload: null,
  };
  await assertRejects(() => persistOp(db, op), Error, "locked");
  fail = false;
  const ts = await persistOp(db, op);
  assertEquals(
    ts !== null && ts > FAR,
    true,
    `issued ${ts} must exceed ${FAR}`,
  );
  _resetServerTsForTest();
});
