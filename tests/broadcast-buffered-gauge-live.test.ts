// `broadcast.bufferedBytes` reads the LIVE broadcasters — not the first one
// this process ever made.
//
// The gauge is the number the memory monitor names when native memory climbs
// behind peers that are not draining. It was registered with a reader closed
// over the creating broadcaster's connections, and the ledger is first-wins
// per name: after an in-process restart (or beside a second app) the series
// kept reading a connection set nobody was sending to, and reported 0 while
// the live one buffered.
import { assertEquals, assertExists } from "@std/assert";
import {
  _resetMemoryLedger,
  readGauges,
} from "../src/diagnostics/memory-ledger.ts";
import { createBroadcaster } from "../src/server/server-broadcast.ts";
import type { ClientMeta } from "../src/server/server-ws.ts";

function broadcasterWith(...buffered: unknown[]) {
  const connections = new Map<WebSocket, ClientMeta>(
    buffered.map((bufferedAmount) => [
      { readyState: 1, bufferedAmount, send() {} } as unknown as WebSocket,
      {} as ClientMeta,
    ]),
  );
  return createBroadcaster({
    connections,
    payloadStats: new Map(),
    getUIState: () => ({}),
    debug: () => {},
    syncIntervalMs: 1,
  });
}

const gauge = () =>
  readGauges().find((g) => g.name === "broadcast.bufferedBytes");

Deno.test("broadcast gauge: registered by a broadcaster, as a LEVEL series in bytes", () => {
  _resetMemoryLedger();
  const b = broadcasterWith(1000);
  try {
    const g = gauge();
    assertExists(g, "creating a broadcaster must register the series");
    assertEquals(
      { owner: g.owner, unit: g.unit, kind: g.kind, value: g.value },
      { owner: "broadcast", unit: "bytes", kind: "level", value: 1000 },
    );
  } finally {
    b.shutdown();
  }
});

Deno.test("broadcast gauge: follows the live broadcaster across a restart, and sums two", () => {
  _resetMemoryLedger();
  const first = broadcasterWith(1000);
  assertEquals(gauge()!.value, 1000);
  first.shutdown();
  assertEquals(gauge()!.value, 0, "a broadcaster that shut down holds nothing");

  // The restart: a NEW broadcaster, the SAME process, the same series name.
  const second = broadcasterWith(300, 40);
  const third = broadcasterWith(5);
  try {
    assertEquals(gauge()!.value, 345, "every live broadcaster, summed");
    third.shutdown();
    assertEquals(gauge()!.value, 340);
  } finally {
    second.shutdown();
    third.shutdown();
  }
});

Deno.test("broadcast gauge: a socket with no usable bufferedAmount counts as nothing", () => {
  _resetMemoryLedger();
  const b = broadcasterWith(undefined, NaN, -5, Infinity, "12", 7);
  try {
    assertEquals(gauge()!.value, 7);
  } finally {
    b.shutdown();
  }
});
