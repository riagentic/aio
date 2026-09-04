// tests/rejection-attribution.test.ts — D11: a rejection belongs to the
// DISPATCH that was refused, never to a cell-wide slot read across an await.
//
// The sync server handler dispatches an op, awaits it, then reads the
// rejection the reducer recorded. Between those two points the event loop is
// free: another handleOp chain (a different client, a different cell) resumes
// and runs its own reduce. With a single global "last rejection" slot keyed
// only by CELL, that neighbouring reduce both CLEARS a rejection that belonged
// to someone else (poison op silently acked + broadcast) and PLANTS one that
// did not (a healthy op deleted from the log and rolled back on its origin
// while it stays applied in server state).
//
// Both directions are proven here through the REAL composed reducer, the REAL
// dispatch loop and a REAL sqlite op-log — nothing about the interleaving is
// simulated.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { composeCells } from "../src/state/cell-compose.ts";
import { createDispatch } from "../src/state/dispatch.ts";
import type { Msg } from "../src/state/cell-types.ts";
import { createServerSyncHandler } from "../src/sync/server-handler.ts";
import { _resetServerTsForTest } from "../src/sync/server-store.ts";
import { createTestDb, recordingSocket } from "./sync/_test-db.ts";
import type { HLC } from "../src/sync/types.ts";

const noop = { debug: () => {}, warn: () => {}, error: () => {} };

/** alpha refuses any state with n < 0, and is poisoned by `beta:poison`. */
function makeCells() {
  const beta = cell("beta", {
    state: { m: 0 },
    methods: {
      bump(s) {
        s.m += 1;
      },
      poison(s) {
        s.m += 1;
      },
    },
  });
  const alpha = cell("alpha", {
    state: { n: 0, poisoned: false },
    methods: {
      set(s, v: number) {
        s.n = v;
      },
      onPoison(s) {
        s.poisoned = true;
      },
    },
    listensTo: { onPoison: "beta:poison" },
    validate: (s) =>
      s.n < 0
        ? "n must be >= 0"
        : s.poisoned
        ? "alpha was poisoned"
        : true as const,
  });
  return { alpha, beta };
}

function harness() {
  _resetServerTsForTest();
  const { alpha, beta } = makeCells();
  const composed = composeCells([alpha, beta]);
  let state = composed.initialState;
  const app = {
    dispatch: (a: Msg) => dispatch(a),
    getState: () => state,
  };
  const dispatch = createDispatch<
    Record<string, unknown>,
    Msg,
    Msg
  >({
    reduce: composed.reduce as never,
    execute: (e) => composed.execute(app, e as Msg),
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {},
    log: noop,
    debug: false,
  });
  const { db, close } = createTestDb();
  const broadcasts: unknown[] = [];
  const handler = createServerSyncHandler({
    dispatch: (a) => dispatch(a as unknown as Msg),
    db,
    syncCellIds: ["alpha", "beta"],
    getCellState: (c) => (state as Record<string, never>)[c] ?? {},
    getClientCellState: (c) => (state as Record<string, never>)[c] ?? {},
    broadcastRaw: { fn: (m) => broadcasts.push(m) },
    log: noop,
  });
  return {
    handler,
    db,
    close,
    broadcasts,
    getState: () => state as Record<string, Record<string, unknown>>,
  };
}

let seq = 0;
// Stamped relative to NOW: an UNKNOWN op stamped older than the server's
// tombstone window is refused by name (`STALE_OP_REASON`), and an epoch-era
// literal is an ordering label, not "an op from 1970".
const T0 = Date.now();
const hlc = (): HLC => [T0 + ++seq, 0, "c1"];

Deno.test("D11: a REFUSED op stays refused when another cell's dispatch interleaves", async () => {
  const h = harness();
  const a = recordingSocket();
  const b = recordingSocket();
  try {
    // Warm-up: the store seeds its cursor from the DB on first touch, which
    // would give the first of two concurrent chains one extra await and
    // accidentally serialize them. One prior op removes that asymmetry.
    await h.handler.handleOp(
      {
        id: "op-warm",
        hlc: hlc(),
        cell: "beta",
        action: "bump",
        payload: { args: [] },
      },
      { id: "c0" },
      recordingSocket().socket,
    );
    // Two clients, two cells — the handler's per-cell lock does not serialize
    // them, so B's dispatch lands between A's dispatch and A's rejection read.
    const pa = h.handler.handleOp(
      {
        id: "op-a",
        hlc: hlc(),
        cell: "alpha",
        action: "set",
        payload: { args: [-1] },
      },
      { id: "c1" },
      a.socket,
    );
    const pb = h.handler.handleOp(
      {
        id: "op-b",
        hlc: hlc(),
        cell: "beta",
        action: "bump",
        payload: { args: [] },
      },
      { id: "c2" },
      b.socket,
    );
    await Promise.all([pa, pb]);

    // The reducer refused it: server state never took the write.
    assertEquals(
      h.getState().alpha!.n,
      0,
      "validate refused — state unchanged",
    );

    const rejected = a.frames.find((f) => f.t === "op-rejected");
    assert(
      rejected,
      "the origin must be told WHY — otherwise its optimistic write snaps " +
        "back with no explanation and it re-sends the op forever",
    );
    assertEquals((rejected!.d as { opId: string }).opId, "op-a");
    assertEquals(
      a.frames.some((f) => f.t === "sync-ack"),
      false,
      "a refused op must NOT be acked — an ack tells the origin it landed",
    );
    const { rows } = await h.db.query("SELECT id FROM sync_ops WHERE id = ?", [
      "op-a",
    ]);
    assertEquals(
      rows.length,
      0,
      "poison must not survive in the log — replay/compaction would resurrect " +
        "a change the server itself refused",
    );
  } finally {
    h.close();
  }
});

Deno.test("D11: an APPLIED op is not rejected by a neighbouring dispatch's refusal", async () => {
  const h = harness();
  const a = recordingSocket();
  const b = recordingSocket();
  try {
    // Warm-up: the store seeds its cursor from the DB on first touch, which
    // would give the first of two concurrent chains one extra await and
    // accidentally serialize them. One prior op removes that asymmetry.
    await h.handler.handleOp(
      {
        id: "op-warm",
        hlc: hlc(),
        cell: "beta",
        action: "bump",
        payload: { args: [] },
      },
      { id: "c0" },
      recordingSocket().socket,
    );
    // op-a is perfectly valid. op-b targets `beta`, but alpha LISTENS to
    // `beta:poison` and its validate refuses the result — so the reduce of
    // op-b records a rejection whose cell is "alpha".
    const pa = h.handler.handleOp(
      {
        id: "op-a",
        hlc: hlc(),
        cell: "alpha",
        action: "set",
        payload: { args: [7] },
      },
      { id: "c1" },
      a.socket,
    );
    const pb = h.handler.handleOp(
      {
        id: "op-b",
        hlc: hlc(),
        cell: "beta",
        action: "poison",
        payload: { args: [] },
      },
      { id: "c2" },
      b.socket,
    );
    await Promise.all([pa, pb]);

    assertEquals(h.getState().alpha!.n, 7, "op-a applied to server state");
    assertEquals(
      a.frames.some((f) => f.t === "op-rejected"),
      false,
      "op-a was APPLIED — telling its origin it was rejected makes the client " +
        "roll back a change the server kept: permanent silent divergence",
    );
    assert(
      a.frames.some((f) => f.t === "sync-ack"),
      "an applied op must be acked",
    );
    const { rows } = await h.db.query("SELECT id FROM sync_ops WHERE id = ?", [
      "op-a",
    ]);
    assertEquals(
      rows.length,
      1,
      "an applied op must stay in the log — deleting it makes state and log " +
        "disagree, and compaction snapshots state",
    );
  } finally {
    h.close();
  }
});
