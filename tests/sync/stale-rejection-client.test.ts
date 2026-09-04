// THE CLIENT HALF OF `stale-beyond-retention`: hear it once, drop it, say so.
//
// The server refuses an op it can no longer recognise as a resend (see
// tests/sync/stale-op-beyond-tombstone.test.ts). That refusal is only worth
// anything if the client then STOPS re-sending the op — `requestSync` ships
// every unconfirmed op on every reconnect, so an op that stayed in the buffer
// would be refused on every round forever. And a dropped op is an abandoned
// local change, the one thing `onDrop` exists to report: every other
// abandoned change (evicted under backpressure, refused at cap) reaches the
// app through it, so this one must too, under the server's own name for it.
// Any OTHER rejection keeps the silent prune — `onRejected` is already the
// app's word on those, and reporting them twice would read as two problems.
import { assert, assertEquals } from "@std/assert";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import {
  createMemoryStorage,
  createOpBuffer,
} from "../../src/sync/op-buffer.ts";
import { normalizeSyncConfig, STALE_OP_REASON } from "../../src/sync/types.ts";
import type { SyncOp } from "../../src/sync/types.ts";

const CELL = "todos";

function makeClient() {
  const dropped: { op: SyncOp; reason: string }[] = [];
  const rejected: { opId: string; reason: string }[] = [];
  const buffer = createOpBuffer(createMemoryStorage(), {
    onDrop: (op, reason) => dropped.push({ op, reason }),
  });
  let confirmed: Record<string, unknown> = { items: [] };
  const engine = createSyncEngine({
    clientId: "phone",
    cells: {
      [CELL]: {
        ...normalizeSyncConfig(true),
        onRejected: (info) => rejected.push(info),
      },
    },
    buffer,
    send: () => {},
    reducer: (st) => st,
    getConfirmedState: () => ({ [CELL]: confirmed }),
    setConfirmedState: (_c, st) => {
      confirmed = st;
    },
    onStateUpdate: () => {},
    log: { warn: () => {}, debug: () => {} },
  });
  return { engine, buffer, dropped, rejected };
}

Deno.test("client: a stale-beyond-retention rejection drops the op through onDrop, once", async () => {
  const { engine, buffer, dropped, rejected } = makeClient();
  await engine.handleLocalAction(CELL, "add", { t: "milk" });
  const [op] = await buffer.getUnconfirmed(CELL);
  assert(op, "the local change is pending");

  const reason = `${STALE_OP_REASON}: this change is stamped 49h ago, older ` +
    `than the 24h this server keeps the record that tells a resend from a ` +
    `new change …`;
  await engine.handleRejection(CELL, op.id, reason);

  assertEquals(
    await buffer.getUnconfirmed(CELL),
    [],
    "the op must leave the buffer — or it is re-sent, and refused, on every reconnect",
  );
  assertEquals(dropped.length, 1, "the abandoned change reaches onDrop");
  assertEquals(dropped[0]!.op.id, op.id);
  assertEquals(
    dropped[0]!.reason,
    STALE_OP_REASON,
    "under the server's own name for it",
  );
  assertEquals(
    rejected,
    [{ opId: op.id, reason }],
    "and onRejected still fires",
  );

  // A duplicate rejection (a frame already in flight) reports nothing twice.
  await engine.handleRejection(CELL, op.id, reason);
  assertEquals(dropped.length, 1);
});

Deno.test("client: every other rejection keeps the silent prune", async () => {
  const { engine, buffer, dropped, rejected } = makeClient();
  await engine.handleLocalAction(CELL, "add", { t: "milk" });
  const [op] = await buffer.getUnconfirmed(CELL);
  await engine.handleRejection(CELL, op!.id, "access denied");
  assertEquals(await buffer.getUnconfirmed(CELL), []);
  assertEquals(dropped, [], "onRejected is the app's word on this one");
  assertEquals(rejected.length, 1);
});
