// A `visible.forUser` cell's change goes out as a per-client DIFF, not as a
// full-state resend of every cell for every client (feedback/aipro.md §8).
//
// The properties pinned here:
//   1. EXACT — after every frame, each client's state equals its own view,
//      serialized (a randomized differential run over users, subscriptions,
//      raw + forUser cells, and whole-state sends from outside the round).
//   2. PRIVATE — a forUser change for user A never puts A's data on B's wire.
//   3. CHEAP — a one-field change in a forUser cell sends a patch, and a
//      round that leaves a client's view unchanged sends it nothing.
//   4. WIRE-COMPATIBLE — the ops are the ordinary `patches` frame, applied by
//      the one applier every client already uses (`applyWirePatches`).
import { assert, assertEquals } from "@std/assert";
import { enablePatches, freeze, produceWithPatches } from "immer";
import { createBroadcaster } from "../src/server/server-broadcast.ts";
import {
  createMemoizedUIState,
  createUdsBroadcastController,
} from "../src/server/aio-run-helpers.ts";
import { viewOps } from "../src/server/view-delta.ts";
import {
  type CellPatchStrategy,
  filterPatchesByStrategy,
} from "../src/state/state-filter.ts";
import { applyWirePatches, type WirePatch } from "../src/protocol/patch-ops.ts";
import {
  filterStateBySubs,
  type PatchEntry,
} from "../src/protocol/broadcast-utils.ts";
import type { ClientMeta } from "../src/server/server-ws.ts";
import type { AioUser } from "../src/server/aio-types.ts";
import { join } from "@std/path";
import { createUDSListener } from "../src/server/aio.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { localEndpoint, localIdle } from "./local-endpoint-helper.ts";
import { connectLocal } from "../src/server/local-listen.ts";

enablePatches();

/** What JSON makes of a value — what a client can hold. */
const wire = (v: unknown) => JSON.parse(JSON.stringify(v) ?? "null");

/** Seeded PRNG (mulberry32) — a failure names its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── 1a. The diff itself, against random values ────────────────────────────

function randValue(r: () => number, depth: number): unknown {
  const k = Math.floor(r() * (depth > 2 ? 6 : 10));
  switch (k) {
    case 0:
      return Math.floor(r() * 5);
    case 1:
      return ["a", "b", "c"][Math.floor(r() * 3)];
    case 2:
      return null;
    case 3:
      return r() < 0.5 ? undefined : true;
    case 4:
      return r() < 0.5 ? new Date(Math.floor(r() * 3) * 1e9) : NaN;
    case 5:
      return () => 1; // JSON drops it
    case 6:
    case 7: {
      const n = Math.floor(r() * 5);
      return Array.from({ length: n }, () => randValue(r, depth + 1));
    }
    default: {
      const o: Record<string, unknown> = {};
      for (const key of ["x", "y", "z", "__proto__", "w"]) {
        if (r() < 0.5) {
          Object.defineProperty(o, key, {
            value: randValue(r, depth + 1),
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
      }
      return o;
    }
  }
}

/** Mutate a random spot (copy-on-write, like Immer: untouched nodes shared). */
function mutate(r: () => number, v: unknown, depth = 0): unknown {
  if (v === null || typeof v !== "object" || v instanceof Date || r() < 0.2) {
    return randValue(r, depth);
  }
  if (Array.isArray(v)) {
    const out = [...v];
    const pick = r();
    if (pick < 0.25) {
      out.splice(
        Math.floor(r() * (out.length + 1)),
        0,
        randValue(r, depth + 1),
      );
    } else if (pick < 0.45 && out.length) {
      out.splice(Math.floor(r() * out.length), 1);
    } else if (out.length) {
      const i = Math.floor(r() * out.length);
      out[i] = mutate(r, out[i], depth + 1);
    }
    return out;
  }
  const keys = Object.keys(v);
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    Object.defineProperty(out, key, {
      value: (v as Record<string, unknown>)[key],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  if (keys.length && r() < 0.7) {
    const key = keys[Math.floor(r() * keys.length)]!;
    if (r() < 0.2) delete out[key];
    else out[key] = mutate(r, out[key], depth + 1);
  } else out[["x", "y", "q"][Math.floor(r() * 3)]!] = randValue(r, depth + 1);
  return out;
}

Deno.test("viewOps: client state after the ops equals the view, as JSON (property)", () => {
  for (let seed = 1; seed <= 400; seed++) {
    const r = rng(seed);
    const cells = ["a", "b"];
    let view: Record<string, unknown> = {
      a: randValue(r, 0),
      b: { rows: [randValue(r, 1)] },
    };
    // Start from a full frame (baseline unknown → whole slices).
    let client = wire(view) as Record<string, unknown>;
    let known: ReturnType<typeof viewOps>["next"] | undefined;
    for (let step = 0; step < 25; step++) {
      // Half the time the new view is frozen state, half it is a fresh
      // object the app built (and may MUTATE later — the baseline must not).
      const next: Record<string, unknown> = { ...view };
      const cell = cells[Math.floor(r() * cells.length)]!;
      next[cell] = mutate(r, view[cell]);
      if (r() < 0.1) delete next.b; // the cell vanished from the view
      if (r() < 0.5) freeze(next, true);
      const { ops, next: k } = viewOps(known, next, cells);
      const sent = JSON.parse(JSON.stringify(ops)) as WirePatch[];
      client = applyWirePatches(client, sent);
      assertEquals(client, wire(next), `seed ${seed} step ${step}`);
      if (
        next.a && typeof next.a === "object" && !Object.isFrozen(next.a)
      ) {
        // An app mutating its own view object after the send must not move
        // the baseline (it is a copy) — next round still diffs correctly.
        (next.a as Record<string, unknown>).late = 1;
      }
      known = k;
      view = next;
    }
  }
});

Deno.test("viewOps: an unchanged view is no ops; one changed row is one small op", () => {
  const rows = freeze(
    Array.from({ length: 200 }, (_, i) => ({ id: i, owner: "u1", p: 0 })),
    true,
  );
  const view1 = { broker: { reqs: rows.filter(() => true), n: 1 } };
  const first = viewOps(undefined, view1, ["broker"]);
  assertEquals(first.ops.length, 1, "unknown baseline: one whole-slice op");
  // Recomputed view (a fresh filter result) over the same frozen rows.
  const same = viewOps(first.next, {
    broker: { reqs: rows.filter(() => true), n: 1 },
  }, ["broker"]);
  assertEquals(same.ops, []);
  const changed = rows.map((x, i) => i === 7 ? freeze({ ...x, p: 50 }) : x);
  const one = viewOps(same.next, { broker: { reqs: changed, n: 1 } }, [
    "broker",
  ]);
  assertEquals(one.ops, [{
    op: "replace",
    path: ["broker", "reqs", 7, "p"],
    value: 50,
  }]);
});

// ── 1b + 2. The broadcaster, end to end, per user ─────────────────────────

type Req = { id: number; owner: string; status: string; note: string };
type S = {
  ticker: { n: number; log: number[] };
  broker: { reqs: Req[]; seq: number; pad?: string };
  pool: { models: { name: string; load: number }[]; secret: string };
};

const strategies = new Map<string, CellPatchStrategy>([
  ["ticker", "raw"],
  ["broker", "full"],
  ["pool", "full"],
]);

/** The forUser views: own requests only; `pool` hidden from non-admins. */
function rawView(s: S, user?: AioUser): Record<string, unknown> {
  const admin = user?.role === "admin";
  return {
    ticker: s.ticker,
    broker: {
      ...s.broker,
      reqs: s.broker.reqs.filter((q) => admin || q.owner === user?.id),
    },
    pool: admin ? s.pool : {},
  };
}

type Client = {
  ws: WebSocket;
  meta: ClientMeta;
  frames: string[];
  state: Record<string, unknown>;
};

function client(id: string, user: AioUser, subs: string[] | null): Client {
  const c = { frames: [] as string[], state: {} } as unknown as Client;
  c.ws = {
    readyState: 1,
    bufferedAmount: 0,
    send(msg: string) {
      c.frames.push(msg);
      const f = JSON.parse(msg) as { t: string; d: unknown };
      if (f.t === "state") c.state = f.d as Record<string, unknown>;
      else if (f.t === "patches") {
        c.state = applyWirePatches(c.state, f.d as WirePatch[]);
      }
    },
  } as unknown as WebSocket;
  c.meta = {
    id,
    index: 0,
    clientType: "browser",
    isElectron: false,
    msgCount: 0,
    bytesThisSec: 0,
    bpMultiplier: 1,
    bpConsecutiveLow: 0,
    bpLastSentAt: 0,
    subscriptions: subs ? new Set(subs) : null,
    disconnected: false,
    consecutiveDrops: 0,
    user,
  } as unknown as ClientMeta;
  return c;
}

/** What server-ws.ts does on connect / `subs` / `resync` / a user change. */
function outsideFullSend(c: Client, getUIState: (u?: AioUser) => unknown) {
  const msg = JSON.stringify(
    filterStateBySubs(getUIState(c.meta.user), c.meta.subscriptions),
  );
  c.ws.send(`{"v":2,"t":"state","d":${msg}}`);
  c.meta.lastFullJson = msg;
  c.meta.lastFullJsonStale = false;
  c.meta.needsFull = false;
  c.meta.skipped = undefined;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

Deno.test("broadcaster: every client holds exactly its own view after every round (differential, per user)", async () => {
  for (let seed = 1; seed <= 30; seed++) {
    const r = rng(seed);
    let state: S = freeze({
      ticker: { n: 0, log: [] },
      // Padding: below it most rounds cross the 50% patch-vs-full line and
      // go full, which is correct but tests the diff less.
      broker: { reqs: [], seq: 0, pad: "p".repeat(3000) },
      pool: { models: [{ name: "m", load: 0 }], secret: "POOL-SECRET" },
    }, true);
    const getUIState = createMemoizedUIState<S>(rawView);
    const users: AioUser[] = [
      { id: "alice", role: "user" },
      { id: "bob", role: "user" },
      { id: "root", role: "admin" },
    ] as AioUser[];
    const clients = [
      client("c0", users[0]!, null),
      client("c1", users[1]!, null),
      client("c2", users[2]!, null),
      client("c3", users[1]!, ["broker"]), // bob again, one cell only
    ];
    const connections = new Map(clients.map((c) => [c.ws, c.meta]));
    const view = (u?: AioUser) => getUIState(state, u);
    const b = createBroadcaster({
      connections,
      payloadStats: new Map(),
      getUIState: view,
      debug: () => {},
      syncIntervalMs: 0,
    });
    try {
      for (const c of clients) outsideFullSend(c, view); // the connect frame
      for (let round = 0; round < 40; round++) {
        const patches: PatchEntry[] = [];
        const commit = <K extends keyof S>(cell: K, fn: (d: S[K]) => void) => {
          const [next, ops] = produceWithPatches(state[cell], fn);
          state = freeze({ ...state, [cell]: next }, false);
          patches.push({ cell, ops });
        };
        for (let i = 0, n = 1 + Math.floor(r() * 3); i < n; i++) {
          const pick = r();
          if (pick < 0.2) commit("ticker", (d) => void d.log.push(d.n++));
          else if (pick < 0.45) {
            commit("broker", (d) => {
              const owner = ["alice", "bob", "root"][Math.floor(r() * 3)]!;
              d.reqs.push({
                id: d.seq++,
                owner,
                status: "queued",
                note: `private-to-${owner}-${d.seq}`,
              });
            });
          } else if (pick < 0.75 && state.broker.reqs.length) {
            const i = Math.floor(r() * state.broker.reqs.length);
            commit("broker", (d) => {
              d.reqs[i]!.status = ["run", "done", "err"][Math.floor(r() * 3)]!;
            });
          } else if (pick < 0.85 && state.broker.reqs.length) {
            const i = Math.floor(r() * state.broker.reqs.length);
            commit("broker", (d) => void d.reqs.splice(i, 1));
          } else commit("pool", (d) => void (d.models[0]!.load = round));
        }
        b.broadcast(filterPatchesByStrategy(patches, strategies, new Map()));
        await tick();
        if (r() < 0.1) {
          outsideFullSend(clients[Math.floor(r() * clients.length)]!, view);
        }
        for (const c of clients) {
          assertEquals(
            c.state,
            wire(filterStateBySubs(view(c.meta.user), c.meta.subscriptions)),
            `seed ${seed} round ${round} client ${c.meta.id}`,
          );
        }
      }
      // PRIVATE: nothing of alice's ever reached bob, nor the pool secret a
      // non-admin — in any frame, full or patch.
      for (const c of [clients[1]!, clients[3]!]) {
        const all = c.frames.join("\n");
        assert(!all.includes("private-to-alice"), `bob saw alice's data`);
        assert(!all.includes("private-to-root"), `bob saw root's data`);
        assert(!all.includes("POOL-SECRET"), `a non-admin saw the pool`);
      }
      assert(
        !clients[0]!.frames.join("\n").includes("private-to-bob"),
        "alice saw bob's data",
      );
      // …and it really ran on patches, not on resends.
      const kinds = clients[0]!.frames.map((f) => JSON.parse(f).t);
      assert(
        kinds.filter((k) => k === "patches").length >
          kinds.filter((k) => k === "state").length,
        `seed ${seed}: mostly full frames — ${kinds.join(",")}`,
      );
    } finally {
      b.shutdown();
    }
  }
});

Deno.test("broadcaster: a forUser change for alice sends bob nothing, and bob stays exact", async () => {
  let state: S = freeze({
    ticker: { n: 0, log: [] },
    broker: {
      reqs: [
        { id: 1, owner: "alice", status: "queued", note: "private-to-alice" },
        { id: 2, owner: "bob", status: "queued", note: "bob-own" },
      ],
      seq: 3,
      pad: "p".repeat(3000),
    },
    pool: { models: [], secret: "POOL-SECRET" },
  }, true);
  const getUIState = createMemoizedUIState<S>(rawView);
  const view = (u?: AioUser) => getUIState(state, u);
  const alice = client("a", { id: "alice", role: "user" } as AioUser, null);
  const bob = client("b", { id: "bob", role: "user" } as AioUser, null);
  const b = createBroadcaster({
    connections: new Map([[alice.ws, alice.meta], [bob.ws, bob.meta]]),
    payloadStats: new Map(),
    getUIState: view,
    debug: () => {},
    syncIntervalMs: 0,
  });
  try {
    outsideFullSend(alice, view);
    outsideFullSend(bob, view);
    // Twice: the first diff learns the baseline (whole slice), the second is
    // the steady state.
    for (const status of ["run", "done"]) {
      const before = bob.frames.length;
      const [broker, ops] = produceWithPatches(state.broker, (d) => {
        d.reqs[0]!.status = status;
        d.reqs[0]!.note = `private-to-alice-${status}`;
      });
      state = freeze({ ...state, broker }, false);
      b.broadcast(
        filterPatchesByStrategy(
          [{ cell: "broker", ops }],
          strategies,
          new Map(),
        ),
      );
      await tick();
      assertEquals(bob.state, wire(view(bob.meta.user)));
      assertEquals(alice.state, wire(view(alice.meta.user)));
      assert(!bob.frames.join("").includes("private-to-alice"));
      if (status === "done") {
        assertEquals(bob.frames.length, before, "bob's view did not change");
        assertEquals(
          JSON.parse(alice.frames.at(-1)!).d,
          [
            {
              op: "replace",
              path: ["broker", "reqs", 0, "status"],
              value: "done",
            },
            {
              op: "replace",
              path: ["broker", "reqs", 0, "note"],
              value: "private-to-alice-done",
            },
          ],
        );
      }
    }
  } finally {
    b.shutdown();
  }
});

// ── 3. Bytes per broadcast, before and after ──────────────────────────────

Deno.test("bytes per broadcast: one field of one row in a forUser cell (aipro shape)", async () => {
  const reqs = Array.from({ length: 300 }, (_, i) => ({
    id: i,
    owner: ["gt", "quant", "panel"][i % 3]!,
    status: "done",
    note: "x".repeat(250),
  }));
  let state: S = freeze({
    ticker: { n: 0, log: [] },
    broker: { reqs, seq: 300 },
    pool: {
      models: Array.from({ length: 200 }, (_, i) => ({
        name: `model-${i}-${"m".repeat(260)}`,
        load: 0,
      })),
      secret: "s",
    },
  }, true);
  const getUIState = createMemoizedUIState<S>(rawView);
  const view = (u?: AioUser) => getUIState(state, u);
  const clients = [
    client("panel", { id: "panel", role: "admin" } as AioUser, null),
    client("gt", { id: "gt", role: "user" } as AioUser, null),
    client("quant", { id: "quant", role: "user" } as AioUser, null),
  ];
  const b = createBroadcaster({
    connections: new Map(clients.map((c) => [c.ws, c.meta])),
    payloadStats: new Map(),
    getUIState: view,
    debug: () => {},
    syncIntervalMs: 0,
  });
  const sentBytes = () =>
    clients.reduce((n, c) => n + c.frames.reduce((m, f) => m + f.length, 0), 0);
  const bump = (i: number) => {
    const [broker, ops] = produceWithPatches(state.broker, (d) => {
      d.reqs[i]!.status = "run";
    });
    state = freeze({ ...state, broker }, false);
    return filterPatchesByStrategy(
      [{ cell: "broker", ops }],
      strategies,
      new Map(),
    );
  };
  try {
    for (const c of clients) outsideFullSend(c, view);
    // BEFORE: the old rule — the round was a full-state resend.
    let at = sentBytes();
    bump(1);
    b.broadcast(); // a force round is exactly what `undefined` used to mean
    await tick();
    const before = sentBytes() - at;
    // Warm-up: the first diff after a full frame learns each baseline.
    b.broadcast(bump(2));
    await tick();
    // AFTER: one field of one row (quant's), steady state.
    at = sentBytes();
    const gtFrames = clients[1]!.frames.length;
    b.broadcast(bump(4));
    await tick();
    const after = sentBytes() - at;
    for (const c of clients) {
      assertEquals(c.state, wire(view(c.meta.user)));
    }
    console.log(
      `forUser one-field change, 3 clients: before ${before} B, after ${after} B ` +
        `(${(before / after).toFixed(0)}× less)`,
    );
    assert(after * 100 < before, `after ${after} B vs before ${before} B`);
    // Only the panel (admin) and quant see row 4: gt's view is unchanged, so
    // gt was sent nothing at all.
    assertEquals(clients[1]!.frames.length, gtFrames);
  } finally {
    b.shutdown();
  }
});

// ── The desktop transport (UDS) takes the same rule ───────────────────────

Deno.test("uds: forUser changes go out as patches and the window stays exact (differential)", async () => {
  const dir = await tempDir("aio-uds-view-delta-");
  const socketPath = localEndpoint(join(dir, "view-delta.sock"));
  let state: S = freeze({
    ticker: { n: 0, log: [] },
    broker: { reqs: [], seq: 0, pad: "p".repeat(3000) },
    pool: { models: [{ name: "m", load: 0 }], secret: "s" },
  }, true);
  const getUIState = createMemoizedUIState<S>(rawView);
  const admin = { id: "root", role: "admin" } as AioUser;
  const uds = createUDSListener(
    socketPath,
    () => getUIState(state, admin), // the window's view
    () => {},
    () => {},
  );
  const r = rng(7);
  try {
    await new Promise((res) => setTimeout(res, 30));
    const { conn, lines } = await connectAndRead(socketPath);
    try {
      let held: unknown = {};
      let seen = 0;
      const drain = () => {
        for (; seen < lines.length; seen++) {
          const f = JSON.parse(lines[seen]!) as { t: string; d: unknown };
          if (f.t === "state") held = f.d;
          else if (f.t === "patches") {
            held = applyWirePatches(held, f.d as WirePatch[]);
          }
        }
      };
      await until(() => lines.length > 0);
      for (let round = 0; round < 30; round++) {
        const [broker, ops] = produceWithPatches(state.broker, (d) => {
          if (r() < 0.5 || d.reqs.length === 0) {
            d.reqs.push({ id: d.seq++, owner: "x", status: "q", note: "n" });
          } else d.reqs[Math.floor(r() * d.reqs.length)]!.status = `s${round}`;
        });
        state = freeze({ ...state, broker }, false);
        const want = JSON.stringify(getUIState(state, admin));
        uds.broadcastState(
          filterPatchesByStrategy(
            [{ cell: "broker", ops }],
            strategies,
            new Map(),
          ),
        );
        await until(() => (drain(), JSON.stringify(held) === want));
        assertEquals(held, JSON.parse(want), `round ${round}`);
      }
      const kinds = lines.map((l) => JSON.parse(l).t);
      assert(
        kinds.filter((k) => k === "patches").length >= 25,
        `mostly patches expected: ${kinds.join(",")}`,
      );
    } finally {
      conn.close();
    }
  } finally {
    await new Promise((res) => setTimeout(res, 20));
    uds.shutdown();
    await localIdle();
    await dropTempDir(dir);
  }
});

async function connectAndRead(socketPath: string) {
  const conn = await connectLocal(socketPath);
  const lines: string[] = [];
  const decoder = new TextDecoder();
  let buf = "";
  const rd = conn.readable.getReader();
  (async () => {
    try {
      while (true) {
        const { value, done } = await rd.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n");
        buf = parts.pop()!;
        for (const p of parts) if (p) lines.push(p);
      }
    } catch { /* closed */ }
  })();
  return { conn, lines };
}

async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) {
    await new Promise((res) => setTimeout(res, 5));
  }
}

// ── `am cost` sees forUser diffs on both transports, per cell, exactly ────

/** A cost meter that keeps what it is told. */
function meterSpy() {
  const rows: { cell: string; key: string; bytes: number }[] = [];
  let round = 0;
  return {
    rows,
    meter: {
      beginRound: () => ++round,
      recordAttribution: (cell: string, key: string, bytes: number) =>
        void rows.push({ cell, key, bytes }),
      setClientCount: () => {},
    },
  };
}

/** One round: alice's row changes (both see it), and a row only the admin
 *  sees is added — so the two clients are sent DIFFERENT diffs. */
function twoDiffRound(state: S): { next: S; entries: PatchEntry[] } {
  const [broker, ops] = produceWithPatches(state.broker, (d) => {
    d.reqs[0]!.status = "done";
    d.reqs.push({ id: 9, owner: "root", status: "q", note: "r".repeat(500) });
  });
  return {
    next: freeze({ ...state, broker }, false),
    entries: filterPatchesByStrategy(
      [{ cell: "broker", ops }],
      strategies,
      new Map(),
    )!,
  };
}

const costState = (): S =>
  freeze({
    ticker: { n: 0, log: [] },
    broker: {
      reqs: [{ id: 1, owner: "alice", status: "q", note: "n" }],
      seq: 2,
      pad: "p".repeat(3000),
    },
    pool: { models: [], secret: "s" },
  }, true);

/** What `attributeRound` charges one op: its value's JSON. */
const opBytes = (v: unknown) =>
  new TextEncoder().encode(JSON.stringify(v ?? null)).length;

Deno.test("am cost (ws): a forUser diff is attributed to its cell as the per-client mean", async () => {
  let state = costState();
  const getUIState = createMemoizedUIState<S>(rawView);
  const view = (u?: AioUser) => getUIState(state, u);
  const alice = client("a", { id: "alice", role: "user" } as AioUser, null);
  const root = client("r", { id: "root", role: "admin" } as AioUser, null);
  const spy = meterSpy();
  const b = createBroadcaster({
    connections: new Map([[alice.ws, alice.meta], [root.ws, root.meta]]),
    payloadStats: new Map(),
    getUIState: view,
    debug: () => {},
    syncIntervalMs: 0,
    costMeter: spy.meter,
  });
  try {
    outsideFullSend(alice, view);
    outsideFullSend(root, view);
    // Learn each baseline first (the first diff after a connect is a
    // whole-slice op), then measure the steady state.
    const warm = twoDiffRound(state);
    state = warm.next;
    b.broadcast(warm.entries);
    await tick();
    spy.rows.length = 0;
    const [broker, ops] = produceWithPatches(state.broker, (d) => {
      d.reqs[0]!.status = "run";
      d.reqs.push({
        id: 10,
        owner: "root",
        status: "q",
        note: "s".repeat(500),
      });
    });
    state = freeze({ ...state, broker }, false);
    b.broadcast(
      filterPatchesByStrategy([{ cell: "broker", ops }], strategies, new Map()),
    );
    await tick();
    assertEquals(alice.state, wire(view(alice.meta.user)));
    assertEquals(root.state, wire(view(root.meta.user)));
    // alice: the status op. root: the status op + the added row.
    const status = opBytes("run");
    const row = opBytes(state.broker.reqs.at(-1));
    assertEquals(spy.rows, [{
      cell: "broker",
      key: "reqs",
      bytes: Math.round((status + status + row) / 2),
    }]);
  } finally {
    b.shutdown();
  }
});

Deno.test("am cost (uds): a forUser diff is attributed to its cell", async () => {
  const dir = await tempDir("aio-uds-view-cost-");
  const socketPath = localEndpoint(join(dir, "view-cost.sock"));
  let state = costState();
  const getUIState = createMemoizedUIState<S>(rawView);
  const admin = { id: "root", role: "admin" } as AioUser;
  const uds = createUDSListener(
    socketPath,
    () => getUIState(state, admin),
    () => {},
    () => {},
  );
  const spy = meterSpy();
  const ctl = createUdsBroadcastController({
    getUdsHandle: () => uds,
    syncIntervalMs: 0,
    costMeter: () => spy.meter,
  });
  try {
    await new Promise((res) => setTimeout(res, 30));
    const { conn, lines } = await connectAndRead(socketPath);
    try {
      await until(() => lines.length > 0);
      for (let i = 0; i < 2; i++) {
        const { next, entries } = twoDiffRound(state);
        state = next;
        spy.rows.length = 0;
        const had = lines.length;
        ctl.onUdsBroadcast(entries);
        await until(() => lines.length > had);
      }
      const last = JSON.parse(lines.at(-1)!) as { t: string; d: WirePatch[] };
      assertEquals(last.t, "patches");
      const want = new Map<string, number>();
      for (const op of last.d) {
        const key = String(op.path[1] ?? "*");
        want.set(
          key,
          (want.get(key) ?? 0) + opBytes((op as { value?: unknown }).value),
        );
      }
      assertEquals(
        spy.rows,
        [...want].map(([key, bytes]) => ({ cell: "broker", key, bytes })),
      );
    } finally {
      conn.close();
    }
  } finally {
    ctl.dispose();
    await new Promise((res) => setTimeout(res, 20));
    uds.shutdown();
    await localIdle();
    await dropTempDir(dir);
  }
});
