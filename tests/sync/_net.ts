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
import type { DB } from "../../src/db/types.ts";

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
  /** The listener cell's confirmed / optimistic state (see `listener`). */
  confirmedOf: (cell: string) => State;
  viewOf: (cell: string) => State;
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
  /** A second SYNC cell that `listensTo` the first: `react` runs inside the
   *  same server dispatch as each op of `cell` (the composed reduce), and a
   *  change is folded into the listener's own snapshot, as aio.ts's
   *  afterAction hook does (`noteServerWrite`). */
  /** Scheduling jitter (seeded): a burst of extra microtask yields before
   *  and after every database call and after every dispatch — the handler's
   *  await points. The test database answers in the same turn, where a real
   *  one answers a message round-trip later; an ordering bug that only the
   *  zero-latency timing hides is found here (see offline-replay's jitter
   *  mode). Microtasks only, so a seed replays exactly. */
  jitter?: () => number;
  /** Runs at every jittered await point, before its yields: what may land
   *  THERE — a server-origin write takes no cell lock, so the handler must
   *  hold at any await it has. */
  atYield?: () => void;
  listener?: {
    cell: string;
    initial: () => State;
    react: (s: State, action: string, payload: unknown) => State;
    /** The listener's OWN methods — direct ops on it, by action name. */
    own?: {
      actions: string[];
      apply: (s: State, action: string, payload: unknown) => State;
    };
  };
}) {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  const J = opts.jitter;
  const jitter = async (): Promise<void> => {
    if (J === undefined) return;
    opts.atYield?.();
    const x = J();
    if (x < 0.4) return; // most calls: no extra yield
    // Heavy-tailed: mostly a few turns, sometimes long enough that the test
    // program runs several steps while this call is "in the database".
    const n = x < 0.9
      ? Math.floor((x - 0.4) * 40)
      : 100 + Math.floor((x - 0.9) * 4000);
    for (let i = n; i >= 0; i--) await Promise.resolve();
  };
  const around =
    <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      await jitter();
      const r = await fn(...a);
      await jitter();
      return r;
    };
  const handlerDb: DB = J === undefined ? db : {
    ...db,
    query: around(db.query.bind(db)) as DB["query"],
    execute: around(db.execute.bind(db)),
    transaction: around(
      db.transaction.bind(db) as (a: unknown) => Promise<unknown>,
    ) as DB["transaction"],
  };
  let live: State = opts.initial();
  const L = opts.listener;
  let liveL: State = L ? L.initial() : {};
  const clients: NetClient[] = [];
  const serverLog: string[] = [];
  const handler = createServerSyncHandler({
    dispatch: (a) => {
      const action = a.type.slice(a.type.indexOf(":") + 1);
      if (L?.own && a.type.startsWith(`${L.cell}:`)) {
        liveL = L.own.apply(liveL, action, a.payload); // a direct op on it
        return J === undefined ? undefined : jitter();
      }
      live = opts.apply(live, action, a.payload);
      if (L) {
        const before = liveL;
        liveL = L.react(liveL, action, a.payload);
        if (liveL !== before) handler.noteServerWrite(L.cell);
      }
      return J === undefined ? undefined : jitter();
    },
    db: handlerDb,
    syncCellIds: L ? [opts.cell, L.cell] : [opts.cell],
    getCellState: (c) => (L && c === L.cell ? liveL : live),
    getClientCellState: (c) => (L && c === L.cell ? liveL : live),
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
    let confirmedL: State = L ? L.initial() : {};
    let viewL = confirmedL;
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
      cells: {
        [opts.cell]: normalizeSyncConfig(opts.sync ?? true),
        ...(L ? { [L.cell]: normalizeSyncConfig(true) } : {}),
      },
      buffer,
      send: (m) => {
        if (!c.online) return;
        c.outbox.push(m);
        c.sentLog.push(m);
      },
      reducer: opts.reducer ??
        ((s, action, payload) =>
          L?.own?.actions.includes(action)
            ? L.own.apply(s, action, payload)
            : opts.apply(s, action, payload)),
      getConfirmedState: () => ({
        [opts.cell]: confirmed,
        ...(L ? { [L.cell]: confirmedL } : {}),
      }),
      setConfirmedState: (c, s) => {
        if (L && c === L.cell) confirmedL = s;
        else confirmed = s;
      },
      onStateUpdate: (c, s) => {
        if (L && c === L.cell) viewL = s;
        else view = s;
      },
      log: { warn: () => {}, debug: () => {} },
      ...opts.engine,
    });
    c.confirmed = () => confirmed;
    c.view = () => view;
    c.confirmedOf = (cell) => (L && cell === L.cell ? confirmedL : confirmed);
    c.viewOf = (cell) => (L && cell === L.cell ? viewL : view);
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
    /** The listener cell's live server state. */
    liveOf: (cell: string): State => (L && cell === L.cell ? liveL : live),
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
