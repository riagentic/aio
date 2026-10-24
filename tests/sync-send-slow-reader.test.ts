// The sync handler's `sendTo` closed a peer that WAS reading, just slowly.
//
// After a socket's first `sync-res`, every later frame (an op's ack or
// refusal, a legacy client's server-write push) closed the peer on bytes
// alone: over `SYNC_SOCKET_HIGH_WATER` unread → 1013 "not draining". A client
// on a ~1 MB/s link with a 6 MB state is over the mark for ~6 s while the
// handshake frame drains, so the first op it sent in that time closed it — it
// reconnected and re-downloaded the whole state. `broadcastRaw` already
// learned the drain rule (tests/ws-raw-broadcast-slow-reader.test.ts); this is
// the same rule — ONE decider — on the other writer to the same sockets. A
// peer that reads nothing is still closed, within bounded bytes and time.
import { assert, assertEquals } from "@std/assert";
import {
  createServerSyncHandler,
  notDraining,
  SYNC_SOCKET_HIGH_WATER,
} from "../src/sync/server-handler.ts";
import { createTestDb } from "./sync/_test-db.ts";
import type { HLC } from "../src/sync/types.ts";

const CELL = "notes";
const macro = () => new Promise<void>((r) => setTimeout(r, 20));

function fakeSocket(held: number) {
  const sent: string[] = [];
  const closes: number[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: held,
    send: (m: string) => sent.push(m),
    close: (code: number) => closes.push(code),
  };
  return { socket, ws: socket as unknown as WebSocket, sent, closes };
}

function rig() {
  const { db, close } = createTestDb();
  const handler = createServerSyncHandler({
    dispatch: () => {},
    db,
    syncCellIds: [CELL],
    getCellState: () => ({ items: [] }),
    getClientCellState: () => ({ items: [] }),
    broadcastRaw: { fn: () => {} },
    log: { debug: () => {}, warn: () => {}, error: () => {} },
  });
  return { handler, close };
}

/** An op the server refuses at once (unknown cell) — one `sendTo` per call. */
let n = 0;
const op = () => ({
  id: `op${++n}`,
  hlc: [Date.now(), 0, "c1"] as HLC,
  cell: "nope",
  action: "add",
  payload: {},
});

/** A peer whose handshake state (6 MB) is still draining has had its first
 *  catch-up answered. */
async function answered(r: ReturnType<typeof rig>) {
  const p = fakeSocket(6 * 1024 * 1024);
  r.handler.handleSync(
    { clientId: "c1", cells: { [CELL]: {} }, pendingOps: [] },
    { id: "c1" },
    p.ws,
  );
  await macro();
  assert(p.sent.some((m) => m.includes('"t":"sync-res"')));
  return p;
}

Deno.test("sync sendTo: a slow-but-reading peer over the mark gets its op answer, not a close", async () => {
  const r = rig();
  try {
    const p = await answered(r);
    await r.handler.handleOp(op(), { id: "c1" }, p.ws);
    p.socket.bufferedAmount -= 1024 * 1024; // it reads…
    await r.handler.handleOp(op(), { id: "c1" }, p.ws);
    assertEquals(
      p.closes,
      [],
      "a peer draining its handshake state was closed on bytes alone",
    );
    assertEquals(
      p.sent.filter((m) => m.includes('"t":"op-rejected"')).length,
      2,
    );
  } finally {
    r.close();
  }
});

Deno.test("sync sendTo: a peer that reads nothing is closed once its backlog grows a whole mark", async () => {
  const r = rig();
  try {
    const p = await answered(r);
    await r.handler.handleOp(op(), { id: "c1" }, p.ws);
    assertEquals(p.closes, []);
    p.socket.bufferedAmount += SYNC_SOCKET_HIGH_WATER + 1;
    await r.handler.handleOp(op(), { id: "c1" }, p.ws);
    assertEquals(p.closes, [1013]);
  } finally {
    r.close();
  }
});

Deno.test("sync sendTo: a peer whose backlog stops falling is closed after the stall window", async () => {
  const r = rig();
  const realNow = Date.now;
  try {
    const p = await answered(r);
    await r.handler.handleOp(op(), { id: "c1" }, p.ws);
    assertEquals(p.closes, []);
    const t = realNow();
    Date.now = () => t + 60_000; // past 5 s + 6 MB at the minimum drain rate
    await r.handler.handleOp(op(), { id: "c1" }, p.ws);
    assertEquals(p.closes, [1013]);
  } finally {
    Date.now = realNow;
    r.close();
  }
});

// `sendTo` and `broadcastRaw` write to the same sockets and used to keep ONE
// low-backlog memo EACH: a rarely-sending writer judged the peer by a low it
// saw a minute ago and closed (1013) a peer that had drained in between —
// seen only by the other writer. One shared memo now.
Deno.test("sync sendTo: a drain seen by the other writer (broadcastRaw) is not a stall", async () => {
  const r = rig();
  const realNow = Date.now;
  try {
    const p = await answered(r);
    const t = realNow();
    await r.handler.handleOp(op(), { id: "c1" }, p.ws); // low = 6 MB at t
    // broadcastRaw's own check, the moment it saw the peer back under the mark
    assertEquals(notDraining(p.ws, 0, t + 1_000), false);
    Date.now = () => t + 60_000; // over the mark again, a minute later
    await r.handler.handleOp(op(), { id: "c1" }, p.ws);
    assertEquals(p.closes, [], "closed on a low the other writer saw drain");
  } finally {
    Date.now = realNow;
    r.close();
  }
});

Deno.test("broadcastRaw keeps no drain memo of its own", async () => {
  const src = await Deno.readTextFile(
    new URL("../src/server/server-broadcast.ts", import.meta.url),
  );
  assertEquals(
    /WeakMap<object, \{ bytes: number; at: number \}>/.test(src),
    false,
  );
  assert(src.includes("notDraining(ws, ws.bufferedAmount, now)"));
});
