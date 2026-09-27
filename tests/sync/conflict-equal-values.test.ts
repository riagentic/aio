// `onConflict` fires only for a real disagreement.
//
// `docs/persistence/crdt.md`: lww "Fires `onConflict` when values differ." The
// engine reported every field that a remote op changed and a pending local op
// also changed — including when both sides wrote the SAME value (two people
// ticking the same todo done). An app that prompts "resolve this conflict"
// then shows two identical options for a collision nobody lost anything in,
// and `SyncStats.conflicts` counts it.
import { assertEquals } from "@std/assert";
import {
  createMemoryStorage,
  createOpBuffer,
} from "../../src/sync/op-buffer.ts";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import type { SyncConflict } from "../../src/sync/types.ts";

const CELL = "doc";

Deno.test("conflicts: both sides writing the same value is not a conflict", async () => {
  let confirmed: Record<string, unknown> = { done: false, tags: [] };
  const conflicts: SyncConflict[] = [];
  const engine = createSyncEngine({
    clientId: "A",
    cells: {
      [CELL]: {
        // A merge strategy on an equal value merges to that value: no
        // conflict either.
        merge: { tags: "set-add" },
        identity: {},
        offline: { retention: "4h" },
        onConflict: (c: SyncConflict[]) => conflicts.push(...c),
      } as never,
    },
    buffer: createOpBuffer(createMemoryStorage()),
    send: () => {},
    reducer: (state, action, payload) =>
      action === "set" ? { ...state, ...(payload as object) } : null,
    getConfirmedState: () => ({ [CELL]: confirmed }),
    setConfirmedState: (_cell, s) => {
      confirmed = s;
    },
    onStateUpdate: () => {},
  });
  engine.setOnline(true);
  try {
    await engine.handleLocalAction(CELL, "set", { done: true, tags: ["x"] });
    await engine.handleRemoteOp({
      id: "PEER-1",
      cell: CELL,
      action: "set",
      payload: { done: true, tags: ["x"] },
      hlc: [Date.now() + 5, 0, "B"],
      confirmed: true,
      serverTs: 1,
    });
    assertEquals(conflicts, [], JSON.stringify(conflicts));
    // …while a real disagreement still is one.
    await engine.handleLocalAction(CELL, "set", { done: false });
    await engine.handleRemoteOp({
      id: "PEER-2",
      cell: CELL,
      action: "set",
      payload: { done: "later" },
      hlc: [Date.now() + 10, 0, "B"],
      confirmed: true,
      serverTs: 2,
    });
    assertEquals(conflicts.map((c) => c.field), ["done"]);
  } finally {
    engine.setOnline(false);
  }
});
