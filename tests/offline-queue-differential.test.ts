// Differential: the two offline-queue PATHS behave identically on the same
// event sequence.
//
// Cell-method dispatch queues in the browser transport (cap 1000); `send()`
// from the isomorphic core queues in state-transport (cap 100). They are two
// INSTANCES of one factory (`state/offline-queue.ts`) with one drop policy —
// and the day they were two implementations they had OPPOSITE policies (the
// core refused the newest and settled no acks; the browser evicted the oldest
// and rejected its ack). `tests/offline-queue-both-paths.test.ts` pins each
// path's policy by hand; this file pins that they are THE SAME policy by
// running randomized sequences (queue / cross the cap / replay) through a
// reference model and through BOTH live paths, and comparing:
//
//   • which callers were refused (the evicted cids), in order;
//   • the replay order on reconnect (arrival order, oldest first);
//   • that every queued action either replays or its caller is rejected —
//     nothing is silently lost, nothing is both.
//
// A path that grows its own queue, its own cap handling, or its own drop
// order goes red here without anyone having to notice it by reading.
import { assertEquals } from "@std/assert";
import {
  _registerAck,
  _rejectAllPending,
  _setAckTimeoutMs,
} from "../src/browser/browser-ack.ts";
import { initDiagnosticBus } from "../src/diagnostics/diagnostic-bus.ts";
import {
  _resetTransport,
  flushOfflineQueue,
  send as coreSend,
  setTransport as coreSetTransport,
} from "../src/state/state-transport.ts";

initDiagnosticBus(false); // policy under test, not its diagnostics
_setAckTimeoutMs(0); // deferred clocks never start here; rejections are drops

/** One event: an action; `cid` when a caller awaits it. */
type Ev = { type: string; cid?: string };

/** What a run produced — comparable across model and paths. */
type Outcome = { refused: string[]; replayed: string[] };

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function sequence(seed: number, cap: number): Ev[] {
  const rnd = lcg(seed);
  // Around the cap on purpose: below it (no drops), just over it (one), well
  // over it (many) — the cap-crossing behaviour is the whole point.
  const n = cap - 3 + Math.floor(rnd() * (cap / 2 + 10));
  const evs: Ev[] = [];
  for (let i = 0; i < n; i++) {
    const type = `d${seed}:${i}`;
    evs.push(rnd() < 0.5 ? { type, cid: `c${seed}-${i}` } : { type });
  }
  return evs;
}

/** The reference model — written out by hand, NOT the factory, so a change
 *  to the policy itself (drop-newest, refuse-at-cap, unordered replay) goes
 *  red here instead of moving the model along with it. The policy: the new
 *  action is always accepted; past the cap the OLDEST is evicted and, when
 *  awaited, its caller is refused; replay is arrival order. */
function model(evs: Ev[], cap: number): Outcome {
  const refused: string[] = [];
  const held: Ev[] = [];
  for (const e of evs) {
    held.push(e);
    while (held.length > cap) {
      const oldest = held.shift()!;
      if (oldest.cid) refused.push(oldest.cid);
    }
  }
  return { refused, replayed: held.map((e) => e.type) };
}

/** Register acks for every cid, run `drive`, and report which acks were
 *  refused WHILE QUEUED (the drop policy's rejections, in order). Acks still
 *  pending afterwards belong to replayed frames — they are settled as "round
 *  over" and are not refusals. */
async function withAcks(
  evs: Ev[],
  drive: () => Promise<string[]>,
): Promise<Outcome> {
  const refused: string[] = [];
  const settled: Promise<void>[] = [];
  for (const e of evs) {
    if (!e.cid) continue;
    const cid = e.cid;
    settled.push(
      _registerAck(cid, { deferTimer: true }).then(() => {}, (err: Error) => {
        if (err.message.includes("queue full")) refused.push(cid);
      }),
    );
  }
  const replayed = await drive();
  _rejectAllPending(new Error("round over"));
  await Promise.all(settled);
  return { refused, replayed };
}

function replayedCids(evs: Ev[], replayed: string[]): Set<string> {
  const byType = new Map(evs.map((e) => [e.type, e.cid]));
  const out = new Set<string>();
  for (const t of replayed) {
    const c = byType.get(t);
    if (c) out.add(c);
  }
  return out;
}

function actionTypes(frames: string[]): string[] {
  const out: string[] = [];
  for (const raw of frames) {
    try {
      const f = JSON.parse(raw) as { t?: string; d?: { type?: string } };
      if (f.t === "action" && f.d?.type) out.push(f.d.type);
    } catch { /* not an action frame */ }
  }
  return out;
}

// ── core path: state-transport `send()`, cap 100 ─────────────────────

const CORE_CAP = 100;

async function corePath(evs: Ev[]): Promise<Outcome> {
  _resetTransport();
  return await withAcks(evs, async () => {
    for (const e of evs) coreSend({ ...e });
    const frames: string[] = [];
    // Reconnect: installing a transport flushes the queue in arrival order.
    coreSetTransport({ send: (d) => frames.push(d), close: () => {} });
    flushOfflineQueue(); // what state-core's setTransport wrapper does
    _resetTransport();
    return actionTypes(frames);
  });
}

Deno.test("offline-queue differential: the core path IS the shared policy on random sequences", async () => {
  for (let seed = 1; seed <= 12; seed++) {
    const evs = sequence(seed, CORE_CAP);
    const want = model(evs, CORE_CAP);
    const got = await corePath(evs);
    assertEquals(got, want, `seed ${seed} (${evs.length} events)`);
    // Nothing silently lost, nothing both: every awaited action is exactly
    // one of replayed / refused.
    const awaited = evs.filter((e) => e.cid).map((e) => e.cid!);
    const replayedC = replayedCids(evs, got.replayed);
    assertEquals(
      awaited.filter((c) => replayedC.has(c) === got.refused.includes(c)),
      [],
      "an awaited action is replayed XOR refused",
    );
  }
});

// ── browser path: browser-air-transport, cap 1000 ───────────────────
// LAST: importing the transport binds it as THE client send for the process.

const BROWSER_CAP = 1000;

class FakeWS {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  static last: FakeWS | null = null;
  static sent: string[] = [];
  constructor(public url: string) {
    FakeWS.last = this;
  }
  send(d: string) {
    FakeWS.sent.push(d);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}

Deno.test("offline-queue differential: the browser path IS the shared policy on random sequences", async () => {
  const g = globalThis as Record<string, unknown>;
  const prevWS = g.WebSocket;
  const prevLoc = g.location;
  g.WebSocket = FakeWS;
  if (!prevLoc) {
    g.location = {
      protocol: "http:",
      host: "localhost:1234",
      search: "",
      origin: "http://localhost:1234",
    };
  }
  await import("../src/browser/browser-air-transport.ts");
  const { client, ensureConnected } = await import(
    "../src/browser/browser-protocol.ts"
  );
  try {
    for (let seed = 101; seed <= 106; seed++) {
      const evs = sequence(seed, BROWSER_CAP);
      const want = model(evs, BROWSER_CAP);
      const got = await withAcks(evs, async () => {
        // Offline (no open socket): every client.send queues.
        for (const e of evs) client.send({ ...e });
        FakeWS.sent.length = 0;
        // Reconnect: the socket opens and the queue replays, oldest first.
        ensureConnected();
        FakeWS.last!.open();
        const types = actionTypes(FakeWS.sent);
        // Back offline for the next round.
        FakeWS.last!.close();
        return types;
      });
      assertEquals(got, want, `seed ${seed} (${evs.length} events)`);
    }
  } finally {
    if (prevWS === undefined) delete g.WebSocket;
    else g.WebSocket = prevWS;
    if (!prevLoc) delete g.location;
  }
});
