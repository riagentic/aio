// tests/sync/op-id-unguessable.test.ts — another client must not be able to
// take an op id this client has not issued yet.
//
// The server dedups by op id alone (`persistOp` INSERT OR IGNORE + the
// compaction tombstones): a known id is re-acked and NOT applied. Op ids were
// `clientId-session-<counter>`, and every op a client sends is broadcast to
// every peer with its id — so any other connected user could read the prefix
// and counter off one broadcast, submit an op of its own under the NEXT ids
// (to any sync cell it may write), and each later change of the victim then
// met a "duplicate": acked, confirmed on the victim's screen, never applied on
// the server. Silent loss of another user's writes, from any writer.
import { assert, assertEquals } from "@std/assert";
import { createOpBuffer } from "../../src/sync/op-buffer.ts";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";
import { createServerSyncHandler } from "../../src/sync/server-handler.ts";
import { _resetServerTsForTest } from "../../src/sync/server-store.ts";
import { createMemoryStorage } from "./_memory-storage.ts";
import { createTestDb, recordingSocket, until } from "./_test-db.ts";

const CELL = "notes";
const silentLog = { debug: () => {}, warn: () => {}, error: () => {} };

Deno.test("a peer cannot pre-empt this client's next op id and swallow its write", async () => {
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
    const victim = recordingSocket();
    const attacker = recordingSocket();

    let confirmed: Record<string, unknown> = { items: [] };
    const sent: string[] = [];
    const engine = createSyncEngine({
      clientId: "victim-client",
      cells: { [CELL]: normalizeSyncConfig(true) },
      buffer: createOpBuffer(createMemoryStorage()),
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

    // The victim's first op — the id every peer sees on the broadcast.
    await engine.handleLocalAction(CELL, "add", "first");
    const seen = JSON.parse(sent[0]!).d as { id: string };
    await handler.handleOp(seen, { id: "victim" }, victim.socket);

    // The attacker's best guess at the victim's next ids, from that one id:
    // same prefix, the next few counter values.
    const cut = seen.id.lastIndexOf("-");
    const prefix = seen.id.slice(0, cut + 1);
    const n = parseInt(seen.id.slice(cut + 1), 36);
    const guesses = Array.from(
      { length: 8 },
      (_, i) => `${prefix}${(n + 1 + i).toString(36)}`,
    );
    assertEquals(guesses.length, 8);
    for (const id of guesses) {
      await handler.handleOp(
        {
          id,
          cell: CELL,
          action: "add",
          payload: "evil",
          hlc: [Date.now(), 0, "x"],
        },
        { id: "attacker" },
        attacker.socket,
      );
    }

    // The victim's second op.
    await engine.handleLocalAction(CELL, "add", "second");
    const second = JSON.parse(sent[1]!).d as { id: string };
    await handler.handleOp(second, { id: "victim" }, victim.socket);
    await until(
      () => victim.frames.filter((f) => f.t === "sync-ack").length >= 2,
      "both victim ops acked",
    );
    assert(
      (serverState.items as string[]).includes("second"),
      `the victim's acked write never reached the server: ${
        JSON.stringify(serverState.items)
      }`,
    );
  } finally {
    close();
  }
});
