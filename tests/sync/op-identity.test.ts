// tests/sync/op-identity.test.ts — an op's identity must be unique for ALL
// time, not just for the session that issued it.
//
// `clientId` is PERSISTED (localStorage — the HLC node id has to survive a
// reload) while the per-op counter lives in the engine instance. Composing an
// id out of one durable half and one volatile half meant every page load
// started re-issuing the previous session's op ids — and the server's op-id
// dedup did exactly what it is built to do: recognised the id, skipped the
// dispatch, and ACKED. The client confirmed the op and dropped it. Every
// mutation of a new session vanished, silently, until the counter climbed past
// the previous session's high mark.
import { assert, assertEquals } from "@std/assert";
import {
  createOpBuffer,
  type OpBufferStorage,
} from "../../src/sync/op-buffer.ts";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";
import { createServerSyncHandler } from "../../src/sync/server-handler.ts";
import { _resetServerTsForTest } from "../../src/sync/server-store.ts";
import { createMemoryStorage } from "./_memory-storage.ts";
import { createTestDb, recordingSocket, until } from "./_test-db.ts";

const CELL = "notes";
const silentLog = { debug: () => {}, warn: () => {}, error: () => {} };

/** An engine on a GIVEN storage — a reload keeps the storage and the clientId
 *  and starts a brand-new engine, which is exactly the pairing under test. */
function reloadEngine(storage: OpBufferStorage, sent: string[]) {
  let confirmed: Record<string, unknown> = { items: [] };
  const engine = createSyncEngine({
    clientId: "persisted-client",
    cells: { [CELL]: normalizeSyncConfig(true) },
    buffer: createOpBuffer(storage),
    send: (m) => sent.push(m),
    reducer: (s, action, payload) =>
      action === "add"
        ? { ...s, items: [...(s.items as string[] ?? []), payload as string] }
        : s,
    getConfirmedState: () => ({ [CELL]: confirmed }),
    setConfirmedState: (_c, s) => {
      confirmed = s;
    },
    onStateUpdate: () => {},
  });
  return { engine, confirmed: () => confirmed };
}

Deno.test("op ids never repeat across a client reload", async () => {
  const storage = createMemoryStorage(); // localStorage survives the reload
  const sent: string[] = [];

  const first = reloadEngine(storage, sent);
  await first.engine.handleLocalAction(CELL, "add", "before-reload");

  const second = reloadEngine(storage, sent); // ← page reload
  await second.engine.handleLocalAction(CELL, "add", "after-reload");

  const ids = sent.map((m) => (JSON.parse(m).d as { id: string }).id);
  assertEquals(new Set(ids).size, ids.length, `op ids collided: ${ids}`);
});

Deno.test("a write made after a reload is not swallowed by the server's op-id dedup", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    let serverState: Record<string, unknown> = { items: [] };
    const handler = createServerSyncHandler({
      dispatch: (a) => {
        const payload = (a as { payload?: unknown }).payload;
        serverState = {
          items: [...(serverState.items as string[]), payload as string],
        };
      },
      db,
      syncCellIds: [CELL],
      getCellState: () => serverState,
      getClientCellState: () => serverState,
      broadcastRaw: { fn: () => {} },
      log: silentLog,
    });
    const { socket, frames } = recordingSocket();

    const storage = createMemoryStorage();
    const sent: string[] = [];

    // Session 1: one op, delivered and applied.
    const s1 = reloadEngine(storage, sent);
    await s1.engine.handleLocalAction(CELL, "add", "before-reload");
    await handler.handleOp(JSON.parse(sent[0]!).d, { id: "conn1" }, socket);

    // Session 2 (reload): a DIFFERENT op, same persisted client identity.
    const s2 = reloadEngine(storage, sent);
    await s2.engine.handleLocalAction(CELL, "add", "after-reload");
    await handler.handleOp(JSON.parse(sent[1]!).d, { id: "conn2" }, socket);

    await until(
      () => frames.filter((f) => f.t === "sync-ack").length >= 2,
      "both ops acked",
    );
    assertEquals(
      serverState.items,
      ["before-reload", "after-reload"],
      "the post-reload write must reach the server — a colliding op id makes " +
        "it a 'duplicate', which is acked but never applied",
    );

    // …and the client is told it landed, so nothing anywhere would report it.
    const acks = frames.filter((f) => f.t === "sync-ack");
    assertEquals(acks.length, 2, "both ops acked");
    assert(
      acks[0]!.d.opId !== acks[1]!.d.opId,
      "the two acks must be for two different ops",
    );
  } finally {
    close();
  }
});
