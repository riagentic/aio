// A whole state paid to settle a debt is bytes on the wire like any round's —
// and it was invisible to every meter.
//
// The idle debt retry (tests/ws-backlog-debt-paid-when-idle.test.ts) and the
// freeze watchdog's recovery hook (tests/frozen-client-recovery-resync.test.ts)
// both send a full state OUTSIDE a round, through `_payDebt`. That path set
// the client's bookkeeping and nothing else: no `payloadStats` entry (the
// trojan/vitals per-client view), no process-lifetime totals (the Prometheus
// counters), no payload budget reading, no `am cost` attribution. A client
// that kept falling behind was paid a multi-MB state again and again with
// every meter reporting a quiet app — the one situation the meters exist for.
import { assert, assertEquals } from "@std/assert";
import { createBroadcaster } from "../src/server/server-broadcast.ts";
import type { PatchEntry } from "../src/protocol/broadcast-utils.ts";
import type { ClientMeta } from "../src/server/server-ws.ts";
import type { VitalsSystem } from "../src/vitals/mod.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BIG = "p".repeat(1_000_000);

function slowClient(id: string) {
  const sent: string[] = [];
  let buffered = 0;
  const ws = {
    readyState: 1,
    get bufferedAmount() {
      return buffered;
    },
    send(msg: string) {
      sent.push(msg);
      buffered += msg.length;
    },
  } as unknown as WebSocket;
  const meta = {
    id,
    index: 0,
    clientType: "browser",
    isElectron: false,
    msgCount: 0,
    bytesThisSec: 0,
    bpMultiplier: 1,
    bpConsecutiveLow: 0,
    bpLastSentAt: 0,
    subscriptions: null,
    disconnected: false,
    consecutiveDrops: 0,
  } as unknown as ClientMeta;
  return { ws, meta, sent, drain: () => (buffered = 0) };
}

function fakeVitals() {
  const payloads: Array<{ id: string; bytes: number }> = [];
  let recovered: ((id: string) => void) | undefined;
  let frozen = false;
  const vitals = {
    serverTransport: {
      isFrozen: () => frozen,
      onClientStateSent: () => {},
    },
    pressureMonitor: {
      onBroadcast: (id: string, bytes: number) => payloads.push({ id, bytes }),
      onBroadcastRound: () => {},
    },
    onClientRecovered: (fn: (id: string) => void) => {
      recovered = fn;
      return () => {};
    },
  } as unknown as VitalsSystem;
  return {
    vitals,
    payloads,
    setFrozen: (f: boolean) => (frozen = f),
    recover: (id: string) => recovered?.(id),
  };
}

function fakeMeter() {
  const attributed: Array<{ cell: string; key: string; bytes: number }> = [];
  let rounds = 0;
  return {
    attributed,
    meter: {
      beginRound: () => ++rounds,
      recordAttribution: (cell: string, key: string, bytes: number) =>
        attributed.push({ cell, key, bytes }),
      setClientCount: () => {},
    },
  };
}

const patch = (n: number, pad: string): PatchEntry[] =>
  [{
    cell: "c",
    ops: [
      { op: "replace", path: ["n"], value: n },
      { op: "replace", path: ["pad"], value: pad },
    ],
  }] as PatchEntry[];

Deno.test("ws debt: the idle retry's full state is metered like a round's", async () => {
  const state = { c: { n: 0, pad: BIG } };
  const c = slowClient("slow");
  const v = fakeVitals();
  const m = fakeMeter();
  const payloadStats = new Map();
  const broadcaster = createBroadcaster({
    connections: new Map([[c.ws, c.meta]]),
    payloadStats,
    getUIState: () => state,
    debug: () => {},
    syncIntervalMs: 1,
    vitalsSystem: v.vitals,
    costMeter: m.meter,
  });
  try {
    for (let i = 1; i <= 8; i++) {
      state.c = { n: i, pad: `${i}${BIG}` };
      broadcaster.broadcast(patch(i, state.c.pad));
      await wait(20);
    }
    assertEquals(c.meta.needsFull, true, "instrument: a round was skipped");
    const sentBefore = c.sent.length;
    const statsBefore = payloadStats.get("slow")?.count ?? 0;
    const lifeBefore = broadcaster.lifetimeBroadcast();
    const payloadsBefore = v.payloads.length;
    const attrBefore = m.attributed.length;

    c.drain();
    const t0 = Date.now();
    while (c.meta.needsFull && Date.now() - t0 < 3000) await wait(20);
    assertEquals(
      c.sent.length,
      sentBefore + 1,
      "instrument: the debt was paid",
    );
    const frame = c.sent[c.sent.length - 1]!;
    const bytes = new TextEncoder().encode(frame).byteLength;

    assertEquals(payloadStats.get("slow")?.count, statsBefore + 1);
    assertEquals(payloadStats.get("slow")?.lastPayloadBytes, bytes);
    const life = broadcaster.lifetimeBroadcast();
    assertEquals(life.count, lifeBefore.count + 1, "lifetime count");
    assertEquals(life.bytes, lifeBefore.bytes + bytes, "lifetime bytes");
    assertEquals(
      v.payloads.length,
      payloadsBefore + 1,
      "payload budget reading",
    );
    const attr = m.attributed.slice(attrBefore);
    assert(
      attr.some((a) => a.cell === "c" && a.key === "*" && a.bytes > 0),
      `am cost must attribute the resend: ${JSON.stringify(attr)}`,
    );
  } finally {
    broadcaster.shutdown();
  }
});

Deno.test("ws debt: a freeze recovery's full state is metered like a round's", async () => {
  const state = { c: { n: 0, pad: "x" } };
  const c = slowClient("frozen");
  const v = fakeVitals();
  const m = fakeMeter();
  const payloadStats = new Map();
  const broadcaster = createBroadcaster({
    connections: new Map([[c.ws, c.meta]]),
    payloadStats,
    getUIState: () => state,
    debug: () => {},
    syncIntervalMs: 1,
    vitalsSystem: v.vitals,
    costMeter: m.meter,
  });
  try {
    v.setFrozen(true);
    state.c = { n: 1, pad: "x" };
    broadcaster.broadcast(patch(1, "x"));
    await wait(20);
    assertEquals(c.sent.length, 0, "instrument: a frozen client is skipped");
    assertEquals(c.meta.needsFull, true);

    v.setFrozen(false);
    v.recover("frozen");
    assertEquals(c.sent.length, 1, "instrument: recovery paid the debt");
    const bytes = new TextEncoder().encode(c.sent[0]!).byteLength;
    assertEquals(payloadStats.get("frozen")?.count, 1);
    assertEquals(broadcaster.lifetimeBroadcast(), { bytes, count: 1 });
    assertEquals(v.payloads, [{ id: "frozen", bytes }]);
    assert(
      m.attributed.some((a) => a.cell === "c" && a.key === "*"),
      `am cost must attribute the resend: ${JSON.stringify(m.attributed)}`,
    );
  } finally {
    broadcaster.shutdown();
  }
});
