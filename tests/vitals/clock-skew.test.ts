// tests/vitals/clock-skew.test.ts — the one-clock invariant of the liveness
// watchdog.
//
// The bug this pins: `lastPing` was stamped with the CLIENT's `Date.now()`
// (`ping.t1`, produced in a browser) while `checkAllClients()` subtracted it
// from the SERVER's `Date.now()`. The difference is a latency plus the two
// machines' clock offset. The offset is constant, so a client 2s behind was
// classified `frozen` on its very first ping and stayed frozen forever —
// and `server-broadcast.ts` skips frozen clients in EVERY broadcast, so that
// client never received another state update while its socket stayed open and
// its pings kept being answered. A clock AHEAD made the gap negative and
// silently disabled the watchdog instead.

import { assert, assertEquals } from "@std/assert";
import { createServer } from "../../src/server/server.ts";
import { createVitalsSystem } from "../../src/vitals/mod.ts";
import { createTransportProbeServer } from "../../src/vitals/transport-probe.ts";
import { DEFAULT_THRESHOLDS } from "../../src/vitals/types.ts";
import { freePort } from "../../src/testing/server-test.ts";
import { enc } from "../../src/protocol/envelope.ts";

// ─── Unit: the probe cannot be fed a foreign clock at all ────────────────────

Deno.test("skew: liveness is stamped by the server clock, not the caller's", () => {
  let clock = 1_000_000;
  const probe = createTransportProbeServer({
    thresholds: DEFAULT_THRESHOLDS,
    now: () => clock,
  });
  probe.onClientPing("c1");
  // Elapsed time is measured against the SAME clock that stamped the ping, so
  // a gap can never be negative and can never include a machine offset.
  probe.checkAllClients();
  assertEquals(probe.isFrozen("c1"), false);
  assertEquals(probe.getClientLiveness("c1")!.lastPing, clock);

  // Genuine silence still freezes — the watchdog is intact, not disabled.
  clock += DEFAULT_THRESHOLDS.transport.frozen + 1;
  probe.checkAllClients();
  assertEquals(probe.isFrozen("c1"), true);

  // …and a fresh ping recovers it.
  probe.onClientPing("c1");
  probe.checkAllClients();
  assertEquals(probe.isFrozen("c1"), false);
  probe.destroy();
});

// ─── End to end: a skewed client keeps receiving broadcasts ──────────────────

type WSFrame = { skew: number; got: boolean };

async function broadcastReachesClientWithSkew(
  skewMs: number,
): Promise<WSFrame> {
  const port = freePort();
  const dir = await Deno.makeTempDir();
  const vitals = createVitalsSystem({});
  let uiState: Record<string, unknown> = { app: { n: 1 } };
  const server = createServer({
    port,
    title: "skew",
    getUIState: () => uiState,
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: true,
    vitalsSystem: vitals,
  });
  await new Promise((r) => setTimeout(r, 50));

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const frames: string[] = [];
  ws.onmessage = (e) => frames.push(String(e.data));
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("ws failed"));
  });
  await new Promise((r) => setTimeout(r, 100));

  // The client pings with ITS OWN clock, which is `skewMs` off from ours.
  ws.send(enc("vitals-ping", { t1: Date.now() + skewMs }));
  await new Promise((r) => setTimeout(r, 100));
  vitals.serverTransport.checkAllClients();

  frames.length = 0;
  uiState = { app: { n: 2 } };
  server.broadcast();
  await new Promise((r) => setTimeout(r, 250));

  const got = frames.some((f) => f.includes('"n":2') || f.includes('n\\":2'));
  ws.close();
  await server.shutdown();
  vitals.destroy();
  await new Promise((r) => setTimeout(r, 30));
  await Deno.remove(dir, { recursive: true });
  return { skew: skewMs, got };
}

Deno.test({
  name: "skew: a client 10s BEHIND still receives every broadcast",
  fn: async () => {
    const base = await broadcastReachesClientWithSkew(0);
    assert(base.got, "control: an unskewed client must receive the update");
    const behind = await broadcastReachesClientWithSkew(-10_000);
    assert(
      behind.got,
      "a client whose clock is 10s behind was classified frozen forever and " +
        "silently dropped from every broadcast",
    );
  },
});

Deno.test({
  name: "skew: a client 10s AHEAD does not disable the freeze watchdog",
  fn: async () => {
    // A negative gap used to evaluate as "healthy" unconditionally. With one
    // clock the ahead case is indistinguishable from any other client — which
    // is the point: the watchdog still fires on real silence.
    let clock = 5_000_000;
    const probe = createTransportProbeServer({
      thresholds: DEFAULT_THRESHOLDS,
      now: () => clock,
    });
    probe.onClientPing("ahead");
    clock += DEFAULT_THRESHOLDS.transport.frozen + 1;
    probe.checkAllClients();
    assertEquals(
      probe.isFrozen("ahead"),
      true,
      "a client that went silent must freeze regardless of its own clock",
    );
    probe.destroy();
    await Promise.resolve();
  },
});
