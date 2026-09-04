// ONE client's view that cannot serialize must reach /__aio/health even when
// every OTHER client is fine.
//
// `degraded()` counts CONSECUTIVE failures and `ok()` ends the episode. Both
// broadcasters called `fail()`/`ok()` PER CLIENT inside the flush loop, so a
// round with one failing view and one healthy one went fail, ok, fail, ok …
// and the counter never reached its threshold: the failing client silently
// received no state, forever, while the app answered "healthy" — for as long
// as at least one other client was connected. The write-backlog check beside
// it already knew this ("a fail() here and an ok() for the next healthy client
// in the same loop would cancel each other out") and counted per ROUND; the
// snapshot verdict did not.
//
// Reachable with nothing exotic: a `forUser` view that throws for one user
// (their record missing, a role lookup on undefined), or on UDS a BigInt in
// the one cell a single window subscribes to.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { _resetDegraded, degradedReport } from "../src/diagnostics/degraded.ts";
import { createBroadcaster } from "../src/server/server-broadcast.ts";
import { createUDSListener } from "../src/server/uds.ts";
import type { ClientMeta } from "../src/server/server-ws.ts";
import type { AioUser } from "../src/server/aio.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeClient(id: string, user?: AioUser) {
  const sent: string[] = [];
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    send(msg: string) {
      sent.push(msg);
    },
  } as unknown as WebSocket;
  const meta = {
    id,
    index: 0,
    clientType: "browser",
    isElectron: false,
    user,
    msgCount: 0,
    bytesThisSec: 0,
    bpMultiplier: 1,
    bpConsecutiveLow: 0,
    bpLastSentAt: 0,
    subscriptions: null,
    disconnected: false,
    consecutiveDrops: 0,
  } as unknown as ClientMeta;
  return { ws, meta, sent };
}

Deno.test("ws: a view that fails for ONE user escalates while the others are fine", async () => {
  _resetDegraded();
  const state = { c: { n: 1 } };
  const good = fakeClient("good", { id: "good", role: "user" } as AioUser);
  const bad = fakeClient("bad", { id: "bad", role: "user" } as AioUser);
  // Healthy first, then the failing one: the order that makes a per-client
  // verdict end every round on `ok()`.
  const connections = new Map<WebSocket, ClientMeta>([
    [good.ws, good.meta],
    [bad.ws, bad.meta],
  ]);
  const broadcaster = createBroadcaster({
    connections,
    payloadStats: new Map(),
    getUIState: (user) => {
      if (user?.id === "bad") throw new Error("no record for bad");
      return state;
    },
    debug: () => {},
    syncIntervalMs: 1,
  });
  try {
    // Force rounds (a "full"-strategy cell changed): every client is owed a
    // whole state, and the bad user's cannot be built.
    for (let i = 0; i < 10; i++) {
      state.c.n = i;
      broadcaster.broadcast();
      await wait(15);
    }
    assertEquals(bad.sent.length, 0, "the bad user received nothing…");
    assert(good.sent.length > 0, "…while the good one kept receiving");
    const dead = degradedReport().find((d) => d.name === "broadcast:state");
    assert(
      dead,
      `a client that has received nothing for 10 rounds must be on ` +
        `/__aio/health; report: ${JSON.stringify(degradedReport())}`,
    );
  } finally {
    broadcaster.shutdown();
    _resetDegraded();
  }
});

Deno.test("ws: the round verdict still recovers once every view serializes", async () => {
  _resetDegraded();
  const state = { c: { n: 1 } };
  let broken = true;
  const good = fakeClient("good", { id: "good", role: "user" } as AioUser);
  const bad = fakeClient("bad", { id: "bad", role: "user" } as AioUser);
  const connections = new Map<WebSocket, ClientMeta>([
    [good.ws, good.meta],
    [bad.ws, bad.meta],
  ]);
  const broadcaster = createBroadcaster({
    connections,
    payloadStats: new Map(),
    getUIState: (user) => {
      if (broken && user?.id === "bad") throw new Error("no record for bad");
      return state;
    },
    debug: () => {},
    syncIntervalMs: 1,
  });
  try {
    for (let i = 0; i < 10; i++) {
      state.c.n = i;
      broadcaster.broadcast();
      await wait(15);
    }
    assert(degradedReport().some((d) => d.name === "broadcast:state"));
    broken = false;
    state.c.n = 99;
    broadcaster.broadcast();
    await wait(15);
    assertEquals(
      degradedReport().filter((d) => d.name === "broadcast:state"),
      [],
      "a round in which every view serialized ends the episode",
    );
  } finally {
    broadcaster.shutdown();
    _resetDegraded();
  }
});

Deno.test("uds: a cell that fails for ONE subscriber escalates while the others are fine", async () => {
  _resetDegraded();
  const socketPath = join(
    await tempDir("aio-broadcast-degraded-per-round-"),
    "per-round.sock",
  );
  // `b` holds a BigInt: JSON refuses it. A window subscribed to `a` alone
  // is fine; one subscribed to `b` never receives a snapshot again.
  const state = { a: { n: 1 }, b: { n: 1n as unknown } };
  const uds = createUDSListener(socketPath, () => state, () => {}, () => {});
  await wait(30);
  const connect = async (subs: string[]) => {
    const conn = await Deno.connect({ path: socketPath, transport: "unix" });
    const reader = conn.readable.getReader();
    (async () => {
      try {
        for (;;) if ((await reader.read()).done) break;
      } catch { /* closed */ }
    })();
    const w = conn.writable.getWriter();
    await w.write(
      new TextEncoder().encode(
        JSON.stringify({ v: 2, t: "subs", d: { subs } }) + "\n",
      ),
    );
    w.releaseLock();
    return conn;
  };
  const fine = await connect(["a"]);
  const starved = await connect(["b"]);
  await wait(80);
  try {
    for (let i = 0; i < 10; i++) {
      state.a.n = i;
      uds.broadcastState(true);
      await wait(10);
    }
    const dead = degradedReport().find((d) => d.name === "uds:broadcast-state");
    assert(
      dead,
      `a window that has received nothing for 10 rounds must be on ` +
        `/__aio/health; report: ${JSON.stringify(degradedReport())}`,
    );
  } finally {
    fine.close();
    starved.close();
    await wait(30);
    uds.shutdown();
    _resetDegraded();
  }
});
