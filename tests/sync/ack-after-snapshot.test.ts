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

// ── The HELD-ack path: same question, one gate later ─────────────────────────
// `requestSync()` closes a catch-up gate; anything that would mutate confirmed
// state while it is shut is held and replayed when the response lands. The
// replay carried the snapshot's watermark to tell `foldAck` "already folded" —
// but it did so with `Math.min(h.serverTs ?? snapTs, snapTs)`, which CLAMPS a
// known serverTs down to the watermark. An op the server persisted AFTER the
// snapshot has a serverTs above it, which is exactly the op the snapshot does
// not contain: clamped, it was skipped, and the user's own write vanished.

Deno.test("held ack for an op NEWER than the snapshot still applies", async () => {
  const { engine, sent, confirmed } = setup();

  // 1. A local op goes out and the server persists it at cursor 101.
  await engine.handleLocalAction("todos", "add", { text: "kept" });
  const opId = (sent[0]!.d as { id: string }).id;

  // 2. The client asks to catch up — the gate closes here. `requestSync` awaits
  //    the buffer before arming, so let it reach that point before the ack.
  const req = engine.requestSync();
  await new Promise((r) => setTimeout(r, 0));

  // 3. The ack lands while the gate is shut, so it is HELD rather than applied.
  await engine.handleAck("todos", opId, [2000, 0, "s"], 101);
  assertEquals(
    (confirmed.todos!.items as unknown[]).length,
    0,
    "held, not applied — the response has not landed yet",
  );

  // 4. The response carries a snapshot taken BEFORE that op (cursor 100), so
  //    the snapshot cannot contain it.
  await engine.handleSyncResponse({
    mode: "snapshot",
    snapshot: { todos: { items: [] } },
    ops: [],
    lowWater: { todos: [1000, 0, "s"] },
    lastServerTs: { todos: 100 },
  });
  await req;

  assertEquals(
    confirmed.todos!.items,
    [{ text: "kept" }],
    "an op the snapshot predates must survive the held-ack replay",
  );
});

Deno.test("held ack for an op the snapshot DOES contain is still deduped", async () => {
  // The clamp existed for a reason — keep it working. Here serverTs (99) is at
  // or below the watermark (100), so the snapshot already brought the op in.
  const { engine, sent, confirmed } = setup();
  await engine.handleLocalAction("todos", "add", { text: "once" });
  const opId = (sent[0]!.d as { id: string }).id;
  const req = engine.requestSync();
  await new Promise((r) => setTimeout(r, 0));
  await engine.handleAck("todos", opId, [2000, 0, "s"], 99);
  await engine.handleSyncResponse({
    mode: "snapshot",
    snapshot: { todos: { items: [{ text: "once" }] } },
    ops: [],
    lowWater: { todos: [1000, 0, "s"] },
    lastServerTs: { todos: 100 },
  });
  await req;
  assertEquals(
    (confirmed.todos!.items as unknown[]).length,
    1,
    "exactly once — the snapshot's copy, not a second application",
  );
});
