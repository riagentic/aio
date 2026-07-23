// tests/sync/sync-chaos.test.ts — property/chaos suite for the CRDT sync layer.
//
// The sync cursor is load-bearing (no global op-id dedup would mean a cursor
// bug = ops applied twice or lost). This suite drives the REAL client engine
// and the REAL server handler over a real in-memory SQLite op-log through a
// seeded adversarial network and asserts exactly-once convergence.
//
// Network model (matches what the transport can actually do):
//  - client→server: full reorder + duplication + individual drops (every c2s
//    path is idempotent or covered by a resend path).
//  - server→client: FIFO per connection (TCP never reorders originals), but
//    duplicates may be injected after their original, acks/responses may be
//    dropped individually, and a disconnect loses the queue suffix both ways.
//    (Dropping or reordering ORIGINAL "op" broadcasts is deliberately not
//    modeled: TCP loss = connection death, which IS modeled as disconnect.
//    The broadcast-advanced cursor is only prefix-safe under that reality.)
//  - disconnect/reconnect (fresh catch-up sync) and server restart (new
//    handler + state replay over the same SQLite store).
//
// Invariants after quiescence:
//  (a) every client's confirmed AND optimistic state converge,
//  (b) client state equals server state,
//  (c) every issued op applied exactly once everywhere (each op carries a
//      unique payload id appended to a list — a duplicate id = double-apply,
//      a missing id = lost op),
//  (d) all pending buffers drain to empty.
//
// Reproducibility: seeded mulberry32. On failure the episode seed is printed;
// replay a single episode with SYNC_CHAOS_SEED=<seed>.

import { assert, assertEquals } from "@std/assert";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them (see src/db/db-worker.ts)
import { DatabaseSync } from "node:sqlite";
import type { DB, QueryResult, Tx } from "../../src/db/types.ts";
import { compactSyncOps, SYNC_SCHEMA } from "../../src/sync/compact.ts";
import {
  _resetServerTsForTest,
  loadOpsSince,
  persistOp,
} from "../../src/sync/server-store.ts";
import { createServerSyncHandler } from "../../src/sync/server-handler.ts";
import {
  createMemoryStorage,
  createOpBuffer,
  type OpBuffer,
} from "../../src/sync/op-buffer.ts";
import {
  createSyncEngine,
  type SyncEngine,
} from "../../src/sync/sync-engine.ts";
import type { HLC, SyncOp } from "../../src/sync/types.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";

// ── PRNG ───────────────────────────────────────────────────────────────
/** mulberry32 — tiny seeded PRNG, good enough for schedules. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── real in-memory SQLite behind the framework DB interface ────────────
// deno-lint-ignore no-explicit-any
const _p = (v: unknown[]): any[] => v;

function createTestDb(): { db: DB; close: () => void } {
  const sqlite = new DatabaseSync(":memory:");
  for (const stmt of SYNC_SCHEMA) sqlite.exec(stmt);
  const query = <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> =>
    Promise.resolve({
      rows: sqlite.prepare(sql).all(..._p(params ?? [])) as T[],
      changes: 0,
      lastInsertRowId: 0n,
    });
  const execute = (sql: string, params?: unknown[]): Promise<QueryResult> => {
    const r = sqlite.prepare(sql).run(..._p(params ?? []));
    return Promise.resolve({
      rows: [],
      changes: Number(r.changes),
      lastInsertRowId: BigInt(r.lastInsertRowid),
    });
  };
  const transaction = (async (arg: unknown) => {
    if (typeof arg === "function") {
      return await (arg as (tx: Tx) => Promise<unknown>)({ query, execute });
    }
    const out: QueryResult[] = [];
    for (const s of arg as { sql: string; params?: unknown[] }[]) {
      out.push(await execute(s.sql, s.params));
    }
    return out;
    // deno-lint-ignore no-explicit-any
  }) as any;
  return {
    db: { query, execute, transaction, close: () => Promise.resolve() },
    close: () => sqlite.close(),
  };
}

// ── shared cell semantics ──────────────────────────────────────────────
const CELL = "chaos";
const silentLog = { debug: () => {}, warn: () => {}, error: () => {} };

/** Every op appends its unique payload id AND bumps a counter — the items
 *  list is an exact application ledger (dup id = double-apply, missing id =
 *  lost op); the counter is a redundant cross-check. */
function reduceCell(
  s: Record<string, unknown>,
  action: string,
  payload: unknown,
): Record<string, unknown> {
  if (action === "bump") {
    const p = payload as { id: string; n: number };
    return {
      count: ((s.count as number) ?? 0) + p.n,
      items: [...((s.items as string[]) ?? []), p.id],
    };
  }
  return s;
}

const canon = (s: Record<string, unknown>) => ({
  count: (s.count as number) ?? 0,
  items: [...((s.items as string[]) ?? [])].sort(),
});

const micro = async (n = 24) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};
const macro = () => new Promise<void>((r) => setTimeout(r, 0));

// ── world ──────────────────────────────────────────────────────────────
interface Client {
  i: number;
  gen: number;
  connected: boolean;
  inbox: string[]; // server→client, FIFO per connection
  outbox: string[]; // client→server
  socket: WebSocket;
  buffer: OpBuffer;
  engine: SyncEngine;
  confirmed: () => Record<string, unknown>;
  optimistic: () => Record<string, unknown>;
  dedupDrops: () => number;
}

interface Stats {
  ops: number;
  dupsInjected: number;
  drops: number;
  reconnects: number;
  restarts: number;
  clientDedupDrops: number;
  serverDedupDrops: number;
}

async function runEpisode(seed: number, stats: Stats): Promise<void> {
  const rand = mulberry32(seed);
  const pickIndex = (len: number) => Math.floor(rand() * len);

  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    // ── server ─────────────────────────────────────────────────────────
    let serverState: Record<string, unknown> = { count: 0, items: [] };
    const dispatch = (a: { type: string; payload?: unknown }) => {
      const action = a.type.slice(a.type.indexOf(":") + 1);
      serverState = reduceCell(serverState, action, a.payload);
    };
    const clients: Client[] = [];
    const broadcastRaw = {
      fn: (msg: string, exclude?: WebSocket) => {
        for (const c of clients) {
          if (c.connected && c.socket !== exclude) c.inbox.push(msg);
        }
      },
    };
    const serverLog = {
      ...silentLog,
      debug: (m: string) => {
        if (m.includes("duplicate")) stats.serverDedupDrops++;
      },
    };
    const makeHandler = () =>
      createServerSyncHandler({
        dispatch,
        db,
        syncCellIds: [CELL],
        getCellState: () => serverState,
        broadcastRaw,
        log: serverLog,
      });
    let handler = makeHandler();

    // ── clients ────────────────────────────────────────────────────────
    const newSocket = (c: Client): WebSocket => {
      const gen = c.gen;
      return {
        send: (m: string) => {
          if (c.connected && c.gen === gen) c.inbox.push(m);
        },
      } as unknown as WebSocket;
    };

    const nClients = 2 + Math.floor(rand() * 3); // 2–4
    for (let i = 0; i < nClients; i++) {
      const buffer = createOpBuffer(createMemoryStorage());
      let confirmed: Record<string, unknown> = { count: 0, items: [] };
      let optimistic: Record<string, unknown> = confirmed;
      let dedupDrops = 0;
      const c = {
        i,
        gen: 0,
        connected: true,
        inbox: [],
        outbox: [],
        buffer,
        confirmed: () => confirmed,
        optimistic: () => optimistic,
        dedupDrops: () => dedupDrops,
      } as unknown as Client;
      c.socket = newSocket(c);
      c.engine = createSyncEngine({
        clientId: `c${i}`,
        cells: { [CELL]: normalizeSyncConfig(true) },
        buffer,
        send: (msg) => {
          if (c.connected) c.outbox.push(msg);
        },
        reducer: (s, action, payload) => reduceCell(s, action, payload),
        getConfirmedState: () => ({ [CELL]: confirmed }),
        setConfirmedState: (_f, s) => {
          confirmed = s;
        },
        onStateUpdate: (_f, o) => {
          optimistic = o;
        },
        log: {
          warn: () => {},
          debug: (m) => {
            if (m.includes("duplicate")) dedupDrops++;
          },
        },
      });
      clients.push(c);
    }

    // ── network primitives ─────────────────────────────────────────────
    const deliverC2S = async (c: Client, msg: string) => {
      const m = JSON.parse(msg);
      if (m.t === "op") {
        await handler.handleOp(m.d, { id: `s${c.i}` }, c.socket);
      } else if (m.t === "sync-req") {
        handler.handleSync(m.d, { id: `s${c.i}` }, c.socket);
      }
    };
    const deliverS2C = async (c: Client, msg: string) => {
      if (!c.connected) return;
      const m = JSON.parse(msg);
      if (m.t === "sync-ack") {
        await c.engine.handleAck(m.d.cell, m.d.opId, m.d.serverHlc);
      } else if (m.t === "op") {
        await c.engine.handleRemoteOp({ ...m.d, confirmed: true } as SyncOp);
      } else if (m.t === "sync-res") {
        await c.engine.handleSyncResponse(m.d);
      } else if (m.t === "op-rejected") {
        await c.engine.handleRejection(m.d.cell, m.d.opId, m.d.reason);
      } // sync-err: client would back off and retry — settle retries anyway
    };

    const disconnect = (c: Client) => {
      c.connected = false;
      c.gen++;
      c.inbox.length = 0; // suffix loss both directions
      c.outbox.length = 0;
      c.engine.setOnline(false);
    };
    const reconnect = (c: Client) => {
      c.connected = true;
      c.gen++;
      c.socket = newSocket(c);
      c.engine.setOnline(true); // triggers a fresh sync-req internally
      stats.reconnects++;
    };

    const restartServer = async () => {
      stats.restarts++;
      // Let in-flight handler work finish first: a real restart KILLS it —
      // an op persisted but not yet dispatched simply never dispatches in
      // the dying process, and the boot replay below folds it from the log
      // either way. In-process we cannot kill floating promises, so draining
      // (all async work here is microtask-based; a macrotask turn flushes
      // it) is the faithful model — without it an old handler could dispatch
      // AFTER the replay already counted its op, a double impossible in
      // reality.
      await macro();
      await macro();
      for (const c of clients) {
        if (c.connected) disconnect(c);
      }
      _resetServerTsForTest(); // issuer forgets → must re-seed from the log
      handler = makeHandler();
      // Boot replay (mirrors replaySyncOps): fold the op-log into fresh state.
      serverState = { count: 0, items: [] };
      const ops = await loadOpsSince(db, CELL, null, null);
      for (const op of ops) {
        serverState = reduceCell(serverState, op.action, op.payload);
      }
      for (const c of clients) reconnect(c);
    };

    // ── op issuance (ground truth ledger) ──────────────────────────────
    let opSeq = 0;
    const issued: { id: string; n: number }[] = [];
    const localOp = async (c: Client) => {
      const n = 1 + Math.floor(rand() * 3);
      const id = `op-c${c.i}-${++opSeq}`;
      issued.push({ id, n });
      stats.ops++;
      await c.engine.handleLocalAction(CELL, "bump", { id, n });
    };

    // ── chaos schedule ─────────────────────────────────────────────────
    const events = 160 + Math.floor(rand() * 80);
    for (let e = 0; e < events; e++) {
      const r = rand();
      if (r < 0.30) {
        await localOp(clients[pickIndex(clients.length)]!);
      } else if (r < 0.66) {
        // deliver: c2s at a random index (reorder), s2c strictly FIFO
        const cands: Array<() => Promise<void>> = [];
        for (const c of clients) {
          if (c.outbox.length) {
            cands.push(async () => {
              const [msg] = c.outbox.splice(pickIndex(c.outbox.length), 1);
              await deliverC2S(c, msg!);
            });
          }
          if (c.inbox.length) {
            cands.push(async () => {
              await deliverS2C(c, c.inbox.shift()!);
            });
          }
        }
        if (cands.length) await cands[pickIndex(cands.length)]!();
      } else if (r < 0.74) {
        // duplicate: c2s anywhere; s2c copies must land AFTER their original
        // (TCP duplicates its past, never its future).
        const c = clients[pickIndex(clients.length)]!;
        if (rand() < 0.5 && c.outbox.length) {
          const i = pickIndex(c.outbox.length);
          c.outbox.splice(pickIndex(c.outbox.length + 1), 0, c.outbox[i]!);
          stats.dupsInjected++;
        } else if (c.inbox.length) {
          const i = pickIndex(c.inbox.length);
          const j = i + 1 + pickIndex(c.inbox.length - i);
          c.inbox.splice(j, 0, c.inbox[i]!);
          stats.dupsInjected++;
        }
      } else if (r < 0.80) {
        // drop: any c2s; s2c only acks/responses (an original broadcast can
        // only die with its connection — that's the disconnect event)
        const c = clients[pickIndex(clients.length)]!;
        if (rand() < 0.5 && c.outbox.length) {
          c.outbox.splice(pickIndex(c.outbox.length), 1);
          stats.drops++;
        } else {
          const droppable = c.inbox
            .map((m, idx) => ({ m, idx }))
            .filter(({ m }) => JSON.parse(m).t !== "op");
          if (droppable.length) {
            c.inbox.splice(droppable[pickIndex(droppable.length)]!.idx, 1);
            stats.drops++;
          }
        }
      } else if (r < 0.87) {
        const c = clients[pickIndex(clients.length)]!;
        if (c.connected) disconnect(c);
        else reconnect(c);
      } else if (r < 0.93) {
        const c = clients[pickIndex(clients.length)]!;
        if (c.connected) await c.engine.requestSync();
      } else if (r < 0.97) {
        await micro(); // let floating server work interleave
      } else {
        await restartServer();
      }
      await micro(8);
    }

    // ── settle: reconnect everyone, drain, sync until pending empty ────
    for (const c of clients) if (!c.connected) reconnect(c);

    const drainAll = async () => {
      for (let pass = 0; pass < 400; pass++) {
        await macro(); // flush all floating handler/engine microtask work
        let any = false;
        for (const c of clients) {
          while (c.outbox.length) {
            any = true;
            await deliverC2S(c, c.outbox.shift()!);
          }
        }
        await macro();
        for (const c of clients) {
          while (c.inbox.length) {
            any = true;
            await deliverS2C(c, c.inbox.shift()!);
          }
        }
        await macro();
        if (
          !any &&
          clients.every((c) => c.outbox.length === 0 && c.inbox.length === 0)
        ) return;
      }
      throw new Error("drainAll: message flow did not quiesce");
    };

    let drained = false;
    for (let round = 0; round < 15 && !drained; round++) {
      for (const c of clients) await c.engine.requestSync();
      await drainAll();
      drained = true;
      for (const c of clients) {
        if ((await c.buffer.getUnconfirmed(CELL)).length > 0) drained = false;
      }
    }

    // ── invariants ─────────────────────────────────────────────────────
    // (d) pending buffers drained
    for (const c of clients) {
      const pending = await c.buffer.getUnconfirmed(CELL);
      assertEquals(
        pending.length,
        0,
        `client c${c.i}: pending ops did not drain`,
      );
    }
    const expected = {
      count: issued.reduce((a, o) => a + o.n, 0),
      items: issued.map((o) => o.id).sort(),
    };
    // (c) exactly-once on the server: no dup ids, none lost
    const dupsOf = (items: string[]) =>
      [...items].sort().filter((id, i, a) => id === a[i - 1]);
    const sItems = (serverState.items as string[]) ?? [];
    assertEquals(
      dupsOf(sItems),
      [],
      "server applied op(s) twice",
    );
    assertEquals(canon(serverState), expected, "server state != issued ops");
    // (a)+(b)+(c) every client converges to the server, exactly once
    for (const c of clients) {
      const items = (c.confirmed().items as string[]) ?? [];
      assertEquals(
        dupsOf(items),
        [],
        `client c${c.i} applied op(s) twice`,
      );
      assertEquals(
        canon(c.confirmed()),
        expected,
        `client c${c.i} confirmed state diverged`,
      );
      assertEquals(
        canon(c.optimistic()),
        expected,
        `client c${c.i} optimistic state diverged`,
      );
      stats.clientDedupDrops += c.dedupDrops();
    }
  } finally {
    close();
  }
}

// ── episode runner ─────────────────────────────────────────────────────
const HARDCODED_SEEDS = [0xA11CE, 42, 1337, 987654321, 0x5EED0];
const EPISODES_PER_SEED = 10;

Deno.test("sync chaos: clients converge exactly-once under dup/drop/reorder/reconnect/restart", async () => {
  const env = Deno.env.get("SYNC_CHAOS_SEED");
  const timeSeed = Date.now() >>> 0;
  const stats: Stats = {
    ops: 0,
    dupsInjected: 0,
    drops: 0,
    reconnects: 0,
    restarts: 0,
    clientDedupDrops: 0,
    serverDedupDrops: 0,
  };

  if (env) {
    const seed = Number(env) >>> 0;
    console.log(`[sync-chaos] replaying single episode seed=${seed}`);
    await runEpisode(seed, stats);
  } else {
    console.log(`[sync-chaos] time-derived seed base=${timeSeed}`);
    const bases = [...HARDCODED_SEEDS, timeSeed];
    for (const base of bases) {
      for (let ep = 0; ep < EPISODES_PER_SEED; ep++) {
        const seed = (base + ep * 0x9E3779B9) >>> 0;
        try {
          await runEpisode(seed, stats);
        } catch (e) {
          console.error(
            `[sync-chaos] FAILED — replay with: SYNC_CHAOS_SEED=${seed} deno test -A tests/sync/sync-chaos.test.ts`,
          );
          throw e;
        }
      }
    }
  }
  console.log(
    `[sync-chaos] ok — ops=${stats.ops} dupsInjected=${stats.dupsInjected} ` +
      `drops=${stats.drops} reconnects=${stats.reconnects} restarts=${stats.restarts} ` +
      `dedupDrops(client=${stats.clientDedupDrops}, server=${stats.serverDedupDrops})`,
  );
  // The chaos schedule must actually exercise the dedup layers — a suite
  // that never produces a duplicate proves nothing.
  assert(
    stats.serverDedupDrops > 0,
    "chaos never exercised server-side dedup",
  );
  assert(
    stats.clientDedupDrops > 0,
    "chaos never exercised client-side dedup",
  );
});

// ── targeted regressions for the dedup / cursor fixes ──────────────────

function makeEngine(opts?: { onDebug?: (m: string) => void }) {
  const buffer = createOpBuffer(createMemoryStorage());
  let confirmed: Record<string, unknown> = { count: 0, items: [] };
  const engine = createSyncEngine({
    clientId: "me",
    cells: { [CELL]: normalizeSyncConfig(true) },
    buffer,
    send: () => {},
    reducer: (s, action, payload) => reduceCell(s, action, payload),
    getConfirmedState: () => ({ [CELL]: confirmed }),
    setConfirmedState: (_f, s) => {
      confirmed = s;
    },
    onStateUpdate: () => {},
    log: { warn: () => {}, debug: opts?.onDebug },
  });
  return { engine, buffer, confirmed: () => confirmed };
}

const peerOp = (id: string, hlc: HLC, serverTs?: number): SyncOp => ({
  id,
  cell: CELL,
  action: "bump",
  payload: { id: `p-${id}`, n: 1 },
  hlc,
  confirmed: true,
  serverTs,
});

Deno.test("dedup: op arriving via broadcast AND catch-up response applies once", async () => {
  const { engine, confirmed } = makeEngine();
  const op = peerOp("x1", [1000, 0, "peer"], 5);
  // Broadcast lands first…
  await engine.handleRemoteOp(op);
  // …then the response to a sync-req sent BEFORE the broadcast (old cursor)
  // re-delivers the same op.
  await engine.handleSyncResponse({
    mode: "incremental",
    ops: [op],
    lowWater: {},
    lastServerTs: { [CELL]: 5 },
  });
  assertEquals(confirmed().count, 1, "op must apply exactly once");
  assertEquals(confirmed().items, ["p-x1"]);
});

Deno.test("dedup: duplicated broadcast applies once and logs at debug", async () => {
  const debugs: string[] = [];
  const { engine, confirmed } = makeEngine({ onDebug: (m) => debugs.push(m) });
  const op = peerOp("x2", [1000, 0, "peer"], 7);
  await engine.handleRemoteOp(op);
  await engine.handleRemoteOp(op); // transport-level duplicate
  assertEquals(confirmed().count, 1);
  assert(
    debugs.some((m) => m.includes(CELL) && m.includes("x2")),
    `duplicate drop must be visible at debug level (got: ${
      debugs.join(" | ")
    })`,
  );
});

Deno.test("dedup: duplicated catch-up response applies once, cursor never regresses", async () => {
  const { engine, buffer, confirmed } = makeEngine();
  const a = peerOp("a", [1000, 0, "peer"]);
  const b = peerOp("b", [1001, 0, "peer"]);
  await engine.handleSyncResponse({
    mode: "incremental",
    ops: [a],
    lowWater: {},
    lastServerTs: { [CELL]: 105 },
  });
  await engine.handleSyncResponse({
    mode: "incremental",
    ops: [a, b],
    lowWater: {},
    lastServerTs: { [CELL]: 110 },
  });
  // A stale duplicate of the FIRST response arrives after the second.
  await engine.handleSyncResponse({
    mode: "incremental",
    ops: [a],
    lowWater: {},
    lastServerTs: { [CELL]: 105 },
  });
  assertEquals(confirmed().count, 2, "a and b exactly once");
  assertEquals(
    (await buffer.getMeta(CELL))?.lastServerTs,
    110,
    "stale response must not rewind the server_ts cursor",
  );
});

Deno.test("op-buffer: acks never advance the catch-up cursor", async () => {
  // Chaos-suite finding: the ack's serverHlc is ≥ every peer op persisted
  // before it, so letting an ack advance lastHlc made the HLC-fallback
  // catch-up skip peer ops the client never received (permanent loss once
  // the response echo sealed the server_ts cursor above them).
  const buffer = createOpBuffer(createMemoryStorage());
  await buffer.saveMeta(CELL, { lastHlc: [500, 0, "peer"], lastServerTs: 42 });
  await buffer.confirm(CELL, "op-1", [2000, 0, "server"]);
  const meta = await buffer.getMeta(CELL);
  assertEquals(meta?.lastHlc, [500, 0, "peer"], "lastHlc untouched by ack");
  assertEquals(meta?.lastServerTs, 42, "lastServerTs untouched by ack");
});

Deno.test("server: op re-sent after compaction stays deduped (tombstones)", async () => {
  const { db, close } = createTestDb();
  try {
    _resetServerTsForTest();
    const op = {
      id: "will-compact",
      hlc: [1000, 0, "c1"] as HLC,
      cell: CELL,
      action: "bump",
      payload: { id: "p1", n: 1 },
    };
    const first = await persistOp(db, op);
    assert(first !== null, "first persist inserts");
    // Compaction rolls the log over — the op's row is deleted.
    await compactSyncOps({
      db,
      cell: CELL,
      getState: () => ({ count: 1, items: ["p1"] }),
      serverHlc: [2000, 0, "server"],
      compactOps: 1,
      log: silentLog,
    });
    const { rows } = await db.query(
      "SELECT id FROM sync_ops WHERE id = ?",
      ["will-compact"],
    );
    assertEquals(rows.length, 0, "row compacted away");
    // The client re-sends after a lost ack: must still be a duplicate.
    assertEquals(
      await persistOp(db, op),
      null,
      "compacted op id must stay deduplicated (tombstone)",
    );
    // A genuinely new op is unaffected.
    const fresh = await persistOp(db, {
      ...op,
      id: "fresh",
      hlc: [3000, 0, "c1"] as HLC,
    });
    assert(fresh !== null, "new ops persist normally");
  } finally {
    close();
  }
});

Deno.test("dedup memory bound: oldest ids evicted, cursor stays the primary guard", async () => {
  // The per-cell applied-id set is FIFO-capped (2048). Far past the cap the
  // oldest id is forgotten — by design: at that distance re-delivery is
  // governed by the server_ts cursor again, and memory stays bounded.
  const { engine, confirmed } = makeEngine();
  const CAP = 2048;
  for (let i = 0; i < CAP + 8; i++) {
    await engine.handleRemoteOp(peerOp(`e${i}`, [1000 + i, 0, "peer"], i + 1));
  }
  assertEquals(confirmed().count, CAP + 8);
  // A duplicate of a RECENT op is still caught…
  await engine.handleRemoteOp(
    peerOp(`e${CAP + 7}`, [1000 + CAP + 7, 0, "peer"], CAP + 8),
  );
  assertEquals(confirmed().count, CAP + 8, "recent duplicate deduped");
  // …while the very first id has been evicted (bounded memory), proving the
  // structure cannot grow without limit.
  await engine.handleRemoteOp(peerOp("e0", [1000, 0, "peer"], 1));
  assertEquals(confirmed().count, CAP + 9, "oldest id evicted as designed");
});
