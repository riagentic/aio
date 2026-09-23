// tests/sync/properties/offline-replay.test.ts — offline replay, re-delivery
// and compaction as ONE seeded property, closed by the REAL boot replay.
//
// The real client engine and the real server handler over a real SQLite
// op-log (`../_net.ts`). Each case runs N clients through a random program:
// local ops while online or OFFLINE (queued, replayed on reconnect), frames
// delivered in random order client→server and FIFO server→client, with
// DUPLICATES both ways, connections that die and lose their queues, server-
// origin writes, and forced compactions (the snapshot fold that DELETES the
// ops it folded). Sync has no global op-id dedup on the client — the cursor
// and the per-op checks are what keep a re-delivered op from applying twice —
// so the ledger is exact: every op carries a unique id appended to `log`.
//
// After quiescence, and at random quiescent checkpoints in between:
//  (a) every client's confirmed AND optimistic view equal the server's state
//      — convergence to ONE serial order, the server's apply order;
//  (b) every op the server accepted is in that state exactly once (a
//      duplicate = a re-delivery double-applied, a missing id = a lost op),
//      and nothing is in it that nobody issued;
//  (c) the catch-up cursor never moves backward;
//  (d) BOOT: `replaySyncOps` (the function `aio.run` calls) over the same
//      database rebuilds exactly the live state from nothing — the serial
//      order the op-log + snapshot record IS the order the server applied.
//      After a compaction the log alone is only the tail: a boot that does
//      not seed from `sync_snapshots` resurrects the cell EMPTY (a past bug).
//
// `sync-chaos.test.ts` fuzzes the same network harder and restarts the
// server, but models the boot replay with its own inline fold; (d) is the
// one place the shipped replay is held to the live state under a random
// history.
import { assert, assertEquals } from "@std/assert";
import { createNet, type NetClient, type State } from "../_net.ts";
import { replaySyncOps } from "../../../src/server/aio-boot.ts";
import type { HLC } from "../../../src/sync/types.ts";
import { forAllSeeds, type Rng, rngOf } from "./_prop.ts";

const FILE = "tests/sync/properties/offline-replay.test.ts";
const CELL = "board";

type Board = { items: string[]; log: string[]; n: number; srv: number };
const initial = (): State => ({ items: [], log: [], n: 0, srv: 0 });

/** The cell's methods, pure. `del` makes ORDER matter (a wrong serial order
 *  is a wrong answer no set comparison can see); `inc` commutes. */
function apply(s: State, action: string, payload: unknown): State {
  const b = s as Board;
  const p = payload as { id: string; k?: number };
  const log = [...b.log, p.id];
  if (action === "add") return { ...b, items: [...b.items, p.id], log };
  if (action === "del") return { ...b, items: b.items.slice(1), log };
  if (action === "inc") return { ...b, n: b.n + (p.k ?? 1), log };
  throw new Error(`unknown action ${action}`);
}

/** A second sync cell that `listensTo` the board's `add`: its reaction is
 *  no op of its own — it is folded into its own snapshot by the server-write
 *  path, and boot replay must neither lose it nor re-apply it. */
const MIRROR = "mirror";
type Mirror = { got: string[] };
const mirrorInitial = (): State => ({ got: [] });
function react(s: State, action: string, payload: unknown): State {
  if (action !== "add") return s; // no change → nothing to fold
  return { got: [...(s as Mirror).got, (payload as { id: string }).id] };
}

/** The composed root reducer, the shape `aio.run` hands `replaySyncOps`:
 *  the owner's method AND every listener run in one reduce. */
/** A DIRECT op on the listener (its own method): interleaved with its
 *  reactions, and ordered with them only by the op-log/snapshot. */
function mirrorOwn(s: State, action: string, payload: unknown): State {
  if (action !== "mdirect") throw new Error(`unknown mirror action ${action}`);
  return { got: [...(s as Mirror).got, `d:${(payload as { id: string }).id}`] };
}

const reduceRoot = (
  root: Record<string, unknown>,
  a: { type: string; payload?: unknown },
) => {
  const action = a.type.slice(a.type.indexOf(":") + 1);
  if (a.type.startsWith(`${MIRROR}:`)) {
    return {
      ...root,
      [MIRROR]: mirrorOwn(root[MIRROR] as State, action, a.payload),
    };
  }
  return {
    ...root,
    [CELL]: apply(root[CELL] as State, action, a.payload),
    [MIRROR]: react(root[MIRROR] as State, action, a.payload),
  };
};

const silent = { info() {}, warn() {}, error() {} };

async function episode(
  rng: Rng,
  /** Seeded scheduling jitter at the handler's await points (see
   *  `createNet`'s `jitter`) — its own stream, so the program is the same. */
  jitter?: Rng,
): Promise<{ ops: number; compactions: number }> {
  let seq = 0, quiet = false;
  const issued = new Set<string>();
  const serverWrite = () => {
    const id = `srv-${++seq}`;
    issued.add(id);
    net.serverWrite((s) => {
      const b = s as Board;
      return { ...b, srv: b.srv + 1, log: [...b.log, id] };
    });
  };
  const net = createNet({
    cell: CELL,
    initial,
    apply,
    jitter,
    // …and, under jitter, a server-origin write may land at any of them.
    // (Not while quiescing: a checkpoint compares a settled server with its
    // clients, and a write that lands inside the final flush is one the
    // flush did not wait for — by definition, not a quiet network.)
    atYield: jitter && (() => {
      if (!quiet && jitter.chance(0.03)) serverWrite();
    }),
    listener: {
      cell: MIRROR,
      initial: mirrorInitial,
      react,
      own: { actions: ["mdirect"], apply: mirrorOwn },
    },
  });
  const gens = new Map<NetClient, number>();
  const rejected = new Set<string>();
  const cursors = new Map<NetClient, number>();
  const addIds = new Set<string>();
  const directIds = new Set<string>();
  let compactions = 0;

  /** A fresh connection: frames addressed to the old one die with it. */
  const connect = (c: NetClient) => {
    const g = (gens.get(c) ?? 0) + 1;
    gens.set(c, g);
    c.socket = {
      readyState: 1,
      send: (m: string) => {
        if (gens.get(c) === g && c.online) c.inbox.push(m);
      },
    } as unknown as WebSocket;
  };
  const disconnect = (c: NetClient) => {
    c.online = false;
    c.engine.setOnline(false);
    c.outbox.length = 0; // the connection's queues die with it, both ways
    c.inbox.length = 0;
    gens.set(c, (gens.get(c) ?? 0) + 1);
  };
  const reconnect = (c: NetClient) => {
    connect(c);
    c.online = true;
    c.engine.setOnline(true); // resend the offline queue + a catch-up sync
  };

  try {
    const clients = Array.from(
      { length: 2 + rng.int(3) },
      (_, i) => net.addClient(`c${i}`),
    );
    for (const c of clients) connect(c);

    /** Client→server: any queued frame (reorder), maybe duplicated. */
    const deliverUp = async (c: NetClient, chaos = true) => {
      if (!c.outbox.length) return;
      const [raw] = c.outbox.splice(chaos ? rng.int(c.outbox.length) : 0, 1);
      if (chaos && rng.chance(0.15)) {
        c.outbox.splice(rng.int(c.outbox.length + 1), 0, raw!);
      }
      const f = JSON.parse(raw!);
      if (f.t === "op") {
        await net.handler.handleOp(f.d, { id: c.name }, c.socket);
      } else if (f.t === "sync-req") {
        net.handler.handleSync(f.d, { id: c.name }, c.socket);
      }
    };
    /** Server→client: FIFO (TCP never reorders originals), but a duplicate
     *  may arrive any time AFTER its original. */
    const deliverDown = async (c: NetClient, chaos = true) => {
      if (!c.inbox.length) return;
      const raw = c.inbox.shift()!;
      if (chaos && rng.chance(0.15)) {
        c.inbox.splice(rng.int(c.inbox.length + 1), 0, raw);
      }
      const f = JSON.parse(raw);
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
        rejected.add(f.d.opId);
        await c.engine.handleRejection(f.d.cell, f.d.opId, f.d.reason);
      }
    };
    // A microtask turn between steps: the handler's floating work settles
    // (it is promise-based); timers — op pacing — get their turn in `drain`.
    const tick = () => new Promise<void>((r) => queueMicrotask(r));

    /** (c): the catch-up cursor only ever moves forward. */
    const checkCursors = async () => {
      for (const c of clients) {
        const ts = (await c.buffer.getMeta(CELL))?.lastServerTs ?? 0;
        const was = cursors.get(c) ?? 0;
        assert(ts >= was, `${c.name}: cursor moved backward ${was} → ${ts}`);
        cursors.set(c, ts);
      }
    };

    /** Deliver everything both ways, in order, until nothing moves. */
    const drain = async () => {
      for (let idle = 0, i = 0; idle < 3; i++) {
        assert(i < 2000, "network never went quiet");
        let moved = false;
        for (const c of clients) {
          while (c.outbox.length) (moved = true), await deliverUp(c, false);
        }
        await new Promise((r) => setTimeout(r, 1));
        for (const c of clients) {
          while (c.inbox.length) (moved = true), await deliverDown(c, false);
        }
        await new Promise((r) => setTimeout(r, 1));
        idle = moved ? 0 : idle + 1;
      }
    };

    /** Everyone online, every frame delivered, every fold flushed. */
    const quiesce = async () => {
      quiet = true;
      for (const c of clients) if (!c.online) reconnect(c);
      await drain();
      await net.handler.flushServerWrites();
      await drain();
    };

    /** (a) (b) (d) at a quiescent point. */
    const checkConverged = async (where: string) => {
      const live = net.live() as Board;
      const liveM = net.liveOf(MIRROR) as Mirror;
      for (const c of clients) {
        assertEquals(c.confirmed(), live, `${where}: ${c.name} confirmed`);
        assertEquals(c.view(), live, `${where}: ${c.name} view`);
        assertEquals(
          c.confirmedOf(MIRROR),
          liveM,
          `${where}: ${c.name} mirror`,
        );
        assertEquals(
          c.viewOf(MIRROR),
          liveM,
          `${where}: ${c.name} mirror view`,
        );
        assertEquals(
          (await c.buffer.getUnconfirmed(CELL)).length,
          0,
          `${where}: ${c.name} still has pending ops`,
        );
      }
      const counts = new Map<string, number>();
      for (const id of live.log) counts.set(id, (counts.get(id) ?? 0) + 1);
      for (const [id, k] of counts) {
        assertEquals(k, 1, `${where}: ${id} applied ${k}×`);
        assert(issued.has(id), `${where}: ${id} was never issued`);
      }
      // The listener saw every accepted `add` exactly once, in server order,
      // and holds every direct op on it exactly once.
      assertEquals(
        liveM.got.filter((x) => !x.startsWith("d:")),
        live.log.filter((id) => addIds.has(id)),
        `${where}: mirror ≠ the board's adds`,
      );
      const directs = liveM.got.filter((x) => x.startsWith("d:"));
      assertEquals(
        new Set(directs).size,
        directs.length,
        `${where}: direct 2×`,
      );
      for (const d of directs) assert(directIds.has(d.slice(2)), d);
      // Every issued op is applied, or was refused (and said so).
      const applied = counts.size + directs.length;
      assertEquals(
        issued.size - applied,
        rejected.size,
        `${where}: ${issued.size - applied} ops missing, ` +
          `${rejected.size} refused`,
      );
      const init = { [CELL]: initial(), [MIRROR]: mirrorInitial() };
      const booted = await replaySyncOps(
        net.db,
        // Boot replays cells in declaration order, and a listener may be
        // declared before OR after the cell it listens to.
        rng.chance(0.5) ? [CELL, MIRROR] : [MIRROR, CELL],
        reduceRoot,
        { ...init } as Record<string, unknown>,
        silent,
        { dev: true, initialState: init },
      );
      assertEquals(
        booted[CELL],
        live,
        `${where}: boot replay (snapshot + op-log) ≠ live state`,
      );
      assertEquals(
        booted[MIRROR],
        liveM,
        `${where}: boot replay lost or re-applied the listener's reaction`,
      );
    };

    const steps = 100 + rng.int(100);
    for (let step = 0; step < steps; step++) {
      const c = rng.pick(clients);
      const r = rng();
      if (r < 0.3) {
        const id = `${c.name}-${++seq}`;
        issued.add(id);
        const action = rng.pick(
          ["add", "add", "del", "inc", "mdirect"] as const,
        );
        if (action === "add") addIds.add(id);
        if (action === "mdirect") directIds.add(id);
        await c.engine.handleLocalAction(
          action === "mdirect" ? MIRROR : CELL,
          action,
          { id, k: 1 + rng.int(5) },
        );
      } else if (r < 0.62) {
        // A burst of network traffic, any client, either direction.
        for (let k = rng.int(7); k >= 0; k--) {
          const d = rng.pick(clients);
          await (rng.chance(0.45) ? deliverUp(d) : deliverDown(d));
        }
      } else if (r < 0.74) {
        if (c.online) disconnect(c);
        else reconnect(c);
      } else if (r < 0.8) {
        // A flapping connection: back, peers' traffic reaches it AHEAD of its
        // own catch-up answer, and gone again before that answer lands — the
        // window the engine's catch-up hold exists for (a broadcast folded
        // there, or a cursor moved by one, would seal ops this client missed
        // while offline).
        const f = clients.find((d) => !d.online) ?? c;
        if (!f.online) reconnect(f);
        for (const d of clients) {
          if (d !== f) { while (d.outbox.length) await deliverUp(d, false); }
        }
        for (let k = rng.int(3); k >= 0; k--) await deliverDown(f);
        disconnect(f);
      } else if (r < 0.83) {
        serverWrite();
      } else if (r < 0.9) {
        // Force a compaction: fold live state into the snapshot and delete
        // every op at/below it — what a server-origin write does.
        compactions++;
        net.handler.noteServerWrite(CELL);
        await net.handler.flushServerWrites();
      } else if (r < 0.95) {
        // An extra catch-up (the watchdog, a tab coming back to the front):
        // two answers in flight, and a duplicate may land after the newer.
        if (c.online) await c.engine.requestSync();
      } else {
        await quiesce();
        await checkConverged(`checkpoint @${step}`);
        quiet = false;
      }
      await tick();
      await checkCursors();
    }
    await quiesce();
    await checkCursors();
    await checkConverged("end");
    return { ops: seq, compactions };
  } finally {
    await net.close();
  }
}

Deno.test("sync property: offline replay + re-delivery + compaction converge exactly-once, and boot replay rebuilds the live state", async () => {
  let ops = 0, compactions = 0;
  const cases = await forAllSeeds(FILE, "offline replay", 40, async (rng) => {
    const r = await episode(rng);
    ops += r.ops;
    compactions += r.compactions;
  });
  // Never vacuous: the run as a whole issued ops and compacted.
  if (cases > 1) {
    assert(ops > cases * 10, `only ${ops} ops over ${cases} cases`);
    assert(compactions > cases, `only ${compactions} compactions`);
  }
});

// The same property with the handler's await points jittered. The test
// database answers in the same turn, so every await in the handler resolved
// in one fixed microtask order and a whole class of interleavings — a
// server-origin write landing between a catch-up's reserved position and its
// state read, which pushed two states at one position (the client kept the
// older, for good) — could not happen here, only in production. Each case
// draws its schedule from its own seed, so a failure replays exactly.
Deno.test("sync property: offline replay converges under seeded scheduling jitter at the handler's await points", async () => {
  let ops = 0;
  const cases = await forAllSeeds(
    FILE,
    "offline replay (jitter)",
    40,
    async (rng, seed) => {
      ops += (await episode(rng, rngOf((seed ^ 0x5bd1e995) >>> 0))).ops;
    },
    0x71773e5,
  );
  if (cases > 1) {
    assert(ops > cases * 10, `only ${ops} ops over ${cases} cases`);
  }
});
