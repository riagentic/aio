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
// Axes (2026-08-27 — an adversarial audit found H1 in the gap this suite left):
// the suite fuzzed ONE cell and ONE append-only action, so it structurally
// could not produce the two-cell snapshot race (H1: the response is built cell
// by cell, each under its own lock, so an op persisted between two cells'
// locks is broadcast, held, and was then dropped by a watermark it sits ABOVE)
// and it never saw a non-commutative reducer, where a wrong ORDER is a wrong
// answer that no set comparison can see. Now: TWO cells, four actions
// (append / REMOVE / overwrite / counter), per-client clock skew including
// skew past `maxDrift` (which the server refuses — so refusal handling is
// exercised too), and a `counter` merge strategy on the second cell so the
// conflict path in the engine actually executes.
//
// Reproducibility: seeded mulberry32. On failure the episode seed is printed;
// replay a single episode with SYNC_CHAOS_SEED=<seed>.

import { assert, assertEquals } from "@std/assert";
import { fuzzEnvInt } from "../fuzz-seed.ts";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them (see src/db/db-worker.ts)
import { DatabaseSync } from "node:sqlite";
import type { DB, QueryResult, Tx } from "../../src/db/types.ts";
import { compactSyncOps, SYNC_SCHEMA } from "../../src/sync/compact.ts";
import {
  _resetServerTsForTest,
  loadOpsSince,
  loadSnapshot,
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
import { normalizeSyncConfig, SYNC_DEFAULTS } from "../../src/sync/types.ts";

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
const CELL = "chaos"; // cell A
const CELL_B = "chaos2"; // cell B — the second cell H1 needs
const CELLS = [CELL, CELL_B];
const silentLog = { debug: () => {}, warn: () => {}, error: () => {} };

/** Four actions, three of them NOT commutative:
 *   - `bump`   append `id` to items (+ counter) — the original append-only op;
 *   - `drop`   REMOVE an item — reordering it against its `bump` changes the
 *              answer, and applying it twice is invisible in the result, which
 *              is exactly why the journal below (not the items list) is the
 *              exactly-once ledger;
 *   - `set`    overwrite `value` — pure last-write-wins, so order IS the value;
 *   - `tick`   add to `n`, the field cell B declares as a `counter` merge.
 *
 *  `journal` records EVERY applied op id in apply order: a duplicate id is a
 *  double-apply, a missing id is a lost op, and a different sequence is a
 *  different history — one field that sees all three. */
function reduceCell(
  s: Record<string, unknown>,
  action: string,
  payload: unknown,
): Record<string, unknown> {
  const p = payload as { id: string; n?: number; target?: string; v?: string };
  const journal = [...((s.journal as string[]) ?? []), p.id];
  switch (action) {
    case "bump":
      return {
        ...s,
        journal,
        count: ((s.count as number) ?? 0) + (p.n ?? 1),
        items: [...((s.items as string[]) ?? []), p.id],
      };
    case "drop":
      return {
        ...s,
        journal,
        items: ((s.items as string[]) ?? []).filter((i) => i !== p.target),
      };
    case "set":
      return { ...s, journal, value: p.v };
    case "tick":
      return { ...s, journal, n: ((s.n as number) ?? 0) + (p.n ?? 1) };
    default:
      return s;
  }
}

const emptyCell = (): Record<string, unknown> => ({
  count: 0,
  items: [],
  journal: [],
  value: "",
  n: 0,
});

/** The whole cell, order included. Nothing is sorted: sorting is a set
 *  comparison, and it hides the entire class of bug where a client applies the
 *  right ops in the wrong ORDER — which for `drop`/`set` is simply a different
 *  answer, kept forever, on the client only, with nothing to compare against.
 *  The client must reproduce the server's sequence exactly. */
const canon = (s: Record<string, unknown>) => ({
  count: (s.count as number) ?? 0,
  items: [...((s.items as string[]) ?? [])],
  journal: [...((s.journal as string[]) ?? [])],
  value: (s.value as string) ?? "",
  n: (s.n as number) ?? 0,
});

/** The ledger AS APPLIED — every op id, in apply order. */
const asApplied = (s: Record<string, unknown>) => [
  ...((s.journal as string[]) ?? []),
];

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
  /** Wall-clock skew (ms) applied to the ops this client SENDS — a machine
   *  whose clock is wrong. Past `maxDrift` the server refuses the op. */
  skew: number;
  confirmed: (cell: string) => Record<string, unknown>;
  optimistic: (cell: string) => Record<string, unknown>;
  dedupDrops: () => number;
}

interface Stats {
  ops: number;
  dupsInjected: number;
  drops: number;
  reconnects: number;
  restarts: number;
  compactions: number;
  clientDedupDrops: number;
  serverDedupDrops: number;
  /** Ops the server refused for clock drift (M5) — the client must drop them. */
  driftRejected: number;
  /** Conflicts the engine's merge/onConflict path actually resolved. */
  conflicts: number;
  /** Non-append ops issued — the order-sensitive half of the fuzz. */
  destructive: number;
}

async function runEpisode(seed: number, stats: Stats): Promise<void> {
  const rand = mulberry32(seed);
  const pickIndex = (len: number) => Math.floor(rand() * len);

  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    // Ground truth: every op id issued, and every one the server refused.
    // The ledger is keyed by the PAYLOAD id (what the reducer journals); the
    // wire carries the engine's op id, so the two are bridged as ops go out.
    const issued = new Set<string>();
    const rejected = new Set<string>();
    const ledgerIdOf = new Map<string, string>();

    // ── server ─────────────────────────────────────────────────────────
    const serverState: Record<string, Record<string, unknown>> = {
      [CELL]: emptyCell(),
      [CELL_B]: emptyCell(),
    };
    const dispatch = (a: { type: string; payload?: unknown }) => {
      const idx = a.type.indexOf(":");
      const cell = a.type.slice(0, idx);
      const action = a.type.slice(idx + 1);
      serverState[cell] = reduceCell(serverState[cell]!, action, a.payload);
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
        syncCellIds: CELLS,
        getCellState: (cell) => serverState[cell]!,
        getClientCellState: (cell) => serverState[cell]!,
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
      const confirmed: Record<string, Record<string, unknown>> = {
        [CELL]: emptyCell(),
        [CELL_B]: emptyCell(),
      };
      const optimistic: Record<string, Record<string, unknown>> = {
        [CELL]: confirmed[CELL]!,
        [CELL_B]: confirmed[CELL_B]!,
      };
      let dedupDrops = 0;
      // One client per episode runs a wrong clock: mostly a survivable skew
      // (inside maxDrift, so the op is accepted and its HLC really is out of
      // order), rarely a wild one the server must refuse outright.
      const skewRoll = rand();
      const skew = i !== 0
        ? 0
        : skewRoll < 0.5
        ? Math.floor((rand() - 0.5) * SYNC_DEFAULTS.maxDrift)
        : SYNC_DEFAULTS.maxDrift * (2 + Math.floor(rand() * 4));
      const c = {
        i,
        gen: 0,
        connected: true,
        inbox: [],
        outbox: [],
        buffer,
        skew,
        confirmed: (cell: string) => confirmed[cell]!,
        optimistic: (cell: string) => optimistic[cell]!,
        dedupDrops: () => dedupDrops,
      } as unknown as Client;
      c.socket = newSocket(c);
      c.engine = createSyncEngine({
        clientId: `c${i}`,
        cells: {
          [CELL]: normalizeSyncConfig(true),
          // A real merge strategy, so `mergeField` and the conflict callback
          // execute inside the ENGINE and not only in unit tests.
          [CELL_B]: normalizeSyncConfig({
            merge: { n: "counter" },
            onConflict: (cs) => {
              stats.conflicts += cs.length;
            },
          }),
        },
        buffer,
        send: (msg) => {
          if (c.connected) c.outbox.push(msg);
        },
        reducer: (s, action, payload) => reduceCell(s, action, payload),
        getConfirmedState: () => confirmed,
        setConfirmedState: (cell, s) => {
          confirmed[cell] = s;
        },
        onStateUpdate: (cell, o) => {
          optimistic[cell] = o;
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
      // A wrong clock is a property of the MACHINE, so it shows up in the
      // wall-clock half of every HLC this client stamps. Applied on the wire
      // (the engine reads the real Date.now) — same observable effect on the
      // server, deterministic per seed.
      type WireOp = {
        id: string;
        hlc: [number, number, string];
        payload?: { id?: string };
      };
      const skewOp = <T extends WireOp>(o: T): T => ({
        ...o,
        hlc: [o.hlc[0] + c.skew, o.hlc[1], o.hlc[2]] as [
          number,
          number,
          string,
        ],
      });
      const note = <T extends WireOp>(o: T): T => {
        if (o.payload?.id) ledgerIdOf.set(o.id, o.payload.id);
        return o;
      };
      if (m.t === "op") {
        await handler.handleOp(skewOp(note(m.d)), { id: `s${c.i}` }, c.socket);
      } else if (m.t === "sync-req") {
        handler.handleSync(
          {
            ...m.d,
            pendingOps: (m.d.pendingOps ?? []).map((o: WireOp) =>
              skewOp(note(o))
            ),
          },
          { id: `s${c.i}` },
          c.socket,
        );
      }
    };
    const deliverS2C = async (c: Client, msg: string) => {
      if (!c.connected) return;
      const m = JSON.parse(msg);
      if (m.t === "sync-ack") {
        // `serverTs` is part of the ack — the client needs it to tell an op a
        // snapshot already contains from one it doesn't. The harness used to
        // drop it, which made every episode run against a client that could
        // never dedup an ack, and hid the whole snapshot-watermark path.
        await c.engine.handleAck(
          m.d.cell,
          m.d.opId,
          m.d.serverHlc,
          m.d.serverTs,
        );
      } else if (m.t === "op") {
        await c.engine.handleRemoteOp({ ...m.d, confirmed: true } as SyncOp);
      } else if (m.t === "sync-res") {
        await c.engine.handleSyncResponse(m.d);
      } else if (m.t === "op-rejected") {
        // The only refusal this suite produces is the clock-drift one (M5).
        //
        // The ledger records it HERE, where the client hears it — not where
        // the server decides it. A refusal is only final once it lands: the
        // client then drops the op and never sends it again, so "refused" and
        // "applied nowhere" become the same fact. A refusal the network eats
        // leaves the op in the client's pending buffer, and it keeps coming
        // back until some later round answers it.
        //
        // This is also the assertion that pins the refusal's stickiness: the
        // server measures drift against ITS wall clock, which moves, so the
        // same op re-delivered later used to measure under the limit and be
        // ACCEPTED — after its origin had already been told it was refused,
        // rolled the optimistic view back and pruned it. If that ever comes
        // back, the op lands in the server journal while sitting in `rejected`
        // and the exactly-once assertion below goes red. (Seed 724.)
        if (/clock drift/.test(String(m.d.reason))) {
          const led = ledgerIdOf.get(m.d.opId);
          if (led !== undefined && !rejected.has(led)) {
            stats.driftRejected++;
            rejected.add(led);
          }
        }
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
      // Boot replay — EXACTLY what aio-boot's replaySyncOps does: seed from
      // the compaction snapshot, then fold the surviving op-log on top. The
      // snapshot step is not optional once compaction is in the picture:
      // compaction DELETES the ops it folded, so the log alone restores the
      // cell to its initialState.
      for (const cell of CELLS) {
        serverState[cell] = emptyCell();
        const snap = await loadSnapshot(db, cell);
        if (snap) serverState[cell] = snap.state;
        for (const op of await loadOpsSince(db, cell, null, null)) {
          serverState[cell] = reduceCell(
            serverState[cell]!,
            op.action,
            op.payload,
          );
        }
      }
      for (const c of clients) reconnect(c);
    };

    // ── compaction ─────────────────────────────────────────────────────
    // The op-log rolls over constantly in a real app: `noteServerWrite` fires
    // on every server-origin write and force-compacts (fold live state into
    // the snapshot, DELETE every op at/below the server HLC), and the op-count
    // threshold fires on busy cells. Episodes never exercised it, so the
    // entire snapshot/catch-up boundary — the one place where a cursor bug
    // means ops that no longer exist anywhere — ran untested.
    const compact = async () => {
      stats.compactions++;
      handler.noteServerWrite(CELLS[pickIndex(CELLS.length)]!);
      await handler.flushServerWrites(); // same lock, without the debounce wait
    };

    // ── op issuance (ground truth ledger) ──────────────────────────────
    // (`issued`/`rejected` are declared above the network so the socket can
    // record refusals as the server makes them.)
    // The ledger is now the set of ISSUED op ids (minus the ones the server
    // refused): with `drop`/`set` in play the final state is not a function of
    // the issue order — only of the server's apply order — so the server IS
    // the expected value, and what every client must reproduce exactly,
    // sequence included.
    let opSeq = 0;
    const localOp = async (c: Client) => {
      const id = `op-c${c.i}-${++opSeq}`;
      const cell = CELLS[pickIndex(CELLS.length)]!;
      issued.add(id);
      stats.ops++;
      const r = rand();
      if (r < 0.55) {
        await c.engine.handleLocalAction(cell, "bump", {
          id,
          n: 1 + Math.floor(rand() * 3),
        });
        return;
      }
      stats.destructive++;
      if (r < 0.75) {
        // Remove something that plausibly exists — the interesting case is a
        // `drop` racing the `bump` that created its target.
        const live = (c.optimistic(cell).items as string[]) ?? [];
        const target = live.length > 0 ? live[pickIndex(live.length)]! : "none";
        await c.engine.handleLocalAction(cell, "drop", { id, target });
      } else if (r < 0.9) {
        await c.engine.handleLocalAction(cell, "set", { id, v: id });
      } else {
        await c.engine.handleLocalAction(cell, "tick", {
          id,
          n: 1 + Math.floor(rand() * 3),
        });
      }
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
        // drop. c2s: any single frame (every client→server path is idempotent
        // or covered by a resend). s2c: the CONNECTION, never one frame.
        //
        // The suite used to drop individual acks and sync responses while
        // leaving the connection up — and that is not something TCP can do,
        // for exactly the reason the header already gives for broadcasts:
        // loss IS connection death. The fiction has teeth. A lost ack on a
        // LIVE connection lets the client fold later ops into confirmed
        // state, and the op's own re-ack then arrives with a server position
        // BELOW them — a history the server never had, and one no
        // implementation can repair in place (confirmed state is a replay;
        // you cannot insert into the middle of it). Under TCP that ack cannot
        // be late: it rides the same connection ahead of those ops, and if the
        // connection dies the op simply stays pending and comes back through
        // the GATED resend path, which orders it by its server position.
        const c = clients[pickIndex(clients.length)]!;
        if (rand() < 0.5 && c.outbox.length) {
          c.outbox.splice(pickIndex(c.outbox.length), 1);
          stats.drops++;
        } else if (c.connected) {
          disconnect(c); // suffix loss both ways — the real shape of s2c loss
          stats.drops++;
        }
      } else if (r < 0.87) {
        const c = clients[pickIndex(clients.length)]!;
        if (c.connected) disconnect(c);
        else reconnect(c);
      } else if (r < 0.91) {
        const c = clients[pickIndex(clients.length)]!;
        if (c.connected) await c.engine.requestSync();
      } else if (r < 0.95) {
        await compact();
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
        for (const cell of CELLS) {
          if ((await c.buffer.getUnconfirmed(cell)).length > 0) drained = false;
        }
      }
    }

    // ── invariants ─────────────────────────────────────────────────────
    // (d) pending buffers drained
    for (const c of clients) {
      for (const cell of CELLS) {
        const pending = await c.buffer.getUnconfirmed(cell);
        assertEquals(
          pending.length,
          0,
          `client c${c.i}: pending ops did not drain (${cell})`,
        );
      }
    }
    const dupsOf = (ids: string[]) =>
      [...ids].sort().filter((id, i, a) => id === a[i - 1]);
    // (c) exactly-once on the server: every issued op applied once, none lost,
    // none doubled — refused ops (clock drift) excluded, they exist nowhere.
    const serverJournal = CELLS.flatMap((cell) =>
      asApplied(serverState[cell]!)
    );
    assertEquals(dupsOf(serverJournal), [], "server applied op(s) twice");
    assertEquals(
      [...serverJournal].sort(),
      [...issued].filter((id) => !rejected.has(id)).sort(),
      "server journal != the ops that were issued and accepted",
    );
    // (a)+(b)+(c) every client converges to the server — per cell, exactly
    // once, and in the SERVER's sequence, not merely with the same contents.
    for (const c of clients) {
      for (const cell of CELLS) {
        assertEquals(
          dupsOf(asApplied(c.confirmed(cell))),
          [],
          `client c${c.i} applied op(s) twice (${cell})`,
        );
        assertEquals(
          canon(c.confirmed(cell)),
          canon(serverState[cell]!),
          `client c${c.i} confirmed state diverged (${cell})`,
        );
        assertEquals(
          canon(c.optimistic(cell)),
          canon(serverState[cell]!),
          `client c${c.i} optimistic state diverged (${cell})`,
        );
        assertEquals(
          asApplied(c.confirmed(cell)),
          asApplied(serverState[cell]!),
          `client c${c.i} applied the ops of ${cell} in a different ORDER ` +
            `than the server`,
        );
      }
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
  // A seed we cannot read must THROW: pasting a failure's replay line with a
  // typo used to run seed 0 and report a confident green for a program nobody
  // asked for (see tests/fuzz-seed.ts).
  const hasEnv = Deno.env.get("SYNC_CHAOS_SEED") !== undefined;
  const env = hasEnv ? fuzzEnvInt("SYNC_CHAOS_SEED", 0) : undefined;
  const timeSeed = Date.now() >>> 0;
  const stats: Stats = {
    ops: 0,
    dupsInjected: 0,
    drops: 0,
    reconnects: 0,
    restarts: 0,
    compactions: 0,
    clientDedupDrops: 0,
    serverDedupDrops: 0,
    driftRejected: 0,
    conflicts: 0,
    destructive: 0,
  };

  if (env !== undefined) {
    const seed = env >>> 0;
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
      `compactions=${stats.compactions} destructive=${stats.destructive} ` +
      `driftRejected=${stats.driftRejected} conflicts=${stats.conflicts} ` +
      `dedupDrops(client=${stats.clientDedupDrops}, server=${stats.serverDedupDrops})`,
  );
  // ── coverage of the SEED SET, never of one episode ───────────────────
  // Every assertion below says "this suite exercised X". That is a property
  // of the whole seed set, not of any single schedule: a replayed episode may
  // legitimately never compact, never duplicate, never roll a wild skew.
  // Applying them to a replay made `SYNC_CHAOS_SEED=<n>` — the line the
  // failure message tells you to paste — report FAILED for a seed that
  // converged perfectly, with a message ("chaos never exercised client-side
  // dedup") that reads as a finding. A replay must answer exactly one
  // question: did THIS schedule converge. (Only `driftRejected` had this
  // gate; the other four had drifted away from it.)
  if (env !== undefined) return;
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
  // Compaction is the boundary where a cursor bug means ops that exist
  // NOWHERE any more — an episode set that never compacts proves nothing
  // about catch-up.
  assert(
    stats.compactions > 0,
    "chaos never compacted the op-log",
  );
  // Order-sensitive ops are the whole point of the second half of this suite:
  // an append-only fuzz cannot tell a wrong ORDER from a right one.
  assert(
    stats.destructive > 0,
    "chaos never issued a remove/overwrite/counter op",
  );
  // The clock-skew axis must actually reach the server's refusal (M5) —
  // otherwise the rejection path is asserted by nothing.
  assert(
    stats.driftRejected > 0,
    "chaos never produced an op the server refused for clock drift",
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
