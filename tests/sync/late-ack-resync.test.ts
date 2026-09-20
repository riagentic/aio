// tests/sync/late-ack-resync.test.ts — an ack that belongs to an EARLIER
// catch-up than the one that delivers it.
//
// Found by the r3 sync hunt (2026-09-19). A reconnect flushes the offline
// queue in slices when it is bigger than the server's frame budget, and the
// server never echoes a client's own ops back in a catch-up — they are
// supposed to come through their acks. So:
//
//   1. op x (cell b) is applied on the server; its ack dies with the socket;
//   2. offline, the user edits cell a; a peer's op lands in b after x;
//   3. the reconnect's first slice carries only the cell-a op (it fills the
//      budget), so x is not re-acked in that round — but the response serves
//      b's log without x (own op) and moves b's cursor past it;
//   4. x's re-ack arrives a round later, at its OLD position, and is folded
//      after the peer's op: [p0, p1, x] on the client, [p0, x, p1] on the
//      server — for any reducer that is not commutative a different state,
//      kept on that client only.
//
// Confirmed state cannot insert into its own past, so the engine asks for the
// cell and the snapshot puts x where the server has it.
import { assertEquals } from "@std/assert";
import { createServerSyncHandler } from "../../src/sync/server-handler.ts";
import { _resetServerTsForTest } from "../../src/sync/server-store.ts";
import {
  createMemoryStorage,
  createOpBuffer,
} from "../../src/sync/op-buffer.ts";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";
import type { HLC } from "../../src/sync/types.ts";
import {
  parseProtoHello,
  rememberPeerHello,
} from "../../src/protocol/protocol-version.ts";
import { createTestDb } from "./_test-db.ts";

type S = { items: string[] };
const CELLS = ["a", "b"];
const add = (s: Record<string, unknown>, _a: string, p: unknown) => ({
  items: [...((s as S).items ?? []), p as string],
});

Deno.test("sync: an ack from an earlier catch-up re-syncs the cell instead of folding out of order", async () => {
  // A server whose frame limit makes every reconnect slice hold one op.
  rememberPeerHello(
    parseProtoHello({ v: 3, min: 3, maxMessageBytes: 1024 })!,
  );
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  const live: Record<string, Record<string, unknown>> = {
    a: { items: [] },
    b: { items: [] },
  };
  type Client = {
    name: string;
    online: boolean;
    inbox: string[];
    outbox: string[];
    socket: WebSocket;
    confirmed: Record<string, Record<string, unknown>>;
    engine: ReturnType<typeof createSyncEngine>;
  };
  const clients: Client[] = [];
  const handler = createServerSyncHandler({
    dispatch: (a) => {
      const [cell, action] = a.type.split(":");
      live[cell!] = add(live[cell!]!, action!, a.payload);
    },
    db,
    syncCellIds: CELLS,
    getCellState: (c) => live[c]!,
    getClientCellState: (c) => live[c]!,
    broadcastRaw: {
      fn: (m, exclude) => {
        for (const c of clients) {
          if (c.online && c.socket !== exclude) c.inbox.push(m);
        }
      },
    },
    log: { debug: () => {}, warn: () => {}, error: () => {} },
  });
  const client = (name: string): Client => {
    const c = {
      name,
      online: true,
      inbox: [],
      outbox: [],
      confirmed: { a: { items: [] }, b: { items: [] } },
    } as unknown as Client;
    c.socket = {
      readyState: 1,
      send: (m: string) => void (c.online && c.inbox.push(m)),
    } as unknown as WebSocket;
    c.engine = createSyncEngine({
      clientId: name,
      cells: { a: normalizeSyncConfig(true), b: normalizeSyncConfig(true) },
      buffer: createOpBuffer(createMemoryStorage()),
      send: (m) => void (c.online && c.outbox.push(m)),
      reducer: add,
      getConfirmedState: () => c.confirmed,
      setConfirmedState: (cell, s) => void (c.confirmed[cell] = s),
      onStateUpdate: () => {},
      log: { warn: () => {}, debug: () => {} },
    });
    clients.push(c);
    return c;
  };
  const tick = () => new Promise((r) => setTimeout(r, 3));
  const pump = async () => {
    for (let idle = 0, i = 0; idle < 10 && i < 500; i++) {
      let moved = false;
      for (const c of clients) {
        while (c.outbox.length) {
          moved = true;
          const f = JSON.parse(c.outbox.shift()!);
          if (f.t === "op") {
            await handler.handleOp(f.d, { id: c.name }, c.socket);
          } else if (f.t === "sync-req") {
            handler.handleSync(f.d, { id: c.name }, c.socket);
          }
        }
      }
      await tick();
      for (const c of clients) {
        while (c.inbox.length) {
          moved = true;
          const f = JSON.parse(c.inbox.shift()!);
          if (f.t === "sync-ack") {
            await c.engine.handleAck(
              f.d.cell,
              f.d.opId,
              f.d.serverHlc as HLC,
              f.d.serverTs,
            );
          } else if (f.t === "op") await c.engine.handleRemoteOp(f.d);
          else if (f.t === "sync-res") await c.engine.handleSyncResponse(f.d);
        }
      }
      await tick();
      idle = moved ? 0 : idle + 1;
    }
  };
  try {
    const me = client("me");
    const peer = client("peer");
    await peer.engine.requestSync();
    await pump();
    await peer.engine.handleLocalAction("b", "add", "p0");
    await pump();
    await me.engine.requestSync(); // `me` now holds a real cursor for b
    await pump();

    // 1. x is applied on the server; its ack dies with the connection.
    await me.engine.handleLocalAction("b", "add", "x");
    const frame = JSON.parse(me.outbox.shift()!);
    await handler.handleOp(frame.d, { id: "me" }, me.socket);
    me.online = false;
    me.inbox.length = 0;
    me.engine.setOnline(false);

    // 2. offline edit in a; the peer writes b after x.
    await me.engine.handleLocalAction("a", "add", "y");
    await peer.engine.handleLocalAction("b", "add", "p1");
    await pump();
    assertEquals(live.b, { items: ["p0", "x", "p1"] });

    // 3. reconnect: a sliced flush.
    me.online = true;
    me.engine.setOnline(true);
    await pump();

    assertEquals(live, {
      a: { items: ["y"] },
      b: { items: ["p0", "x", "p1"] },
    });
    assertEquals(
      me.confirmed.b,
      live.b,
      "x must sit where the server applied it, not after the peer's op",
    );
    assertEquals(me.confirmed.a, live.a);
    assertEquals(peer.confirmed.b, live.b);
  } finally {
    for (const c of clients) c.engine.dispose();
    delete (globalThis as Record<string, unknown>).__aioPeerHello;
    await handler.flushServerWrites();
    close();
  }
});
