// A catch-up that is never answered must not freeze the cell forever.
//
// `requestSync` closes an ordering gate over every sync cell and, until now,
// only three things reopened it: engine boot, going offline→online, and a
// `sync-err` frame. A response LOST on a still-open connection is none of
// them — and the server had two door-refusals that answered with nothing at
// all, plus a `sendTo` that swallows a failed write on an open socket.
//
// Measured before this: a peer's op and the client's own ack were held
// forever. 500ms after a `requestSync` with no answer:
//
//   confirmed state: {"n":0}          ← the peer's +5 never arrived
//   status:          {"status":"syncing","pending":1,"lastSync":0}
//
// Permanently, and silently: the cell stops receiving peer changes and stops
// confirming its own ops, the pending buffer grows toward `pendingCap`, and
// past it the user's own mutations start throwing. `_reqSeq`'s comment called
// this "self-healing: a lost response leaves the gate shut only until the next
// request is answered" — nothing ever sent a next request.
//
// The watchdog RE-REQUESTS rather than force-opening the gate: held items can
// only be folded against a response (snapshot, ops and rebase, under one
// lock), so asking again is the honest recovery — the same thing `sync-err`
// already does.
import { assert, assertEquals } from "@std/assert";
import {
  createMemoryStorage,
  createOpBuffer,
} from "../../src/sync/op-buffer.ts";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";

const CELL = "c";

Deno.test("sync: an unanswered catch-up is retried, not left to freeze", async () => {
  const confirmed: Record<string, Record<string, unknown>> = {
    [CELL]: { n: 0 },
  };
  const sent: string[] = [];
  const warns: string[] = [];
  const engine = createSyncEngine({
    clientId: "A",
    cells: { [CELL]: normalizeSyncConfig(true) },
    buffer: createOpBuffer(createMemoryStorage()),
    // The server never answers — the shape a dropped frame produces.
    send: (m) => sent.push(m),
    reducer: (state, action, payload) =>
      action === "inc"
        ? { ...state, n: (state.n as number) + (payload as number) }
        : null,
    getConfirmedState: () => confirmed,
    setConfirmedState: (cell, st) => {
      confirmed[cell] = st;
    },
    onStateUpdate: () => {},
    catchupTimeoutMs: 150,
    log: { warn: (m) => warns.push(m) },
  });

  try {
    engine.setOnline(true);
    await engine.requestSync();
    const afterFirst = sent.filter((f) => f.includes("sync-req")).length;
    assertEquals(afterFirst, 1, "one catch-up went out");

    // A peer's change arrives while the gate is shut — it is HELD, correctly.
    await engine.handleRemoteOp({
      id: "PEER-1",
      cell: CELL,
      action: "inc",
      payload: 5,
      hlc: [Date.now(), 0, "B"],
      confirmed: true,
      serverTs: 10,
    });
    assertEquals(
      confirmed[CELL]!.n,
      0,
      "holding it is correct — the gate exists to order it after the catch-up",
    );

    // …and nothing ever answers. The watchdog must ask again.
    await new Promise((r) => setTimeout(r, 450));

    const total = sent.filter((f) => f.includes("sync-req")).length;
    assert(
      total > afterFirst,
      `the catch-up was never answered and never retried — this cell is ` +
        `frozen for the life of the connection (sync-req frames: ${total})`,
    );
    assert(
      warns.some((w) => w.includes("no catch-up response")),
      `…and it must SAY so, because a frozen sync cell looks like a quiet ` +
        `one: ${JSON.stringify(warns)}`,
    );
  } finally {
    engine.setOnline(false);
  }
});
