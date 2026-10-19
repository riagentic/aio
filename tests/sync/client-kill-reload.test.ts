// A tab killed at an ANNOUNCED write of its offline queue, then reloaded.
//
// The real client engine and the real server handler (real SQLite op-log)
// over an in-memory wire. The client's storage keeps what a write stored as
// a serialized copy (as localStorage does), and its N-th write is the kill:
// the write never lands, the page sends and hears nothing more. The reload is
// a fresh engine over the same storage and identity, re-seeded from the
// cell's initial state (as `initBrowserSync` does). A peer keeps writing, the
// server compacts every few ops, and the reloaded tab writes more.
//
// Model: every op the server acknowledged is in the server's state exactly
// once; every op the tab queued (its save landed) reaches the server, exactly
// once; both clients' confirmed state equals the server's.
import { assert, assertEquals } from "@std/assert";
import { createServerSyncHandler } from "../../src/sync/server-handler.ts";
import { _resetServerTsForTest } from "../../src/sync/server-store.ts";
import {
  createOpBuffer,
  type OpBufferStorage,
} from "../../src/sync/op-buffer.ts";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import { normalizeSyncConfig, SYNC_DEFAULTS } from "../../src/sync/types.ts";
import type { SyncOp } from "../../src/sync/types.ts";
import { createTestDb } from "./_test-db.ts";
import { fuzzEnvInt } from "../fuzz-seed.ts";

const CELL = "notes";
type S = Record<string, unknown>;
const add = (s: S, p: unknown): S => ({
  items: [...(s.items as string[] ?? []), p as string],
});
const macro = () => new Promise<void>((r) => setTimeout(r, 0));
const silent = { debug: () => {}, warn: () => {}, error: () => {} };

/** A storage whose every write is a serialized copy, and whose `killAt`-th
 *  write never lands — the tab dies there. */
function killableStorage(killAt: number, onKill: () => void) {
  const ops = new Map<string, SyncOp[]>();
  const meta = new Map<string, unknown>();
  const snap = new Map<string, unknown>();
  let writes = 0;
  const copy = <T>(v: T): T =>
    v === undefined ? v : JSON.parse(JSON.stringify(v));
  const w = (fn: () => void): Promise<void> => {
    if (++writes === killAt) {
      onKill();
      return new Promise<void>(() => {}); // the kill: never lands
    }
    fn();
    return Promise.resolve();
  };
  const s: OpBufferStorage & { reload: () => void } = {
    // The cursor lives in the page's memory, as `browser-storage.ts` keeps
    // it: a reload starts from none (and from the initial state).
    reload: () => meta.clear(),
    loadOps: (c) => Promise.resolve(copy(ops.get(c) ?? [])),
    saveOp: (op) =>
      w(() => ops.set(op.cell, [...ops.get(op.cell) ?? [], copy(op)])),
    confirmOp: (c, id) =>
      w(() =>
        ops.set(
          c,
          (ops.get(c) ?? []).map((o) =>
            o.id === id ? { ...o, confirmed: true } : o
          ),
        )
      ),
    pruneConfirmed: (c) =>
      w(() => ops.set(c, (ops.get(c) ?? []).filter((o) => !o.confirmed))),
    pruneStale: (c, id) =>
      w(() => ops.set(c, (ops.get(c) ?? []).filter((o) => o.id !== id))),
    countUnconfirmed: (c) =>
      Promise.resolve((ops.get(c) ?? []).filter((o) => !o.confirmed).length),
    loadMeta: (c) => Promise.resolve(copy(meta.get(c)) as never),
    saveMeta: (c, d) => w(() => meta.set(c, copy(d))),
    loadSnapshot: (c) => Promise.resolve(copy(snap.get(c)) as never),
    saveSnapshot: (c, d) => w(() => snap.set(c, copy(d))),
    clear: (c) =>
      w(() => {
        ops.delete(c);
        meta.delete(c);
        snap.delete(c);
      }),
  };
  return s;
}

type Tab = {
  name: string;
  alive: boolean;
  out: string[];
  inbox: string[];
  socket: WebSocket;
  confirmed: () => S;
  engine: ReturnType<typeof createSyncEngine>;
  /** Settles when the tab dies: a call the kill hung is abandoned. */
  dead: Promise<void>;
  die: () => void;
};
const go = (t: Tab, p: Promise<void>) => Promise.race([p, t.dead]);

function tab(name: string, storage: OpBufferStorage): Tab {
  let confirmed: S = { items: [] };
  const t = { name, alive: true, out: [], inbox: [] } as unknown as Tab;
  t.socket = {
    send: (m: string) => {
      if (t.alive) t.inbox.push(m);
    },
  } as unknown as WebSocket;
  t.confirmed = () => confirmed;
  t.dead = new Promise((r) => {
    t.die = () => {
      t.alive = false;
      r();
    };
  });
  t.engine = createSyncEngine({
    clientId: name,
    cells: { [CELL]: normalizeSyncConfig(true) },
    buffer: createOpBuffer(storage),
    send: (m) => {
      if (t.alive) t.out.push(m);
    },
    reducer: (s, a, p) => a === "add" ? add(s, p) : s,
    getConfirmedState: () => ({ [CELL]: confirmed }),
    setConfirmedState: (_c, s) => {
      confirmed = s;
    },
    onStateUpdate: () => {},
    log: { warn: () => {}, debug: () => {} },
  });
  return t;
}

async function episode(killAt: number, seed: number): Promise<boolean> {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  const tabs: Tab[] = [];
  const compactOps = SYNC_DEFAULTS.compactOps;
  (SYNC_DEFAULTS as { compactOps: number }).compactOps = 3;
  try {
    let live: S = { items: [] };
    const acked = new Set<string>();
    const handler = createServerSyncHandler({
      dispatch: (x) => {
        const p = (x as { payload: string }).payload;
        // The server's method refuses these: op-rejected, rolled back.
        if (p.includes("bad")) throw new Error("no bad");
        live = add(live, p);
      },
      db,
      syncCellIds: [CELL],
      getCellState: () => live,
      getClientCellState: () => live,
      broadcastRaw: {
        fn: (m, ex) => {
          for (const t of tabs) if (t.socket !== ex) t.socket.send(m);
        },
      },
      log: silent,
    });
    let killed = false;
    const storage = killableStorage(killAt, () => {
      killed = true;
      me.die();
    });
    let me = tab("me", storage);
    const peer = tab("peer", killableStorage(0, () => {}));
    tabs.push(me, peer);
    const payloads = new Map<string, string>(); // op id → payload
    const pump = async () => {
      for (let pass = 0; pass < 200; pass++) {
        await macro();
        let any = false;
        for (const t of tabs) {
          while (t.out.length) {
            any = true;
            const m = JSON.parse(t.out.shift()!);
            if (Deno.env.get("TRACE")) {
              console.log(
                `${t.name}${t === me ? "*" : ""} >`,
                JSON.stringify(m).slice(0, 300),
              );
            }
            if (m.t === "op") {
              payloads.set(m.d.id, m.d.payload);
              await handler.handleOp(m.d, { id: t.name }, t.socket);
            } else if (m.t === "sync-req") {
              for (const o of m.d.pendingOps ?? []) {
                payloads.set(o.id, o.payload);
              }
              handler.handleSync(m.d, { id: t.name }, t.socket);
            }
          }
        }
        await macro();
        for (const t of tabs) {
          while (t.inbox.length && t.alive) {
            any = true;
            const m = JSON.parse(t.inbox.shift()!);
            if (Deno.env.get("TRACE")) {
              console.log(
                `${t.name}${t === me ? "*" : ""} <`,
                JSON.stringify(m).slice(0, 300),
              );
            }
            if (m.t === "sync-ack") {
              acked.add(m.d.opId);
              await go(
                t,
                t.engine.handleAck(
                  m.d.cell,
                  m.d.opId,
                  m.d.serverHlc,
                  m.d.serverTs,
                ),
              );
            } else if (m.t === "op") {
              await go(t, t.engine.handleRemoteOp({ ...m.d, confirmed: true }));
            } else if (m.t === "sync-res") {
              await go(t, t.engine.handleSyncResponse(m.d));
            } else if (m.t === "op-rejected") {
              await go(
                t,
                t.engine.handleRejection(m.d.cell, m.d.opId, m.d.reason),
              );
            }
          }
          if (!t.alive) t.inbox.length = 0;
        }
        if (!any) return;
      }
      throw new Error("no quiescence");
    };
    for (const t of tabs) await go(t, t.engine.requestSync());
    await pump();
    const queued: string[] = []; // payloads `me` issued while alive
    let n = 0;
    for (let i = 0; i < 14; i++) {
      const who = rnd() < 0.7 ? me : peer;
      if (rnd() < 0.15 && me.alive) me.engine.setOnline(false);
      if (rnd() < 0.3) me.engine.setOnline(true);
      if (who.alive) {
        const p = `${who.name}-${rnd() < 0.15 ? "bad" : ""}${n++}`;
        if (who === me) queued.push(p);
        // Not awaited: the kill may hang the call forever.
        void who.engine.handleLocalAction(CELL, "add", p);
      }
      await pump();
      if (!me.alive) {
        // Reload: a fresh page over the same storage.
        me.engine.dispose();
        tabs.splice(tabs.indexOf(me), 1);
        storage.reload();
        me = tab("me", storage);
        tabs.push(me);
        await go(me, me.engine.requestSync());
        await pump();
      }
    }
    me.engine.setOnline(true);
    for (let r = 0; r < 6; r++) {
      for (const t of tabs) await go(t, t.engine.requestSync());
      await pump();
    }
    const ctx = `killAt=${killAt} seed=${seed} killed=${killed}\nlive=${
      JSON.stringify(live.items)
    }\nme=${JSON.stringify(me.confirmed().items)}\npeer=${
      JSON.stringify(peer.confirmed().items)
    }\nqueued=${queued}`;
    const items = live.items as string[];
    assertEquals(new Set(items).size, items.length, `server double\n${ctx}`);
    for (const id of acked) {
      const p = payloads.get(id);
      if (p !== undefined) assert(items.includes(p), `acked lost ${p}\n${ctx}`);
    }
    // Every op `me` issued landed, save the ones the kill took before their
    // save (at most the one in flight at the kill).
    assert(!items.some((p) => p.includes("bad")), `refused applied\n${ctx}`);
    const missing = queued.filter((p) =>
      !p.includes("bad") && !items.includes(p)
    );
    assert(
      missing.length <= (killed ? 1 : 0),
      `queued lost ${missing}\n${ctx}`,
    );
    assertEquals(me.confirmed().items, items, `me diverged\n${ctx}`);
    assertEquals(peer.confirmed().items, items, `peer diverged\n${ctx}`);
    return killed;
  } finally {
    (SYNC_DEFAULTS as { compactOps: number }).compactOps = compactOps;
    for (const t of tabs) t.engine.dispose();
    close();
  }
}

Deno.test("sync: a tab killed at any announced queue write, reloaded, loses no op, applies none twice, converges", async () => {
  const n = fuzzEnvInt("AIO_CLIENT_KILL_N", 40, 1);
  const seed = fuzzEnvInt("AIO_CLIENT_KILL_SEED", 3);
  let kills = 0;
  const one = fuzzEnvInt("AIO_CLIENT_KILL_AT", 0);
  for (let k = one || 1; k <= (one || n); k++) {
    if (await episode(k, seed + k)) kills++;
  }
  assert(kills > 0, "no kill window was reached"); // positive control
});
