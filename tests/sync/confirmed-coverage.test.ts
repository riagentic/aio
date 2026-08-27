// tests/sync/confirmed-coverage.test.ts — two losses the extended chaos suite
// found (2026-08-27), pinned here as ordinary regressions.
//
// (1) A catch-up hands a client its OWN ops back whenever that cell's cursor is
//     still 0 (`rebuilding` in handleSync — the page-reload case). Acks
//     deliberately do not advance the cursor, so a LIVE client that acked an op
//     before its first response for that cell landed got the op back — and
//     `foldCatchupOp`'s own-op guard only covers ops still awaiting an ack.
//     Applied twice, silently.
//
// (2) `reserveServerTs` returns the log's HIGH WATER, not a fresh position, so
//     two catch-ups reserved before the same write quote the SAME watermark.
//     Installing the second snapshot threw away every op folded above it in
//     between: the op was on the server and on every peer, and gone here.
import { assertEquals } from "@std/assert";
import {
  createMemoryStorage,
  createOpBuffer,
} from "../../src/sync/op-buffer.ts";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import type { HLC, SyncOp } from "../../src/sync/types.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";

const CELL = "cell";

function makeEngine() {
  const buffer = createOpBuffer(createMemoryStorage());
  let confirmed: Record<string, unknown> = { log: [] };
  const sent: string[] = [];
  const engine = createSyncEngine({
    clientId: "me",
    cells: { [CELL]: normalizeSyncConfig(true) },
    buffer,
    send: (m) => sent.push(m),
    reducer: (s, _a, p) => ({
      log: [...(s.log as string[]), (p as { id: string }).id],
    }),
    getConfirmedState: () => ({ [CELL]: confirmed }),
    setConfirmedState: (_c, s) => {
      confirmed = s;
    },
    onStateUpdate: () => {},
    log: { warn: () => {}, debug: () => {} },
  });
  return { engine, buffer, sent, log: () => confirmed.log as string[] };
}

const peer = (id: string, ts: number): SyncOp => ({
  id,
  cell: CELL,
  action: "add",
  payload: { id },
  hlc: [1000 + ts, 0, "peer"] as HLC,
  confirmed: true,
  serverTs: ts,
});

Deno.test("an own op the catch-up hands back after its ack is not applied twice", async () => {
  const { engine, sent, log } = makeEngine();

  await engine.handleLocalAction(CELL, "add", { id: "mine" });
  const frame = sent.map((m) => JSON.parse(m)).findLast((m) => m.t === "op")!;
  // The ack lands: the op enters confirmed state, exactly once.
  await engine.handleAck(CELL, frame.d.id, [2000, 0, "server"], 50);
  assertEquals(log(), ["mine"]);

  // The cursor is still 0 (acks never advance it), so the server treats this
  // client as rebuilding and echoes its own ops back.
  await engine.handleSyncResponse({
    mode: "incremental",
    ops: [{
      id: frame.d.id,
      cell: CELL,
      action: "add",
      payload: { id: "mine" },
      hlc: frame.d.hlc,
      confirmed: true,
      serverTs: 50,
    }],
    lowWater: {},
    lastServerTs: { [CELL]: 50 },
  });
  assertEquals(
    log(),
    ["mine"],
    "an op already folded by its ack must not be folded again by a catch-up",
  );
});

Deno.test("a snapshot at a watermark confirmed state already passed is ignored", async () => {
  const { engine, log } = makeEngine();

  // Catch-up #1: a snapshot reflecting everything up to position 100.
  await engine.handleSyncResponse({
    mode: "snapshot",
    snapshot: { [CELL]: { log: ["snapshot"] } },
    ops: [],
    lowWater: {},
    lastServerTs: { [CELL]: 100 },
  });
  // A peer op persisted AFTER that snapshot arrives and is folded on top.
  await engine.handleRemoteOp(peer("after", 101));
  assertEquals(log(), ["snapshot", "after"]);

  // Catch-up #2 was reserved before that op was persisted, so it quotes the
  // SAME watermark and carries the same, older state. Installing it would
  // delete "after" from this client and nothing would ever bring it back.
  await engine.handleSyncResponse({
    mode: "snapshot",
    snapshot: { [CELL]: { log: ["snapshot"] } },
    ops: [],
    lowWater: {},
    lastServerTs: { [CELL]: 100 },
  });
  assertEquals(
    log(),
    ["snapshot", "after"],
    "a snapshot that does not reach past confirmed state is a rollback",
  );
});

Deno.test("a snapshot that DOES advance the watermark is still installed", async () => {
  const { engine, log } = makeEngine();
  await engine.handleSyncResponse({
    mode: "snapshot",
    snapshot: { [CELL]: { log: ["v1"] } },
    ops: [],
    lowWater: {},
    lastServerTs: { [CELL]: 100 },
  });
  await engine.handleRemoteOp(peer("after", 101));
  await engine.handleSyncResponse({
    mode: "snapshot",
    snapshot: { [CELL]: { log: ["v2"] } },
    ops: [],
    lowWater: {},
    lastServerTs: { [CELL]: 200 },
  });
  assertEquals(log(), ["v2"], "a newer snapshot is the server's truth");
});
