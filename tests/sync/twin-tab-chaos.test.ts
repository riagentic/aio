// tests/sync/twin-tab-chaos.test.ts — randomized model of TABS: several tabs
// of one browser profile share the offline queue (one localStorage document
// per cell, one persisted client id), next to other profiles, against one
// server. `sync-chaos.test.ts` fuzzes clients that each own their queue; it
// structurally cannot produce the twin-tab races, and it never produces a
// refusal the server DECIDES (a method that throws on the server's state).
//
// Built by the r4 sync hunt (2026-09-19) to attack the r3 fixes. It found two
// bugs those fixes left (twin-tab-peer-op.test.ts and
// resync-survives-reconnect.test.ts), and each of the three r3 fixes is
// load-bearing under it — disabling any one of them fails episodes.
//
// Model:
//  - one or two profiles, the first with 2–3 tabs on one queue; real engines
//    on the real localStorage queue (one shim), the real server handler over
//    a real SQLite op-log. In half the episodes each tab reads its own cache
//    of it, which gets the other tabs' writes only a moment later (a second
//    RNG decides when, so a seed's main sequence is the same either way).
//  - A non-commutative, refusable cell: `add` (unique value), `put` (a value
//    from a small pool — refused when present), `rm` / `top` (refused when
//    absent) — so the server refuses ops the origin accepted, and an op it
//    refused could succeed if dispatched again later.
//  - client→server: any frame of a tab's outbox, in any order, sometimes
//    duplicated; server→client: FIFO per connection, acks/ops sometimes
//    duplicated right after the original; disconnects lose both queues;
//    tabs close mid-flight, close right after queueing a change (before
//    their twins saw the write), reload (a new session on the same queue), ask
//    for catch-ups at random, and in a quarter of the episodes a small frame
//    budget slices every flush.
// Invariants after quiescence: every open tab's confirmed state AND view
// equal the server's; the server holds no duplicate; no op is both acked and
// refused; every open profile's queue drains, and every `add` call that
// resolved in it reached the server; the network goes quiet (no re-sync
// storm).
//
// Replay one episode: TWIN_CHAOS_SEED=<seed> (add TWIN_CHAOS_TRACE=1 for the
// frame log); widen a sweep with TWIN_CHAOS_EPISODES=<n>.
import { assert } from "@std/assert";
import { fuzzEnvInt } from "../fuzz-seed.ts";
import { createServerSyncHandler } from "../../src/sync/server-handler.ts";
import { _resetServerTsForTest } from "../../src/sync/server-store.ts";
import { createOpBuffer, type OpBuffer } from "../../src/sync/op-buffer.ts";
import {
  createSyncEngine,
  type SyncEngine,
} from "../../src/sync/sync-engine.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";
import type { HLC } from "../../src/sync/types.ts";
import { REDUCER_FAILED } from "../../src/sync/rebase.ts";
import {
  parseProtoHello,
  rememberPeerHello,
} from "../../src/protocol/protocol-version.ts";
import { createTestDb } from "./_test-db.ts";
import { tabViews } from "./_tab-views.ts";

type State = { items: string[] };
type Frame = { t: string; d: Record<string, unknown> };

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

/** The cell's method — the server dispatches it, every tab replays it. */
function apply(s: State, action: string, v: unknown): State {
  const items = s.items ?? [];
  const has = items.includes(v as string);
  if (action === "add") return { items: [...items, v as string] };
  if (action === "put") {
    if (has) throw new Error(`already has ${v}`);
    return { items: [...items, v as string] };
  }
  if (!has) throw new Error(`no ${v}`);
  if (action === "rm") return { items: items.filter((x) => x !== v) };
  if (action === "top") {
    return { items: [v as string, ...items.filter((x) => x !== v)] };
  }
  throw new Error(`unknown action ${action}`);
}

interface Tab {
  name: string;
  profile: string;
  engine: SyncEngine;
  buffer: OpBuffer;
  confirmed: State;
  view: State;
  outbox: string[];
  inbox: string[];
  conn: { live: boolean; socket: WebSocket };
  online: boolean;
  closed: boolean;
  /** How many times THIS tab's `sync.onRejected` fired, per op id. A refused
   *  change is one change: the server re-refuses an op it already refused
   *  (`refuseIfRefusedBefore`), so the same refusal reaches a tab more than
   *  once, and the app must hear it once. */
  rejected: Map<string, number>;
  /** This tab's localStorage cache (see `shimLocalStorage`). */
  idx: number;
}

interface Stats {
  refused: number;
  twins: number;
  closes: number;
  reloads: number;
  dies: number;
}

async function episode(seed: number, stats: Stats): Promise<string[]> {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const trace = Deno.env.get("TWIN_CHAOS_TRACE") === "1";
  const say = (m: string) => trace && console.log(m);
  _resetServerTsForTest();
  const ls = tabViews();
  // Stale caches: decided by their own RNG, so the main sequence is untouched.
  const late = mulberry32(seed ^ 0x5bd1e995);
  const stale = late() < 0.5;
  const sliced = rnd() < 0.25;
  if (sliced) {
    // Every reconnect flush goes out in slices of a couple of ops.
    rememberPeerHello(
      parseProtoHello({ v: 3, min: 3, maxMessageBytes: 1500 })!,
    );
  }
  const { db, close } = createTestDb();
  let live: State = { items: [] };
  const added = new Set<string>(); // every `add` the server ever applied
  const tabs: Tab[] = [];
  const refused = new Set<string>();
  const acked = new Set<string>();
  const problems: string[] = [];
  const handler = createServerSyncHandler({
    dispatch: (a) => {
      const action = a.type.slice(a.type.indexOf(":") + 1);
      live = apply(live, action, a.payload);
      if (action === "add") added.add(a.payload as string);
    },
    db,
    syncCellIds: ["c"],
    getCellState: () => live,
    getClientCellState: () => live,
    broadcastRaw: {
      fn: (m, exclude) => {
        for (const t of tabs) {
          if (t.conn.live && t.conn.socket !== exclude) t.inbox.push(m);
        }
      },
    },
    log: { debug: () => {}, warn: () => {}, error: () => {} },
  });

  function connect(t: Tab): void {
    const conn = { live: true, socket: null as unknown as WebSocket };
    conn.socket = {
      readyState: 1,
      send: (m: string) => {
        if (!conn.live) return;
        const f: Frame = JSON.parse(m);
        const id = f.d.opId as string;
        if (f.t === "op-rejected") {
          if (!refused.has(id)) stats.refused++;
          refused.add(id);
          if (acked.has(id)) problems.push(`${id} refused after an ack`);
        } else if (f.t === "sync-ack") {
          acked.add(id);
          if (refused.has(id)) problems.push(`${id} acked after a refusal`);
        }
        t.inbox.push(m);
      },
    } as unknown as WebSocket;
    t.conn = conn;
  }

  function addTab(profile: string): Tab {
    const { idx, s } = ls.open(`q-${profile}`, !stale);
    const buffer = createOpBuffer(s);
    const t = {
      name: `${profile}#${tabs.length}`,
      profile,
      buffer,
      confirmed: { items: [] },
      view: { items: [] },
      outbox: [],
      inbox: [],
      online: true,
      closed: false,
      rejected: new Map<string, number>(),
      idx,
    } as unknown as Tab;
    connect(t);
    t.engine = createSyncEngine({
      clientId: profile,
      cells: {
        c: normalizeSyncConfig({
          onRejected: ({ opId }) =>
            t.rejected.set(opId, (t.rejected.get(opId) ?? 0) + 1),
        }),
      },
      buffer,
      send: (m) => void (t.online && t.outbox.push(m)),
      reducer: (s, a, p) => {
        try {
          return apply(s as State, a, p);
        } catch {
          return REDUCER_FAILED;
        }
      },
      getConfirmedState: () => ({ c: t.confirmed }),
      setConfirmedState: (_c, s) => void (t.confirmed = s as State),
      onStateUpdate: (_c, s) => void (t.view = s as State),
      catchupTimeoutMs: 1e9, // the model drives every catch-up itself
      log: { warn: () => {}, debug: () => {} },
    });
    tabs.push(t);
    return t;
  }

  async function toServer(t: Tab, i: number): Promise<void> {
    const f: Frame = JSON.parse(t.outbox.splice(i, 1)[0]!);
    say(`${t.name} => ${f.t} ${JSON.stringify(f.d).slice(0, 160)}`);
    if (f.t === "op") {
      await handler.handleOp(f.d, { id: t.name }, t.conn.socket);
    } else if (f.t === "sync-req") {
      handler.handleSync(f.d, { id: t.name }, t.conn.socket);
    }
  }
  async function toTab(t: Tab): Promise<void> {
    const f: Frame = JSON.parse(t.inbox.shift()!);
    say(`  ${t.name} <= ${f.t} ${JSON.stringify(f.d).slice(0, 160)}`);
    const d = f.d;
    if (f.t === "sync-ack") {
      await t.engine.handleAck(
        d.cell as string,
        d.opId as string,
        d.serverHlc as HLC,
        d.serverTs as number | undefined,
      );
    } else if (f.t === "op") {
      await t.engine.handleRemoteOp(d as never);
    } else if (f.t === "sync-res") {
      await t.engine.handleSyncResponse(d as never);
    } else if (f.t === "op-rejected") {
      await t.engine.handleRejection(
        d.cell as string,
        d.opId as string,
        d.reason as string,
      );
    }
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));
  function goOffline(t: Tab): void {
    say(`${t.name} offline`);
    t.conn.live = false;
    t.outbox.length = 0;
    t.inbox.length = 0;
    t.online = false;
    t.engine.setOnline(false);
  }
  function goOnline(t: Tab): void {
    say(`${t.name} online`);
    connect(t);
    t.online = true;
    t.engine.setOnline(true);
  }
  // A tab hears the others' writes within a millisecond, far sooner than a
  // person closes it: one that closes has heard everything written before —
  // unless it closes in the very moment of a call (`sudden`, below).
  function shut(t: Tab, sudden = false): void {
    if (!sudden) ls.deliver(t.idx);
    goOffline(t);
    t.closed = true;
    t.engine.dispose();
    ls.kill(t.idx);
  }

  // Always a profile with twin tabs; mostly a second profile beside it.
  const profiles = rnd() < 0.8 ? 2 : 1;
  for (let p = 0; p < profiles; p++) {
    const n = p === 0 ? 2 + Math.floor(rnd() * 2) : 1 + Math.floor(rnd() * 2);
    if (n > 1) stats.twins++;
    for (let i = 0; i < n; i++) addTab(`p${p}`);
  }
  let nextVal = 0;
  const calls: [profile: string, v: string][] = []; // resolved `add` calls
  try {
    for (const t of tabs) await t.engine.requestSync();
    for (let step = 0; step < 200; step++) {
      const open = tabs.filter((t) => !t.closed);
      const t = pick(open);
      if (stale && late() < 0.3) {
        ls.deliver(tabs[Math.floor(late() * tabs.length)]!.idx);
      }
      const r = rnd();
      if (r < 0.25) {
        const items = t.view.items ?? [];
        const roll = rnd();
        const [action, v] = items.length > 0 && roll < 0.3
          ? ["rm", pick(items)]
          : items.length > 0 && roll < 0.45
          ? ["top", pick(items)]
          : roll < 0.7
          ? ["put", `k${Math.floor(rnd() * 4)}`]
          : ["add", `v${nextVal++}`];
        say(`${t.name} ${action}(${v})`);
        // A method that throws on the tab's own view rejects the call and
        // is never queued — the model's `put`/`rm` do that by design.
        await t.engine.handleLocalAction("c", action, v).then(
          () => action === "add" && calls.push([t.profile, v]),
          () => {},
        );
      } else if (r < 0.5) {
        if (t.outbox.length) {
          const i = Math.floor(rnd() * t.outbox.length);
          if (rnd() < 0.1) t.outbox.push(t.outbox[i]!);
          await toServer(t, i);
        }
      } else if (r < 0.8) {
        if (t.inbox.length) {
          const f: Frame = JSON.parse(t.inbox[0]!);
          if (
            rnd() < 0.05 &&
            (f.t === "sync-ack" || f.t === "op" || f.t === "op-rejected")
          ) {
            t.inbox.splice(1, 0, t.inbox[0]!);
          }
          await toTab(t);
        }
      } else if (r < 0.86) {
        if (t.online) goOffline(t);
        else goOnline(t);
      } else if (r < 0.9) {
        await t.engine.requestSync();
      } else if (r < 0.905 && open.length > 1) {
        say(`${t.name} closes`);
        stats.closes++;
        shut(t);
      } else if (
        r < 0.912 && open.some((o) => o !== t && o.profile === t.profile)
      ) {
        // Queues a change and closes at once: its twins may not have seen
        // the write yet when they write the queue back. (It has heard what
        // came before its call — that was a click ago.)
        const v = `v${nextVal++}`;
        say(`${t.name} add(${v}) and closes`);
        ls.deliver(t.idx);
        await t.engine.handleLocalAction("c", "add", v);
        calls.push([t.profile, v]);
        stats.dies++;
        shut(t, true);
      } else if (r < 0.92) {
        say(`${t.name} reloads`);
        stats.reloads++;
        shut(t);
        await addTab(t.profile).engine.requestSync();
      }
      await tick();
    }

    // Quiesce: everyone online, every frame delivered, then two more rounds
    // of catch-ups so anything asked for has been answered.
    for (let round = 0; round < 3; round++) {
      for (const t of tabs) ls.deliver(t.idx);
      for (const t of tabs) if (!t.closed && !t.online) goOnline(t);
      let idle = 0;
      let i = 0;
      for (; i < 2000 && idle < 6; i++) {
        let moved = false;
        for (const t of tabs) {
          while (!t.closed && t.outbox.length) {
            moved = true;
            await toServer(t, 0);
          }
        }
        for (const t of tabs) ls.deliver(t.idx);
        await tick();
        for (const t of tabs) {
          while (!t.closed && t.inbox.length) {
            moved = true;
            await toTab(t);
          }
        }
        await tick();
        idle = moved ? 0 : idle + 1;
      }
      if (i >= 2000) problems.push(`the network never went quiet (${round})`);
      if (round < 2) {
        for (const t of tabs) if (!t.closed) await t.engine.requestSync();
      }
    }

    const want = JSON.stringify(live);
    // A call that resolved is a change the server gets, while its profile
    // has a tab open to send it — whoever queued it, and whenever it closed.
    for (const [profile, v] of calls) {
      if (
        !added.has(v) && tabs.some((t) => !t.closed && t.profile === profile)
      ) problems.push(`${profile}'s add(${v}) never reached the server`);
    }
    if (new Set(live.items).size !== live.items.length) {
      problems.push(`the server holds a duplicate: ${want}`);
    }
    // One refused change is ONE refusal report — the server re-refuses an op
    // it already refused, so a tab is told the same refusal more than once.
    // Counted over the whole episode, closed tabs included: the engine that
    // heard it is the one that must not repeat it.
    for (const t of tabs) {
      for (const [opId, n] of t.rejected) {
        if (n > 1) {
          problems.push(`${t.name} reported the refusal of ${opId} ${n}×`);
        }
      }
    }
    const drained = new Set<string>();
    for (const t of tabs) {
      if (t.closed) continue;
      const got = JSON.stringify(t.confirmed);
      if (got !== want) problems.push(`${t.name} confirmed ${got} ≠ ${want}`);
      const seen = JSON.stringify(t.view);
      if (seen !== want) problems.push(`${t.name} shows ${seen} ≠ ${want}`);
      if (drained.has(t.profile)) continue;
      drained.add(t.profile);
      const left = await t.buffer.getUnconfirmed("c");
      if (left.length > 0) {
        problems.push(
          `${t.profile}'s queue kept ${left.map((o) => o.id).join(",")}`,
        );
      }
    }
  } finally {
    for (const t of tabs) t.engine.dispose();
    await handler.flushServerWrites();
    close();
    delete (globalThis as Record<string, unknown>).__aioPeerHello;
  }
  return problems;
}

// Seeds that FAIL on the engine as it was before the r4 fixes (the model's
// own regression check — a rate of ~11% per random episode, pinned here so a
// regression is caught in the first four rather than on average).
const HARDCODED_SEEDS = [9001, 9004, 9025, 9030];

Deno.test("sync twin-tab chaos: tabs sharing a queue converge on the server's state", async () => {
  const stats: Stats = {
    refused: 0,
    twins: 0,
    closes: 0,
    reloads: 0,
    dies: 0,
  };
  const hasEnv = Deno.env.get("TWIN_CHAOS_SEED") !== undefined;
  const run = async (seed: number) => {
    const problems = await episode(seed, stats);
    assert(
      problems.length === 0,
      `seed ${seed}: ${problems.join(" | ")}\nreplay with: ` +
        `TWIN_CHAOS_SEED=${seed} deno test -A tests/sync/twin-tab-chaos.test.ts`,
    );
  };
  if (hasEnv) {
    await run(fuzzEnvInt("TWIN_CHAOS_SEED", 0));
    return;
  }
  const episodes = fuzzEnvInt("TWIN_CHAOS_EPISODES", 24, 1);
  const timeSeed = Date.now() >>> 0;
  console.log(`[twin-chaos] time-derived seed base=${timeSeed}`);
  for (const s of HARDCODED_SEEDS) await run(s);
  for (let ep = 0; ep < episodes; ep++) {
    await run((timeSeed + ep * 0x9E3779B9) >>> 0);
  }
  console.log(`[twin-chaos] ok — ${JSON.stringify(stats)}`);
  // Coverage of the seed set: a model that never produced these proves
  // nothing about them.
  assert(stats.twins > 0, "no episode had two tabs on one queue");
  assert(stats.refused > 0, "no episode had a refusal the server decided");
  assert(stats.reloads + stats.closes > 0, "no tab ever closed or reloaded");
  assert(stats.dies > 0, "no tab ever closed right after queueing");
});
