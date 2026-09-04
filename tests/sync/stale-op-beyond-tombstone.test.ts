// A RESEND THE SERVER CAN NO LONGER RECOGNISE MUST BE REFUSED, NOT APPLIED.
//
// Compaction DELETEs op rows and tombstones their ids so `persistOp`'s dedup
// survives it; the tombstones are swept after `tombstoneWindowMs` (24h, or the
// cell's `offline.retention` when longer). That sweep was justified by the
// client's retention: "the longest a client may hold an op before re-sending
// it". But the client evicts stale unconfirmed ops ONLY when its buffer hits
// `pendingCap` (op-buffer.ts), and `requestSync` re-sends every unconfirmed op
// whatever its age. So a phone that sent one change, lost the ack in the
// disconnect that followed, and came back two days later re-sent it — and the
// server, its tombstone gone, saw a brand-new op: inserted, dispatched,
// applied a SECOND time, acked, broadcast to every peer. A counter drifted, an
// append appended twice, and nothing on either side said so.
//
// The server cannot tell such a resend from a genuinely new change — that is
// the whole point of the tombstone — so past the window it must not GUESS.
// An unknown op stamped older than the window is refused with `op-rejected`,
// the reason naming exactly this (`stale-beyond-retention`) and the knob that
// widens the window. The client hears it once, drops the op (`onDrop` with the
// same reason) and stops re-sending it. A known op — a live row, a standing
// tombstone — is still re-acked exactly as before, however old it is.
import { assert, assertEquals } from "@std/assert";
import { createServerSyncHandler } from "../../src/sync/server-handler.ts";
import { compactSyncOps, tombstoneWindowMs } from "../../src/sync/compact.ts";
import { _resetServerTsForTest } from "../../src/sync/server-store.ts";
import { parseRetention } from "../../src/sync/op-buffer.ts";
import { SYNC_DEFAULTS } from "../../src/sync/types.ts";
import type { HLC } from "../../src/sync/types.ts";
import { createTestDb, recordingSocket, until } from "./_test-db.ts";

const CELL = "todos";
const silent = { debug: () => {}, warn: () => {}, error: () => {} };
const HOUR = 3600_000;
/** The wire token — a literal, so this test pins what a client must match. */
const STALE = "stale-beyond-retention";

/** Run `fn` with `Date.now` under test control. `at.t` is the clock. */
async function withClock<T>(
  fn: (at: { t: number }) => Promise<T>,
): Promise<T> {
  const orig = Date.now;
  const at = { t: orig() };
  Date.now = () => at.t;
  try {
    return await fn(at);
  } finally {
    Date.now = orig;
  }
}

function makeHandler(
  db: ReturnType<typeof createTestDb>["db"],
  retentionMs?: number,
) {
  const applied: string[] = [];
  const handler = createServerSyncHandler({
    dispatch: (a) => {
      applied.push(a.type);
    },
    db,
    syncCellIds: [CELL],
    getCellState: () => ({}),
    getClientCellState: () => ({}),
    ...(retentionMs !== undefined ? { opRetentionMs: () => retentionMs } : {}),
    broadcastRaw: { fn: () => {} },
    log: silent,
  });
  const compact = (now: number, retention?: number) =>
    compactSyncOps({
      db,
      cell: CELL,
      getState: () => ({}),
      serverHlc: [now, 0, "server"] as HLC,
      compactOps: 0,
      retentionMs: retention,
      log: silent,
    });
  return { handler, applied, compact };
}

const opAt = (id: string, node: string, physical: number, t = "milk") => ({
  id,
  hlc: [physical, 0, node] as HLC,
  cell: CELL,
  action: "add",
  payload: { t },
});

Deno.test("resend after the tombstone sweep: refused by name, never applied twice", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    await withClock(async (at) => {
      const { handler, applied, compact } = makeHandler(db);
      const { socket, frames } = recordingSocket();
      const X = opAt("phone-s1-1", "phone", at.t);

      // The phone's change lands. The ack it earns is lost in the disconnect
      // that follows — the op stays unconfirmed in the phone's buffer, well
      // below `pendingCap`, so nothing ever evicts it.
      await handler.handleOp(X, { id: "phone" }, socket);
      assertEquals(applied.length, 1);
      // Any server-origin write compacts (threshold 0): X's row becomes a
      // tombstone.
      await compact(at.t);

      // Past the window: another client writes, the compaction that follows
      // sweeps X's tombstone.
      at.t += tombstoneWindowMs(undefined) + HOUR;
      await handler.handleOp(
        opAt("laptop-s1-1", "laptop", at.t, "eggs"),
        { id: "laptop" },
        socket,
      );
      await compact(at.t);
      assertEquals(
        (await db.query("SELECT id FROM sync_compacted_ids WHERE id = ?", [
          X.id,
        ])).rows.length,
        0,
        "setup: X's tombstone must be gone",
      );
      assertEquals(applied.length, 2);

      // The phone comes back and re-sends X, exactly as it was sent.
      frames.length = 0;
      await handler.handleOp(X, { id: "phone" }, socket);

      assertEquals(
        applied.length,
        2,
        "X was applied a SECOND time — the tombstone was swept, so the " +
          "server took a resend for a new change",
      );
      assert(
        !frames.some((f) => f.t === "sync-ack" && f.d.opId === X.id),
        "a refused op must not be acked",
      );
      const rej = frames.find((f) =>
        f.t === "op-rejected" && f.d.opId === X.id
      );
      assert(
        rej,
        `expected op-rejected for ${X.id}, got ${JSON.stringify(frames)}`,
      );
      const reason = String(rej.d.reason);
      assert(
        reason.startsWith(STALE),
        `reason must start with "${STALE}": ${reason}`,
      );
      assert(
        /retention/.test(reason),
        `the reason must name the knob that widens the window: ${reason}`,
      );
      assertEquals(
        (await db.query("SELECT id FROM sync_ops WHERE id = ?", [X.id])).rows
          .length,
        0,
        "a refused op must not enter the log",
      );
    });
  } finally {
    close();
  }
});

Deno.test("resend whose tombstone still stands is re-acked, however old", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    await withClock(async (at) => {
      // `retention: "7d"` — the docs' own example — widens the window.
      const sevenDays = parseRetention("7d");
      const { handler, applied, compact } = makeHandler(db, sevenDays);
      const { socket, frames } = recordingSocket();
      const X = opAt("phone-s1-1", "phone", at.t);
      await handler.handleOp(X, { id: "phone" }, socket);
      await compact(at.t, sevenDays);

      // Three days offline: past the 24h floor, inside the cell's retention.
      at.t += 3 * 24 * HOUR;
      frames.length = 0;
      await handler.handleOp(X, { id: "phone" }, socket);
      assertEquals(
        applied.length,
        1,
        "a recognised duplicate is not re-applied",
      );
      assert(
        frames.some((f) => f.t === "sync-ack" && f.d.opId === X.id),
        "the lost ack is retransmitted",
      );
      assert(!frames.some((f) => f.t === "op-rejected"));
    });
  } finally {
    close();
  }
});

Deno.test("an unknown op older than the window is refused on the reconnect path too", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    await withClock(async (at) => {
      const { handler, applied } = makeHandler(db);
      const { socket, frames } = recordingSocket();
      const old = opAt(
        "phone-s1-9",
        "phone",
        at.t - tombstoneWindowMs(undefined) - HOUR,
      );
      const fresh = opAt("phone-s1-10", "phone", at.t - 4 * HOUR, "eggs");
      handler.handleSync(
        {
          clientId: "phone",
          session: "s1",
          reqId: 1,
          cells: { [CELL]: { lastHlc: null } },
          pendingOps: [{ ...old, confirmed: false }, {
            ...fresh,
            confirmed: false,
          }],
        },
        { id: "phone" },
        socket,
      );
      await until(() => frames.some((f) => f.t === "sync-res"), "sync-res");
      const rej = frames.find((f) => f.t === "op-rejected");
      assert(rej && rej.d.opId === old.id, "the stale pending op is refused");
      assert(String(rej.d.reason).startsWith(STALE));
      // …and the four-hour-old one — the offline queue working as designed —
      // is applied and acked like before.
      assertEquals(applied, [`${CELL}:add`]);
      assert(frames.some((f) => f.t === "sync-ack" && f.d.opId === fresh.id));
    });
  } finally {
    close();
  }
});

Deno.test("the refusal threshold leaves the sweep no gap: drift slack is included", () => {
  // A tombstone is swept when `compacted_at < now - window`, and an op the
  // door accepted may be stamped up to `maxDrift` AFTER the server's clock at
  // persist time. So the newest op whose tombstone can already be gone is
  // stamped `now - window + maxDrift`; refusing only strictly older ops would
  // leave a `maxDrift`-wide sliver where a swept resend is applied twice.
  assert(SYNC_DEFAULTS.maxDrift < tombstoneWindowMs(undefined));
});
