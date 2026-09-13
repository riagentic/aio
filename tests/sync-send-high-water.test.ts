// The sync handler's per-socket sends honour the WS high-water mark.
//
// `broadcastRaw` learned it (tests/ws-raw-broadcast-backlog.test.ts): a peer
// holding more than `WS_BUFFER_HIGH_WATER` unread bytes is closed with 1013,
// because a raw frame cannot be skipped without a gap. The sync handler's own
// `sendTo` — every `sync-res`, op ack and refusal, and the whole-cell
// server-write push to a legacy client — never asked, so a sync peer that
// stopped reading had every one of them held on the server's heap.
import { assert, assertEquals } from "@std/assert";
import {
  createServerSyncHandler,
  SYNC_SOCKET_HIGH_WATER,
} from "../src/sync/server-handler.ts";
import { WS_BUFFER_HIGH_WATER } from "../src/server/write-backlog.ts";
import { createTestDb } from "./sync/_test-db.ts";

const CELL = "notes";

function fakeSocket(bufferedAmount: number) {
  const sent: string[] = [];
  const closes: { code?: number; reason?: string }[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    bufferedAmount,
    send: (m: string) => sent.push(m),
    close: (code?: number, reason?: string) => closes.push({ code, reason }),
  } as unknown as WebSocket;
  return { socket, sent, closes };
}

function rig() {
  const { db, close } = createTestDb();
  const warns: string[] = [];
  const handler = createServerSyncHandler({
    dispatch: () => {},
    db,
    syncCellIds: [CELL],
    getCellState: () => ({ items: [] }),
    getClientCellState: () => ({ items: [] }),
    broadcastRaw: { fn: () => {} },
    log: { debug: () => {}, warn: (m) => warns.push(m), error: () => {} },
  });
  return { handler, warns, close };
}

const macro = () => new Promise<void>((r) => setTimeout(r, 20));
const req = { clientId: "c1", cells: { [CELL]: {} }, pendingOps: [] };

Deno.test("sync sendTo: the high-water mark is the WS broadcaster's, not a second number", () => {
  assertEquals(SYNC_SOCKET_HIGH_WATER, WS_BUFFER_HIGH_WATER);
});

Deno.test("sync sendTo: a peer over the high-water mark is closed 1013, not written to; a draining one is answered", async () => {
  const r = rig();
  try {
    const stuck = fakeSocket(WS_BUFFER_HIGH_WATER + 1);
    r.handler.handleSync(req, { id: "c1" }, stuck.socket);
    await macro();
    assertEquals(
      stuck.sent.length,
      0,
      "nothing more may be queued for a peer that is not reading",
    );
    assertEquals(stuck.closes.length, 1, "the peer is closed so it resyncs");
    assertEquals(stuck.closes[0]!.code, 1013);
    assert(/not draining/.test(stuck.closes[0]!.reason ?? ""));
    assert(
      r.warns.some((w) => /not draining/.test(w) && /sync-res/.test(w)),
      `the close is said, naming the frame: ${JSON.stringify(r.warns)}`,
    );

    // Control: the same request on a peer that reads is answered normally.
    const ok = fakeSocket(1024);
    r.handler.handleSync({ ...req, clientId: "c2" }, { id: "c2" }, ok.socket);
    await macro();
    assertEquals(ok.closes.length, 0);
    assert(
      ok.sent.some((m) => m.includes('"t":"sync-res"')),
      `a draining peer gets its sync-res: ${JSON.stringify(ok.sent)}`,
    );
  } finally {
    r.close();
  }
});
