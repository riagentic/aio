// tests/sync/held-broadcast-above-snapshot.test.ts — H1 regression.
//
// A broadcast held behind the catch-up gate was DISCARDED whenever the
// response carried a snapshot, on the theory that "it reached us before the
// response, so the server applied it before capturing the snapshot". That
// holds only while one cell is in play. With two sync cells the response is
// built cell by cell, each under ITS OWN lock, so cell A's snapshot is taken
// (server_ts 100), A's lock is released, and the server then awaits B — and an
// op for A persisted in that window (server_ts 200) is broadcast, arrives
// FIRST on the FIFO connection, is held, and is then dropped by a response
// whose watermark is 100. The op is above the snapshot: it is exactly the op
// the snapshot does NOT contain.
//
// The ack branch six lines below already reasons correctly (`h.serverTs ??
// snapTs`, "a known serverTs ABOVE the watermark means the op was persisted
// AFTER the snapshot"); the op branch never got the same fix. Result: silent
// divergence that heals only at the next reconnect.
import { assertEquals } from "@std/assert";
import {
  createMemoryStorage,
  createOpBuffer,
} from "../../src/sync/op-buffer.ts";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import type { HLC, SyncOp } from "../../src/sync/types.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";

const A = "cellA";
const B = "cellB";

function reduceCell(
  s: Record<string, unknown>,
  action: string,
  payload: unknown,
): Record<string, unknown> {
  if (action === "bump") {
    const p = payload as { id: string };
    return {
      count: ((s.count as number) ?? 0) + 1,
      items: [...((s.items as string[]) ?? []), p.id],
    };
  }
  return s;
}

function makeEngine() {
  const buffer = createOpBuffer(createMemoryStorage());
  const confirmed: Record<string, Record<string, unknown>> = {
    [A]: { count: 0, items: [] },
    [B]: { count: 0, items: [] },
  };
  const sent: string[] = [];
  const engine = createSyncEngine({
    clientId: "me",
    cells: { [A]: normalizeSyncConfig(true), [B]: normalizeSyncConfig(true) },
    buffer,
    send: (m) => sent.push(m),
    reducer: (s, action, payload) => reduceCell(s, action, payload),
    getConfirmedState: () => confirmed,
    setConfirmedState: (cell, s) => {
      confirmed[cell] = s;
    },
    onStateUpdate: () => {},
    log: { warn: () => {}, debug: () => {} },
  });
  return { engine, buffer, confirmed, sent };
}

const peerOp = (
  id: string,
  cell: string,
  ts: number,
  hlcMs = 1000,
): SyncOp => ({
  id,
  cell,
  action: "bump",
  payload: { id: `p-${id}` },
  hlc: [hlcMs, 0, "peer"] as HLC,
  confirmed: true,
  serverTs: ts,
});

Deno.test("H1: a held broadcast ABOVE the snapshot watermark is applied, not dropped", async () => {
  const { engine, confirmed } = makeEngine();

  // The gate closes for BOTH cells (one sync-req covers every cell).
  await engine.requestSync();

  // Server snapshots A at server_ts 100, releases A's lock, awaits B. A peer's
  // op for A is persisted at 200 and broadcast — FIFO delivers it before the
  // response.
  await engine.handleRemoteOp(peerOp("above", A, 200));

  // The response lands: A's snapshot reflects server_ts 100 only.
  await engine.handleSyncResponse({
    mode: "snapshot",
    snapshot: { [A]: { count: 0, items: [] } },
    ops: [],
    lowWater: { [A]: [900, 0, "server"] as HLC },
    lastServerTs: { [A]: 100, [B]: 100 },
  });

  assertEquals(
    confirmed[A],
    { count: 1, items: ["p-above"] },
    "an op persisted AFTER the snapshot was taken must survive the response",
  );
});

Deno.test("H1: a held broadcast AT OR BELOW the watermark is still dropped (no double-apply)", async () => {
  const { engine, confirmed } = makeEngine();
  await engine.requestSync();

  // This op IS inside the snapshot the response carries (server_ts 40 ≤ 100) —
  // a snapshot cannot enumerate what it holds, so the id dedup cannot see it.
  await engine.handleRemoteOp(peerOp("inside", A, 40));

  await engine.handleSyncResponse({
    mode: "snapshot",
    snapshot: { [A]: { count: 1, items: ["p-inside"] } },
    ops: [],
    lowWater: { [A]: [900, 0, "server"] as HLC },
    lastServerTs: { [A]: 100 },
  });

  assertEquals(
    confirmed[A],
    { count: 1, items: ["p-inside"] },
    "an op the snapshot already contains must not be applied a second time",
  );
});

Deno.test("H1: a held broadcast with an UNKNOWN serverTs is dropped under a snapshot", async () => {
  // No position to compare — the pre-alpha43 shape. Dropping is the safe
  // reading (the next catch-up re-delivers it; the cursor only moves on a
  // response), and it is what the previous behaviour did for every op.
  const { engine, confirmed } = makeEngine();
  await engine.requestSync();
  const bare = { ...peerOp("bare", A, 0) };
  delete bare.serverTs;
  await engine.handleRemoteOp(bare);
  await engine.handleSyncResponse({
    mode: "snapshot",
    snapshot: { [A]: { count: 0, items: [] } },
    ops: [],
    lowWater: { [A]: [900, 0, "server"] as HLC },
    lastServerTs: { [A]: 100 },
  });
  assertEquals(confirmed[A], { count: 0, items: [] });
});
