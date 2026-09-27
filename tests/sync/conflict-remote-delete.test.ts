// `onConflict` reports a field the remote op DELETED while a pending local op
// still sets it.
//
// The conflict walk iterated only the keys of the post-op state, so a field the
// peer removed (`delete s.draft`) was never looked at: the local edit silently
// resurrected or lost it depending on replay order, with no callback.
import { assertEquals } from "@std/assert";
import {
  createMemoryStorage,
  createOpBuffer,
} from "../../src/sync/op-buffer.ts";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import type { SyncConflict } from "../../src/sync/types.ts";

const CELL = "doc";

Deno.test("conflicts: a field the remote op deleted is reported", async () => {
  let confirmed: Record<string, unknown> = { draft: "v0", n: 0 };
  const conflicts: SyncConflict[] = [];
  const engine = createSyncEngine({
    clientId: "A",
    cells: {
      [CELL]: {
        merge: {},
        identity: {},
        offline: { retention: "4h" },
        onConflict: (c: SyncConflict[]) => conflicts.push(...c),
      } as never,
    },
    buffer: createOpBuffer(createMemoryStorage()),
    send: () => {},
    reducer: (state, action, payload) => {
      if (action === "set") return { ...state, ...(payload as object) };
      if (action === "drop") {
        const { [payload as string]: _gone, ...rest } = state;
        return rest;
      }
      return null;
    },
    getConfirmedState: () => ({ [CELL]: confirmed }),
    setConfirmedState: (_cell, s) => {
      confirmed = s;
    },
    onStateUpdate: () => {},
  });
  engine.setOnline(true);
  try {
    await engine.handleLocalAction(CELL, "set", { draft: "mine" });
    await engine.handleRemoteOp({
      id: "PEER-1",
      cell: CELL,
      action: "drop",
      payload: "draft",
      hlc: [Date.now() + 5, 0, "B"],
      confirmed: true,
      serverTs: 1,
    });
    assertEquals(
      conflicts,
      [{ field: "draft", local: "mine", remote: undefined, resolution: "lww" }],
    );
  } finally {
    engine.setOnline(false);
  }
});
