// A one-time seed must not kill the socket.
//
// report 1 §10: a demo seed of ~1000 accounts made the sync scheduler exceed the
// per-connection budget. Observed live, the renderer froze on the pre-burst
// state while the server moved on, and a later dispatch was invisible to the
// client — the failure mode is a silently DEAD socket, not a slowed one, since
// 50 consecutive drops close it.
//
// The budget is right as an anti-abuse default. What was missing is that the
// client knows the number: the server advertises it in its hello, so the client
// can pace itself and "over budget" stops being reachable by ordinary use.
import { assert, assertEquals } from "@std/assert";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";
import { createOpBuffer } from "../../src/sync/op-buffer.ts";
import { createLocalStorageOpStorage } from "../../src/sync/browser-storage.ts";
import { rememberPeerHello } from "../../src/protocol/protocol-version.ts";

// deno-lint-ignore no-explicit-any
type D = any;

const CELL = "accounts";

/** The same localStorage shim the other sync-engine tests use — the op buffer
 *  needs a real storage surface (`countUnconfirmed`, not just load/save), and
 *  a hand-rolled half of one is how a test ends up proving the fake. */
function shimLocalStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

function engineWith(advertisedRate: number | undefined) {
  shimLocalStorage();
  const sent: string[] = [];
  const at: number[] = [];
  rememberPeerHello(
    {
      v: 3,
      app: "t",
      ...(advertisedRate ? { rate: advertisedRate } : {}),
    } as D,
  );
  let confirmed: Record<string, unknown> = { items: [] as unknown[] };
  const engine = createSyncEngine({
    clientId: "seeder",
    cells: { [CELL]: normalizeSyncConfig(true) },
    buffer: createOpBuffer(createLocalStorageOpStorage()),
    send: (m: string) => {
      sent.push(m);
      at.push(Date.now());
    },
    reducer: (s: D, _a: string, p: D) => ({
      ...s,
      items: [...(s.items as unknown[]), p],
    }),
    getConfirmedState: () => ({ [CELL]: confirmed }),
    setConfirmedState: (_c: string, s: Record<string, unknown>) => {
      confirmed = s;
    },
    onStateUpdate: () => {},
  } as D);
  engine.setOnline?.(true);
  return { engine, sent, at };
}

/** The most frames sent inside any one-second span — what a server counting
 *  in one-second windows can see, wherever its window happens to start. A
 *  rate averaged over the run is NOT that: it depends on how long the run
 *  took against the pacer's own refill, i.e. on the machine. */
function maxInAnySecond(at: number[]): number {
  let max = 0;
  for (let i = 0, j = 0; j < at.length; j++) {
    while (at[j]! - at[i]! >= 1000) i++;
    max = Math.max(max, j - i + 1);
  }
  return max;
}

Deno.test("a 1000-op seed never exceeds the rate the server advertised", async () => {
  const RATE = 100;
  const { engine, sent, at } = engineWith(RATE);
  const started = Date.now();
  try {
    for (let i = 0; i < 1000; i++) {
      // Past `pendingCap` the engine REJECTS the caller rather than dropping
      // the change silently, and these calls are deliberately unawaited —
      // this test is about send pacing, not about the buffer being full.
      engine.handleLocalAction(CELL, "add", { id: i }).catch(() => {});
    }
    // Long enough to cross the pacer's refill at least once past the burst,
    // however long the enqueue took.
    await new Promise((r) => setTimeout(r, 1200));
    const elapsedSec = (Date.now() - started) / 1000;
    assert(sent.length > 0, "nothing was sent at all");
    // The RATE in any second, not frames over the run. This asserted
    // `sent / elapsed` and flipped with the machine: the enqueue of a
    // thousand ops took ~1.1s, then ~0.65s once the engine stopped a second
    // prune-and-add per refused op, which moved the end of the 400ms wait
    // onto the old fixed window's rollover — 60 frames in 1.05s (57/sec) or
    // 120 in 1.1s (109/sec), run to run.
    const peak = maxInAnySecond(at);
    assert(
      peak <= RATE,
      `${peak} frames inside one second against an advertised ${RATE}/sec — ` +
        `this is the burst that closed the socket after 50 consecutive drops ` +
        `(report 1 §10)`,
    );
    // …and it keeps HEADROOM rather than sending at the ceiling: the server
    // counts a frame when its loop READS it, so a stall reads a backlog at
    // once. The bucket's bound is burst + perSec = 80% of the rate.
    assert(
      peak <= RATE * 0.8,
      `${peak} frames in one second is past the 80% bound — "paced" has to ` +
        `mean "never refused", not "usually"`,
    );
    // And it is genuinely draining, not stalled: a pacer that sent nothing
    // after the first burst would also pass a rate check.
    assert(
      sent.length > RATE * 0.6,
      `only ${sent.length} frames in ${
        elapsedSec.toFixed(2)
      }s — the queue is ` +
        `not draining`,
    );
  } finally {
    engine.setOnline?.(false);
  }
});

Deno.test("ops trickling in late in a second, then a burst, still never exceed the rate in any second", async () => {
  // The shape a fixed per-window counter gets wrong: room left at the END of
  // one window is spent, then the next window opens with its full count, and
  // both land inside the same second of the server's clock. MEASURED on the
  // old fixed-window pacer: 119 frames inside one second against 100.
  const RATE = 100;
  const { engine, at } = engineWith(RATE);
  try {
    engine.handleLocalAction(CELL, "add", { id: -1 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 900));
    for (let i = 0; i < 200; i++) {
      engine.handleLocalAction(CELL, "add", { id: i }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 1300));
    const peak = maxInAnySecond(at);
    assert(
      peak <= RATE * 0.8,
      `${peak} frames inside one second against an advertised ${RATE}/sec`,
    );
    assert(at.length > RATE * 0.6, `only ${at.length} frames — not draining`);
  } finally {
    engine.setOnline?.(false);
  }
});

Deno.test("a single op is still instant — ordinary use is not slowed", async () => {
  const { engine, sent } = engineWith(100);
  try {
    engine.handleLocalAction(CELL, "add", { id: 1 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 10));
    assertEquals(sent.length, 1, "one op should not wait for a timer tick");
  } finally {
    engine.setOnline?.(false);
  }
});

Deno.test("a peer that advertises NOTHING is paced as a default one, never faster", async () => {
  // An older server, or a transport with no hello. Treating "unknown" as
  // "unlimited" would reproduce the exact bug against exactly the peers least
  // able to say so.
  const { engine, sent } = engineWith(undefined);
  try {
    for (let i = 0; i < 500; i++) {
      // Past `pendingCap` the engine REJECTS the caller rather than dropping
      // the change silently, and these calls are deliberately unawaited —
      // this test is about send pacing, not about the buffer being full.
      engine.handleLocalAction(CELL, "add", { id: i }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 30));
    assert(
      sent.length > 0 && sent.length < 100,
      `${sent.length} frames with no advertised rate — an unaware peer must ` +
        `be paced at the server's own default, not left unpaced`,
    );
  } finally {
    engine.setOnline?.(false);
  }
});

Deno.test("the queue is DROPPED offline — a reconnect re-sends from the buffer", async () => {
  // The queued frames are not the only copy: the op is durable in the buffer
  // before it is ever sent. Holding them would send each one twice.
  const { engine, sent } = engineWith(100);
  for (let i = 0; i < 400; i++) {
    // Past `pendingCap` the engine REJECTS the caller rather than dropping
    // the change silently, and these calls are deliberately unawaited —
    // this test is about send pacing, not about the buffer being full.
    engine.handleLocalAction(CELL, "add", { id: i }).catch(() => {});
  }
  await new Promise((r) => setTimeout(r, 20));
  const before = sent.length;
  engine.setOnline?.(false);
  await new Promise((r) => setTimeout(r, 150));
  assertEquals(
    sent.length,
    before,
    "a queued frame went out after the connection dropped — reconnect " +
      "re-sends from the durable buffer, so that is a duplicate",
  );
});
