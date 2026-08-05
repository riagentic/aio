// tests/sync/unapplied-op.test.ts — an op the server did NOT apply must never
// be acked.
//
// Three ways a dispatch can reach the composed reducer and change nothing:
//   1. the cell is booted but has no method by that name (renamed/removed
//      method, older client, hand-built action),
//   2. the owning cell is disabled (circuit breaker / registry.disable),
//   3. a machine guard blocks the action in the current state.
// All three used to return `{ state, effects: [] }` silently. The sync handler
// asks "was this op refused?" immediately after dispatching it, got "no", and
// then ACKED the op to its origin (which keeps its optimistic change),
// BROADCAST it to every peer and left it in the log to be compacted — the
// change applied everywhere except the machine that owns the truth.
import { assert, assertEquals, assertExists } from "@std/assert";
import { cell } from "../../src/state/cell.ts";
import { composeCells } from "../../src/state/cell-compose.ts";
import type { CellEntry, Msg } from "../../src/state/cell-types.ts";
import { takeRejectionFor } from "../../src/state/rejection-tracker.ts";
import { createServerSyncHandler } from "../../src/sync/server-handler.ts";
import type { HLC } from "../../src/sync/types.ts";
import { createTestDb, recordingSocket } from "./_test-db.ts";

const hlc = (phys: number, cnt = 0, node = "client-a"): HLC => [
  phys,
  cnt,
  node,
];

function counterCell(name: string) {
  return cell(name, {
    state: { n: 0 },
    methods: {
      inc: (s: { n: number }) => {
        s.n++;
      },
    },
  });
}

Deno.test("reduce: an action naming NO method of a booted cell is recorded as a refusal", () => {
  const c = counterCell("uoc-plain");
  const composed = composeCells([c] as unknown as CellEntry[]);
  const before = composed.initialState as Record<string, unknown>;

  const action = { type: "uoc-plain:gone", payload: { args: [] } };
  const out = composed.reduce(before, action);

  assertEquals(
    (out as { patches?: unknown }).patches,
    undefined,
    "nothing was applied",
  );
  assertEquals(
    (out.state as Record<string, { n: number }>)["uoc-plain"]!.n,
    0,
    "state did not move",
  );
  const rejection = takeRejectionFor(action, "uoc-plain");
  assertExists(rejection, "the refusal must be recorded, not swallowed");
  assert(
    rejection.reason.includes("gone"),
    `reason names the action: ${rejection.reason}`,
  );
});

Deno.test("reduce: a KNOWN method still applies and records nothing", () => {
  const c = counterCell("uoc-known");
  const composed = composeCells([c] as unknown as CellEntry[]);
  const action = { type: "uoc-known:inc", payload: { args: [] } };
  const out = composed.reduce(
    composed.initialState as Record<string, unknown>,
    action,
  );
  assertEquals((out.state as Record<string, { n: number }>)["uoc-known"]!.n, 1);
  assertEquals(
    takeRejectionFor(action, "uoc-known"),
    null,
    "a healthy op must not be poisoned",
  );
});

Deno.test("reduce: a DISABLED cell records the refusal instead of a silent no-op", () => {
  const c = counterCell("uoc-off");
  const composed = composeCells([c] as unknown as CellEntry[]);
  let state = composed.initialState as Record<string, unknown>;
  composed.registry.disable("uoc-off", {
    dispatch: (a) => {
      state = composed.reduce(state, a).state;
    },
    getState: () => state,
  });

  const action = { type: "uoc-off:inc", payload: { args: [] } };
  const out = composed.reduce(state, action);
  assertEquals(
    (out.state as Record<string, { n: number }>)["uoc-off"]!.n,
    0,
    "a disabled cell applies nothing",
  );
  const rejection = takeRejectionFor(action, "uoc-off");
  assertExists(rejection, "a disabled cell's refusal must be recorded");
  assert(
    rejection.reason.includes("disabled"),
    `reason says why: ${rejection.reason}`,
  );
});

Deno.test("reduce: a MACHINE GUARD block records the refusal", () => {
  // A machine only exists via listensTo (the public machine config is gone),
  // and its single state allows exactly the cell's own methods plus the foreign
  // types it listens to. `__setSlow` — the write-back of an async method — is
  // NOT allowed from the `idle` state a guard leaves us in, which is the real
  // "async result discarded" footgun. Simplest reachable form: a foreign action
  // the machine allows in one state only.
  const src = cell("uoc-src", {
    state: { n: 0 },
    methods: {
      fire: (s: { n: number }) => {
        s.n++;
      },
    },
  });
  const listener = cell("uoc-lis", {
    state: { seen: 0 },
    listensTo: ["uoc-src:fire"],
    methods: {
      onFire: (s: { seen: number }) => {
        s.seen++;
      },
    },
  });
  const composed = composeCells([src, listener] as unknown as CellEntry[]);
  const machine = listener.__aio.machine as {
    initial: string;
    states: Record<string, Record<string, string>>;
  };
  // Narrow the machine to a state that allows NOTHING — the guard path.
  machine.states.active = {};

  const action = { type: "uoc-lis:onFire", payload: { args: [] } };
  const out = composed.reduce(
    composed.initialState as Record<string, unknown>,
    action,
  );
  assertEquals(
    (out.state as Record<string, { seen: number }>)["uoc-lis"]!.seen,
    0,
    "the guard blocked it",
  );
  const rejection = takeRejectionFor(action, "uoc-lis");
  assertExists(rejection, "a guard block is a refusal, and must say so");
  assert(
    rejection.reason.includes("blocked"),
    `reason says why: ${rejection.reason}`,
  );
});

Deno.test("sync server: an op naming an unknown method is REJECTED, not acked", async () => {
  const c = counterCell("uoc-sync");
  const composed = composeCells([c] as unknown as CellEntry[]);
  let state = composed.initialState as Record<string, unknown>;

  const { db, close } = createTestDb();
  const { socket, frames } = recordingSocket();
  const broadcasts: string[] = [];
  const handler = createServerSyncHandler({
    // The real composed reduce — the whole point: no stub may decide for it.
    dispatch: (a) => {
      state = composed.reduce(state, a as unknown as Msg)
        .state;
    },
    db,
    syncCellIds: ["uoc-sync"],
    getCellState: () => state["uoc-sync"] as Record<string, unknown>,
    getClientCellState: () => state["uoc-sync"] as Record<string, unknown>,
    broadcastRaw: { fn: (m) => broadcasts.push(m) },
    log: { debug: () => {}, warn: () => {}, error: () => {} },
  });

  try {
    await handler.handleOp(
      {
        id: "op-unknown",
        hlc: hlc(100),
        cell: "uoc-sync",
        action: "renamedAway",
        payload: { args: [] },
      },
      { id: "s1" },
      socket,
    );

    const rejected = frames.find((f) => f.t === "op-rejected");
    assertExists(rejected, "the origin client must be told WHY");
    assertEquals(
      (rejected.d as { opId: string }).opId,
      "op-unknown",
    );
    assertEquals(
      frames.some((f) => f.t === "sync-ack"),
      false,
      "an op the server never applied must NOT be acked",
    );
    assertEquals(broadcasts.length, 0, "and must not reach peers");
    const { rows } = await db.query(
      "SELECT id FROM sync_ops WHERE id = ?",
      ["op-unknown"],
    );
    assertEquals(rows.length, 0, "and must not stay in the op log");
  } finally {
    close();
  }
});

Deno.test("sync server: a KNOWN op still acks, applies and broadcasts", async () => {
  const c = counterCell("uoc-sync-ok");
  const composed = composeCells([c] as unknown as CellEntry[]);
  let state = composed.initialState as Record<string, unknown>;

  const { db, close } = createTestDb();
  const { socket, frames } = recordingSocket();
  const broadcasts: string[] = [];
  const handler = createServerSyncHandler({
    dispatch: (a) => {
      state = composed.reduce(state, a as unknown as Msg)
        .state;
    },
    db,
    syncCellIds: ["uoc-sync-ok"],
    getCellState: () => state["uoc-sync-ok"] as Record<string, unknown>,
    getClientCellState: () => state["uoc-sync-ok"] as Record<string, unknown>,
    broadcastRaw: { fn: (m) => broadcasts.push(m) },
    log: { debug: () => {}, warn: () => {}, error: () => {} },
  });

  try {
    await handler.handleOp(
      {
        id: "op-good",
        hlc: hlc(200),
        cell: "uoc-sync-ok",
        action: "inc",
        payload: { args: [] },
      },
      { id: "s1" },
      socket,
    );
    assertEquals(
      (state as Record<string, { n: number }>)["uoc-sync-ok"]!.n,
      1,
      "server state took it",
    );
    assertEquals(frames.some((f) => f.t === "sync-ack"), true, "acked");
    assertEquals(frames.some((f) => f.t === "op-rejected"), false);
    assertEquals(broadcasts.length, 1, "peers got it");
  } finally {
    close();
  }
});
