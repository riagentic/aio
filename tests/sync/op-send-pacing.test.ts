// tests/sync/op-send-pacing.test.ts — a legitimate burst must not look like an
// attack.
//
// One local op was one WebSocket frame, sent the instant it was issued. Right
// for a click; wrong for a thousand. A demo seed of ~1000 accounts — or a first
// sync of an existing dataset — fired a frame each into a server whose
// per-connection budget is 100 messages/sec. The server dropped the excess,
// counted fifty drops in a row, closed the socket with 1008 and denylisted the
// client for a minute. An anti-abuse fuse built for hostile peers, tripped by
// aio's own sync engine doing exactly what it had been told to do. What the
// user saw was worse than slow: the renderer sat on pre-burst state while the
// server moved on, and the next dispatch went nowhere at all.
//
// The server now advertises its budget in the proto hello and the client paces
// itself to it. Pacing is free here because the op is ALREADY durable before
// it is ever sent — it is in the op buffer, and reconnect re-sends from there —
// so the queue holds frames, never the only copy of a write.
import { assertEquals } from "@std/assert";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import {
  createMemoryStorage,
  createOpBuffer,
} from "../../src/sync/op-buffer.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";
import {
  parseProtoHello,
  rememberPeerHello,
} from "../../src/protocol/protocol-version.ts";

const CELL = "seed";

/** The server's default budget, and what the client should allow itself: 60%
 *  of it, because sending AT the ceiling races the server's own window edge. */
const SERVER_RATE = 100;
const CLIENT_BUDGET = 60;

function makeEngine() {
  const sent: string[] = [];
  let confirmed: Record<string, unknown> = { n: 0 };
  const engine = createSyncEngine({
    clientId: "pacer",
    cells: { [CELL]: normalizeSyncConfig(true) },
    buffer: createOpBuffer(createMemoryStorage(), { pendingCap: 100_000 }),
    send: (m) => sent.push(m),
    reducer: (s) => s,
    getConfirmedState: () => ({ [CELL]: confirmed }),
    setConfirmedState: (_c, s) => {
      confirmed = s;
    },
    onStateUpdate: () => {},
  });
  return { engine, sent };
}

/** The `n` each queued op carried, in the order the frames actually went out. */
const orderOf = (sent: string[]): number[] =>
  sent.map((m) =>
    (JSON.parse(m) as { d: { payload: { n: number } } }).d.payload.n
  );

Deno.test("sync pacing: a 120-op burst does not exceed the advertised budget", async () => {
  rememberPeerHello({ v: 3, min: 3, rate: SERVER_RATE });
  const { engine, sent } = makeEngine();

  const N = 120;
  for (let n = 0; n < N; n++) {
    await engine.handleLocalAction(CELL, "add", { n });
  }

  // The whole point: the burst did NOT go out as 120 frames in one window.
  assertEquals(
    sent.length,
    CLIENT_BUDGET,
    `the burst sent ${sent.length} frames in one window against a budget of ` +
      `${CLIENT_BUDGET} — this is the shape the server closes the socket for`,
  );

  // And nothing is lost: the rest drains, in order, once the window rolls.
  const deadline = Date.now() + 8000;
  while (sent.length < N && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assertEquals(sent.length, N, "queued frames never drained");
  assertEquals(
    orderOf(sent),
    Array.from({ length: N }, (_, i) => i),
    "pacing reordered the ops — a queue that reorders is worse than a drop",
  );
});

Deno.test("sync pacing: one op is still sent immediately", async () => {
  rememberPeerHello({ v: 3, min: 3, rate: SERVER_RATE });
  const { engine, sent } = makeEngine();
  await engine.handleLocalAction(CELL, "add", { n: 0 });
  assertEquals(
    sent.length,
    1,
    "ordinary use got slower — the fast path must send inline when there is " +
      "room, or every single-op app pays for the burst case",
  );
});

Deno.test("sync pacing: going offline drops the queue and disarms the timer", async () => {
  rememberPeerHello({ v: 3, min: 3, rate: SERVER_RATE });
  const { engine, sent } = makeEngine();
  for (let n = 0; n < 120; n++) {
    await engine.handleLocalAction(CELL, "add", { n });
  }
  const atDisconnect = sent.length;
  engine.setOnline(false);
  // Queued frames are duplicates of what the durable buffer re-sends on
  // reconnect. Holding them would double-send; holding the TIMER would leave a
  // handle open past the end of a test, which is what the op sanitizer is for.
  await new Promise((r) => setTimeout(r, 1300));
  assertEquals(
    sent.length,
    atDisconnect,
    "frames kept going out after the connection was declared gone",
  );
});

Deno.test("sync pacing: an unadvertised or hostile rate cannot break the client", () => {
  // A peer that predates the field is paced at the conservative default.
  assertEquals(parseProtoHello({ v: 3, min: 3 })?.rate, undefined);
  // A rate that would stall sending forever, spin it, or is not a number at
  // all is refused — this value becomes a divisor and a loop bound.
  for (const bad of [0, -1, 0.5, NaN, Infinity, 2_000_000, "100", null]) {
    assertEquals(
      parseProtoHello({ v: 3, min: 3, rate: bad })?.rate,
      undefined,
      `rate ${String(bad)} was accepted`,
    );
  }
  assertEquals(parseProtoHello({ v: 3, min: 3, rate: 250 })?.rate, 250);
  assertEquals(parseProtoHello({ v: 3, min: 3, rate: 250.7 })?.rate, 250);
});
