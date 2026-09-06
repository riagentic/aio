// tests/sync/reducer-failure.test.ts — M1 regression.
//
// `markApplied()` ran BEFORE the reducer, and the browser reducer mapped a
// reducer THROW onto `null` — the same value the engine reads as "applied,
// changed nothing". So a reducer error marked the op applied AND advanced the
// cursor past it: the server had the op, the client never would, and no
// re-delivery could ever fix it. The mark belongs after a successful fold, and
// a failure needs a value of its own (REDUCER_FAILED).
import { assert, assertEquals } from "@std/assert";
import { captureConsoleAsync } from "../console-capture.ts";
import {
  createMemoryStorage,
  createOpBuffer,
} from "../../src/sync/op-buffer.ts";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import {
  REDUCER_FAILED,
  type SyncReducerResult,
} from "../../src/sync/rebase.ts";
import type { HLC, SyncOp } from "../../src/sync/types.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";

const CELL = "cell";

function makeEngine(
  reduce: (
    s: Record<string, unknown>,
    action: string,
    payload: unknown,
  ) => SyncReducerResult,
) {
  const buffer = createOpBuffer(createMemoryStorage());
  let confirmed: Record<string, unknown> = { count: 0 };
  const errors: string[] = [];
  const engine = createSyncEngine({
    clientId: "me",
    cells: { [CELL]: normalizeSyncConfig(true) },
    buffer,
    send: () => {},
    reducer: (s, a, p) => reduce(s, a, p),
    getConfirmedState: () => ({ [CELL]: confirmed }),
    setConfirmedState: (_c, s) => {
      confirmed = s;
    },
    onStateUpdate: () => {},
    log: { warn: (m) => errors.push(m), debug: () => {} },
  });
  return { engine, buffer, confirmed: () => confirmed, errors };
}

const peerOp = (id: string, ts: number): SyncOp => ({
  id,
  cell: CELL,
  action: "bump",
  payload: { id },
  hlc: [1000 + ts, 0, "peer"] as HLC,
  confirmed: true,
  serverTs: ts,
});

Deno.test("M1: a failed fold does not mark the op applied — a re-delivery still applies it", async () => {
  let failing = true;
  const { engine, confirmed } = makeEngine((s, _a, _p) =>
    failing ? REDUCER_FAILED : { count: ((s.count as number) ?? 0) + 1 }
  );

  await engine.handleRemoteOp(peerOp("x", 10));
  assertEquals(confirmed().count, 0, "nothing applied while the reducer fails");

  // The app is fixed / the transport re-delivers the op (a duplicated
  // broadcast, or the next catch-up). It MUST still be applyable.
  failing = false;
  await engine.handleRemoteOp(peerOp("x", 10));
  assertEquals(
    confirmed().count,
    1,
    "an op whose fold failed must not be remembered as applied",
  );
});

Deno.test("M1: a successful fold IS marked applied — duplicates still deduped", async () => {
  const { engine, confirmed } = makeEngine((s) => ({
    count: ((s.count as number) ?? 0) + 1,
  }));
  await engine.handleRemoteOp(peerOp("y", 11));
  await engine.handleRemoteOp(peerOp("y", 11));
  assertEquals(confirmed().count, 1, "duplicate broadcast still applies once");
});

Deno.test("M1: `null` stays the no-op contract — applied, marked, deduped", async () => {
  let calls = 0;
  const { engine } = makeEngine(() => {
    calls++;
    return null;
  });
  await engine.handleRemoteOp(peerOp("z", 12));
  await engine.handleRemoteOp(peerOp("z", 12));
  assertEquals(calls, 1, "a no-op op is applied once and then deduped");
});

Deno.test("M1: a failed fold in a catch-up batch does not advance the cursor", async () => {
  // The cursor is the only thing that can bring the op back. Advancing it past
  // an op the client never applied is permanent, silent divergence.
  const { engine, buffer, confirmed } = makeEngine((s, _a, p) =>
    (p as { id: string }).id === "bad"
      ? REDUCER_FAILED
      : { count: ((s.count as number) ?? 0) + 1 }
  );
  await engine.handleSyncResponse({
    mode: "incremental",
    ops: [peerOp("good", 20), peerOp("bad", 21)],
    lowWater: {},
    lastServerTs: { [CELL]: 21 },
  });
  assertEquals(confirmed().count, 1, "the applyable op still applied");
  const meta = await buffer.getMeta(CELL);
  assert(
    (meta?.lastServerTs ?? 0) < 21,
    `cursor must not pass an op that failed to fold (got ${meta?.lastServerTs})`,
  );

  // Next catch-up re-delivers it, and now it lands.
  await engine.handleSyncResponse({
    mode: "incremental",
    ops: [peerOp("bad", 21)],
    lowWater: {},
    lastServerTs: { [CELL]: 21 },
  });
  assertEquals(confirmed().count, 1, "still failing — still not applied");
});

Deno.test("M1: a failed fold is reported, never silent", async () => {
  const { engine } = makeEngine(() => REDUCER_FAILED);
  const lines = await captureConsoleAsync(async () => {
    await engine.handleRemoteOp(peerOp("loud", 30));
  });
  assert(
    lines.some((m) => m.includes("loud") && m.includes(CELL)),
    `the failure must name the cell and the op — got ${JSON.stringify(lines)}`,
  );
});

// The FOURTH fold path. Ack, catch-up and broadcast each report a fold they
// could not apply; rebase — replaying the client's OWN unconfirmed ops — put
// the fact in `RebaseResult.dropped`, which no caller read. So a sync method
// that cannot replay its own payload lost the user's unsent change from the
// optimistic view, stopped being counted in `pending`, and said nothing.
Deno.test("M1: a fold that fails during REBASE is reported too", async () => {
  // succeeds for the peer's op, fails for the client's own queued one
  const { engine, buffer } = makeEngine((s, action) =>
    action === "mine" ? REDUCER_FAILED : { ...s, seen: true }
  );
  await buffer.add({
    id: "own-op",
    cell: CELL,
    action: "mine",
    payload: {},
    hlc: [1, 0, "me"] as HLC,
    confirmed: false,
  });
  // any remote op rebases the cell over the unconfirmed queue
  const lines = await captureConsoleAsync(async () => {
    await engine.handleRemoteOp(peerOp("peer-1", 40));
  });
  assert(
    lines.some((m) => m.includes("own-op") && m.includes("rebase")),
    `the rebase failure must name the op and the path — got ${
      JSON.stringify(lines)
    }`,
  );
});

// …and a `null` no-op during rebase is the contract working, not a failure.
Deno.test("M1: a null no-op during REBASE stays silent", async () => {
  const { engine, buffer } = makeEngine((s, action) =>
    action === "mine" ? null : { ...s, seen: true }
  );
  await buffer.add({
    id: "own-noop",
    cell: CELL,
    action: "mine",
    payload: {},
    hlc: [1, 0, "me"] as HLC,
    confirmed: false,
  });
  const quiet = await captureConsoleAsync(async () => {
    await engine.handleRemoteOp(peerOp("peer-2", 41));
  });
  assertEquals(
    quiet.filter((m) => m.includes("own-noop")),
    [],
    "a documented no-op must not be reported as a broken reducer",
  );
});

// `SyncStatus.pending` is documented as "Ops still waiting for an ack". It was
// set from `rebase().surviving.length` — ops that FOLDED cleanly, a different
// fact — so every op the reducer answered with the documented `null` no-op was
// missing from the count while it sat in the buffer awaiting its ack.
Deno.test("M1: pending counts ops awaiting an ack, including a no-op's", async () => {
  const { engine, buffer } = makeEngine((s, action) =>
    action === "mine" ? null : { ...s, seen: true }
  );
  for (const id of ["n1", "n2"]) {
    await buffer.add({
      id,
      cell: CELL,
      action: "mine",
      payload: {},
      hlc: [1, 0, "me"] as HLC,
      confirmed: false,
    });
  }
  await engine.handleRemoteOp(peerOp("peer-3", 42));
  assertEquals(
    engine.getStatus(CELL).pending,
    2,
    "two unconfirmed ops are waiting for an ack, whatever the reducer did with them",
  );
});
