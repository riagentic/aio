// tests/sync/catchup-under-snapshot.test.ts
//
// A snapshot IS the server's live state at a reserved cursor position, so it
// contains every op at or below that position — and it never enumerates them,
// so the engine's op-id dedup set is empty for all of them. Three paths fold
// something into confirmed state and each has to ask the snapshot watermark
// whether the fold is already done:
//
//   • an ACK for an op the snapshot carried      (`foldAck`)
//   • a HELD broadcast that the snapshot carried (the "held under snapshot"
//     branch of `handleSyncResponse`)
//   • the OPS OF A CATCH-UP RESPONSE             ← this file
//
// The third had no such check. It is reachable exactly where the `reqId`
// machinery says two catch-ups can overlap — a reconnect while a manual
// `requestSync()` is outstanding: request #1 is answered with a snapshot at
// position S, request #2 carried the OLDER cursor and is answered
// incrementally with the very ops that snapshot folded in. Both responses are
// legitimate, both are for this client, and folding #2's ops on top of #1's
// snapshot applied each of them a second time — permanently, on the client
// only, with the server and every peer correct.
//
// Found by the chaos suite (seed 1738) on 2026-08-27; pinned deterministically
// here so the rule cannot regress without a red unit test.
import { assertEquals } from "@std/assert";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";
import type { SyncOp } from "../../src/sync/types.ts";
import { createOpBuffer } from "../../src/sync/op-buffer.ts";
import { createMemoryStorage } from "./_memory-storage.ts";

/** Confirmed state is a real append-only journal, so a double-apply is
 *  visible as a repeated id rather than an invisible idempotent re-write. */
function setup() {
  const sent: { t: string; d: Record<string, unknown> }[] = [];
  const confirmed: Record<string, Record<string, unknown>> = {
    todos: { journal: [] },
  };
  const engine = createSyncEngine({
    clientId: "c1",
    cells: { todos: normalizeSyncConfig(true) },
    buffer: createOpBuffer(createMemoryStorage()),
    send: (msg: string) => sent.push(JSON.parse(msg)),
    reducer: (state, _action, payload) => ({
      ...state,
      journal: [
        ...((state.journal as string[]) ?? []),
        (payload as { id: string }).id,
      ],
    }),
    getConfirmedState: () => confirmed,
    setConfirmedState: (cell, state) => {
      confirmed[cell] = state as Record<string, unknown>;
    },
    onStateUpdate: () => {},
  });
  return { engine, sent, confirmed };
}

const peerOp = (id: string, serverTs: number): SyncOp => ({
  id,
  cell: "todos",
  action: "add",
  payload: { id },
  hlc: [1000 + serverTs, 0, "peer"],
  confirmed: true,
  serverTs,
});

const journal = (c: Record<string, Record<string, unknown>>): string[] =>
  (c.todos!.journal as string[]) ?? [];

Deno.test("catch-up: ops an installed snapshot already contains are not re-applied", async () => {
  const { engine, confirmed } = setup();

  // Response #1 — a snapshot at position 200. It already contains p1 (ts 90)
  // and p2 (ts 200): a snapshot is state, not a list, so nothing about it
  // tells the client WHICH ops it folded.
  await engine.handleSyncResponse({
    mode: "snapshot",
    reqId: 1,
    snapshot: { todos: { journal: ["p1", "p2"] } },
    ops: [],
    lowWater: { todos: [1200, 0, "s"] },
    lastServerTs: { todos: 200 },
  });
  assertEquals(journal(confirmed), ["p1", "p2"]);

  // Response #2 — answering the request that went out with the OLD cursor,
  // so it carries the same two ops incrementally. Both sit at or below the
  // snapshot's watermark: they are already in confirmed state.
  await engine.handleSyncResponse({
    mode: "incremental",
    reqId: 2,
    ops: [peerOp("p1", 90), peerOp("p2", 200)],
    lowWater: { todos: [1200, 0, "s"] },
    lastServerTs: { todos: 200 },
  });

  assertEquals(
    journal(confirmed),
    ["p1", "p2"],
    "ops at or below the installed snapshot's watermark must not be folded again",
  );
});

Deno.test("catch-up: an op ABOVE the snapshot watermark is still applied", async () => {
  const { engine, confirmed } = setup();

  await engine.handleSyncResponse({
    mode: "snapshot",
    reqId: 1,
    snapshot: { todos: { journal: ["p1"] } },
    ops: [],
    lowWater: { todos: [1100, 0, "s"] },
    lastServerTs: { todos: 100 },
  });

  // ts 150 > watermark 100 — persisted AFTER the snapshot was captured, so it
  // is precisely the op the snapshot does NOT contain. Skipping it would be
  // the mirror-image bug (silent loss), which is why the guard is a position
  // comparison and not "a snapshot is installed, drop everything".
  await engine.handleSyncResponse({
    mode: "incremental",
    reqId: 2,
    ops: [peerOp("p2", 150)],
    lowWater: { todos: [1150, 0, "s"] },
    lastServerTs: { todos: 150 },
  });

  assertEquals(journal(confirmed), ["p1", "p2"]);
});

Deno.test("catch-up: an op that cannot state its position is folded as before", async () => {
  const { engine, confirmed } = setup();

  await engine.handleSyncResponse({
    mode: "snapshot",
    reqId: 1,
    snapshot: { todos: { journal: ["p1"] } },
    ops: [],
    lowWater: { todos: [1100, 0, "s"] },
    lastServerTs: { todos: 100 },
  });

  // No serverTs — a pre-alpha43 server. Unknown position is never guessed at:
  // the op is folded, exactly as it was before the watermark existed.
  const bare = { ...peerOp("p2", 0) } as SyncOp;
  delete bare.serverTs;
  await engine.handleSyncResponse({
    mode: "incremental",
    reqId: 2,
    ops: [bare],
    lowWater: { todos: [1150, 0, "s"] },
  });

  assertEquals(journal(confirmed), ["p1", "p2"]);
});
