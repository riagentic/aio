// tests/sync/_net.ts — the REAL client engine and the REAL server handler over
// a real in-memory SQLite op-log, connected by an in-process FIFO "network".
// For tests that need several clients, broadcasts and server-side writes in
// one place. Frames are routed exactly as browser-sync.ts routes them.
import { createServerSyncHandler } from "../../src/sync/server-handler.ts";
import { _resetServerTsForTest } from "../../src/sync/server-store.ts";
import {
  createMemoryStorage,
  createOpBuffer,
  type OpBuffer,
} from "../../src/sync/op-buffer.ts";
import {
  createSyncEngine,
  type SyncEngine,
  type SyncEngineDeps,
} from "../../src/sync/sync-engine.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";
import type { HLC, SyncConfig } from "../../src/sync/types.ts";
import type { SyncReducer } from "../../src/sync/rebase.ts";
import { createTestDb } from "./_test-db.ts";

export type State = Record<string, unknown>;

export interface NetClient {
  name: string;
  engine: SyncEngine;
  buffer: OpBuffer;
  confirmed: () => State;
  view: () => State;
  /** Client→server frames not yet delivered. */
  outbox: string[];
  /** Server→client frames not yet delivered. */
  inbox: string[];
  /** Every client→server frame ever sent, as sent. */
  sentLog: string[];
  socket: WebSocket;
  online: boolean;
}

export function createNet(opts: {
  cell: string;
  initial: () => State;
  /** Server-side apply: the cell's method, the way dispatch runs it. */
  apply: (s: State, action: string, payload: unknown) => State;
  /** Client-side replay reducer (defaults to `apply`). */
  reducer?: SyncReducer;
  sync?: Partial<SyncConfig>;
  engine?: Partial<SyncEngineDeps>;
}) {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  let live: State = opts.initial();
  const clients: NetClient[] = [];
  const serverLog: string[] = [];
  const handler = createServerSyncHandler({
    dispatch: (a) => {
      live = opts.apply(live, a.type.slice(a.type.indexOf(":") + 1), a.payload);
    },
    db,
    syncCellIds: [opts.cell],
    getCellState: () => live,
    getClientCellState: () => live,
    broadcastRaw: {
      fn: (m, exclude) => {
        for (const c of clients) {
          if (c.online && c.socket !== exclude) c.inbox.push(m);
        }
      },
    },
    log: {
      debug: () => {},
      warn: (m) => void serverLog.push(m),
      error: (m) => void serverLog.push(m),
    },
  });

  function addClient(name: string, storage = createMemoryStorage()): NetClient {
    let confirmed = opts.initial();
    let view = confirmed;
    const buffer = createOpBuffer(storage);
    const c = {
      name,
      buffer,
      outbox: [],
      inbox: [],
      sentLog: [],
      online: true,
    } as unknown as NetClient;
    c.socket = {
      readyState: 1,
      send: (m: string) => void c.inbox.push(m),
    } as unknown as WebSocket;
    c.engine = createSyncEngine({
      clientId: name,
      cells: { [opts.cell]: normalizeSyncConfig(opts.sync ?? true) },
      buffer,
      send: (m) => {
        if (!c.online) return;
        c.outbox.push(m);
        c.sentLog.push(m);
      },
      reducer: opts.reducer ??
        ((s, action, payload) => opts.apply(s, action, payload)),
      getConfirmedState: () => ({ [opts.cell]: confirmed }),
      setConfirmedState: (_c, s) => {
        confirmed = s;
      },
      onStateUpdate: (_c, s) => {
        view = s;
      },
      log: { warn: () => {}, debug: () => {} },
      ...opts.engine,
    });
    c.confirmed = () => confirmed;
    c.view = () => view;
    clients.push(c);
    return c;
  }

  const tick = () => new Promise((r) => setTimeout(r, 2));

  /** Deliver every frame both ways until nothing moves for a few rounds. */
  async function pump(rounds = 400): Promise<void> {
    let idle = 0;
    for (let i = 0; i < rounds && idle < 8; i++) {
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
          else if (f.t === "op-rejected") {
            await c.engine.handleRejection(f.d.cell, f.d.opId, f.d.reason);
          }
        }
      }
      await tick();
      idle = moved ? 0 : idle + 1;
    }
  }

  return {
    handler,
    /** The server's op-log database. */
    db,
    clients,
    addClient,
    pump,
    serverLog,
    live: () => live,
    /** A server-origin write: what an effect, cron, serverFn, `am dispatch` or
     *  an async method's commit does — state changes, no op exists. */
    serverWrite(fn: (s: State) => State): void {
      live = fn(live);
      handler.noteServerWrite(opts.cell);
    },
    async close(): Promise<void> {
      await handler.flushServerWrites();
      for (const c of clients) c.engine.dispose();
      close();
    },
  };
}
