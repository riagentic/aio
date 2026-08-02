// Found while fixing one app's cursor gap: `handleAck` was the one confirmed-state
// mutator with no dedup. A `mode:"snapshot"` response installs the server's
// LIVE state — which already contains the client's own in-flight ops — and the
// ack for such an op then applied it a SECOND time.
//
// The client cannot dedup by id here (a snapshot never enumerates what it
// contains), so the server states the cursor its snapshot reflects and the ack
// carries the op's own cursor position; an ack at or below the watermark is
// already in confirmed state.
import { assertEquals } from "@std/assert";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";
import { createOpBuffer } from "../../src/sync/op-buffer.ts";
import { createMemoryStorage } from "./_memory-storage.ts";

/** An engine whose confirmed state is real (mutable), so double-application
 *  is observable. The reducer appends — applying an op twice shows up twice. */
function setup() {
  const sent: { t: string; d: Record<string, unknown> }[] = [];
  const confirmed: Record<string, Record<string, unknown>> = {
    todos: { items: [] },
  };
  const engine = createSyncEngine({
    clientId: "c1",
    cells: { todos: normalizeSyncConfig(true) },
    buffer: createOpBuffer(createMemoryStorage()),
    send: (msg: string) => sent.push(JSON.parse(msg)),
    reducer: (state, action, payload) =>
      action === "add"
        ? {
          ...state,
          items: [...((state.items as unknown[]) ?? []), payload],
        }
        : state,
    getConfirmedState: () => confirmed,
    setConfirmedState: (cell, state) => {
      confirmed[cell] = state as Record<string, unknown>;
    },
    onStateUpdate: () => {},
  });
  return { engine, sent, confirmed };
}

Deno.test("ack for an op the snapshot already contains does not double-apply", async () => {
  const { engine, sent, confirmed } = setup();

  // 1. Local op goes out; the server persists it at server_ts = 100.
  await engine.handleLocalAction("todos", "add", { text: "a" });
  const opId = (sent[0]!.d as { id: string }).id;

  // 2. A sync response lands FIRST, carrying the server's live state — which
  //    already includes that op — with the cursor it reflects.
  await engine.handleSyncResponse({
    mode: "snapshot",
    snapshot: { todos: { items: [{ text: "a" }] } },
    ops: [],
    lowWater: { todos: [1000, 0, "s"] },
    lastServerTs: { todos: 100 },
  });
  assertEquals(
    (confirmed.todos!.items as unknown[]).length,
    1,
    "the snapshot brought the op in exactly once",
  );

  // 3. …and only THEN does its ack arrive.
  await engine.handleAck("todos", opId, [2000, 0, "s"], 100);

  assertEquals(
    (confirmed.todos!.items as unknown[]).length,
    1,
    "the ack must not apply an op the snapshot already contained",
  );
});

Deno.test("ack for an op the snapshot does NOT contain still applies", async () => {
  const { engine, sent, confirmed } = setup();

  // A snapshot taken at cursor 100…
  await engine.handleSyncResponse({
    mode: "snapshot",
    snapshot: { todos: { items: [] } },
    ops: [],
    lowWater: { todos: [1000, 0, "s"] },
    lastServerTs: { todos: 100 },
  });

  // …then an op the server persisted AFTER it, at cursor 101.
  await engine.handleLocalAction("todos", "add", { text: "b" });
  const opId = (sent[0]!.d as { id: string }).id;
  await engine.handleAck("todos", opId, [2000, 0, "s"], 101);

  assertEquals(
    confirmed.todos!.items,
    [{ text: "b" }],
    "an op newer than the snapshot must still reach confirmed state",
  );
});

Deno.test("an ack without a serverTs keeps the pre-alpha43 behaviour", async () => {
  const { engine, sent, confirmed } = setup();
  await engine.handleLocalAction("todos", "add", { text: "c" });
  const opId = (sent[0]!.d as { id: string }).id;
  // No serverTs (duplicate re-ack, or an older server) → apply as before.
  await engine.handleAck("todos", opId, [2000, 0, "s"]);
  assertEquals(confirmed.todos!.items, [{ text: "c" }]);
});
