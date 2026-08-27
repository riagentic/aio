// tests/sync/response-per-cell-isolation.test.ts — M2 regression.
//
// `handleSyncResponse` folded every cell in one unguarded loop, so a throw
// while applying cell A's ops escaped the whole method: every LATER cell was
// skipped, and so was the trailing cursor-advance loop — for all cells. One
// bad cell took the entire catch-up down, and the response is consumed and
// unrepeatable: whatever the other cells were owed is only re-delivered
// because their cursors happened not to move. Wrap the fold per cell.
import { assert, assertEquals } from "@std/assert";
import { captureConsoleAsync } from "../console-capture.ts";
import {
  createMemoryStorage,
  createOpBuffer,
} from "../../src/sync/op-buffer.ts";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import type { HLC, SyncOp } from "../../src/sync/types.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";

const A = "alpha";
const B = "beta";

const op = (id: string, cell: string, ts: number): SyncOp => ({
  id,
  cell,
  action: "bump",
  payload: { id },
  hlc: [1000 + ts, 0, "peer"] as HLC,
  confirmed: true,
  serverTs: ts,
});

function makeEngine(explodeOn: string) {
  const buffer = createOpBuffer(createMemoryStorage());
  const confirmed: Record<string, Record<string, unknown>> = {
    [A]: { count: 0 },
    [B]: { count: 0 },
  };
  const engine = createSyncEngine({
    clientId: "me",
    cells: { [A]: normalizeSyncConfig(true), [B]: normalizeSyncConfig(true) },
    buffer,
    send: () => {},
    reducer: (s) => ({ count: ((s.count as number) ?? 0) + 1 }),
    getConfirmedState: () => confirmed,
    setConfirmedState: (cell, s) => {
      if (cell === explodeOn) throw new Error("storage exploded");
      confirmed[cell] = s;
    },
    onStateUpdate: () => {},
    log: { warn: () => {}, debug: () => {} },
  });
  return { engine, buffer, confirmed };
}

Deno.test("M2: a cell that throws does not truncate the rest of the response", async () => {
  const { engine, buffer, confirmed } = makeEngine(A);
  const lines = await captureConsoleAsync(async () => {
    await engine.handleSyncResponse({
      mode: "incremental",
      // A is iterated first (insertion order) and throws.
      ops: [op("a1", A, 10), op("b1", B, 11)],
      lowWater: {},
      lastServerTs: { [A]: 10, [B]: 11 },
    });
  });

  assertEquals(
    confirmed[B],
    { count: 1 },
    "a later cell must still be folded when an earlier one throws",
  );
  assertEquals(
    (await buffer.getMeta(B))?.lastServerTs,
    11,
    "the healthy cell's cursor must still advance",
  );
  assert(
    ((await buffer.getMeta(A))?.lastServerTs ?? 0) < 10,
    "the throwing cell's cursor must NOT advance — it is not covered",
  );
  assert(
    lines.some((l) => l.includes(A) && l.includes("storage exploded")),
    `the failure must name the cell and the cause — got ${
      JSON.stringify(lines)
    }`,
  );
});

Deno.test("M2: a cell that throws does not block the trailing cursor-advance loop", async () => {
  // Cells the server echoed a cursor for but delivered nothing are advanced in
  // a loop AFTER the fold — which a throw used to skip entirely.
  const { engine, buffer } = makeEngine(A);
  await captureConsoleAsync(async () => {
    await engine.handleSyncResponse({
      mode: "incremental",
      ops: [op("a2", A, 20)],
      lowWater: {},
      lastServerTs: { [A]: 20, [B]: 25 },
    });
  });
  assertEquals(
    (await buffer.getMeta(B))?.lastServerTs,
    25,
    "an echoed cursor for an undelivered cell must still be stored",
  );
});
