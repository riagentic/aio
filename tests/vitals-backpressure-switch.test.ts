// `vitals: { backpressure: false }` must actually turn the per-client send
// throttle off.
//
// The option had NO reader anywhere: it type-checked, was accepted, was
// printed by `doctor`, and changed nothing — while `hints.ts` tells an author
// staring at a TRANSPORT_STALL to "enable backpressure if it is off". An
// option that cannot be observed to do anything is a lie in the config
// surface, so this drives the real transport and reads the multiplier the
// server publishes for that client.
import { assert, assertEquals } from "@std/assert";
import { aio } from "../mod.ts";
import { cell } from "../src/state/cell.ts";
import { enc } from "../src/protocol/envelope.ts";
import { freePort } from "../src/testing/server-test.ts";
import { createVitalsSystem } from "../src/vitals/mod.ts";

const probe = cell("bp-probe", { state: { n: 0 }, methods: {} });

/** Boot, connect, report the throttle multiplier the server holds for us
 *  after a ping that says the client is 500ms behind. */
async function multiplierAfterStalePing(
  backpressure: boolean | undefined,
): Promise<number> {
  const port = freePort();
  const app = await aio.run({
    cells: [probe],
    appId: `test-bp-${backpressure}`,
    appVersion: "0.0.0",
    client: "server-only",
    persist: false,
    libraryMode: true,
    port,
    baseDir: await Deno.makeTempDir(),
    // `{}` for the control: an empty vitals config IS the default config, so
    // both runs differ in exactly one key.
    diagnostics: {
      dev: { vitals: backpressure === undefined ? {} : { backpressure } },
      prod: { vitals: backpressure === undefined ? {} : { backpressure } },
    },
  });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error("ws failed"));
    });
    try {
      // BP_STALENESS_HIGH is 300ms — 500 is unambiguously "this client is
      // drowning", the exact condition the throttle exists for.
      ws.send(enc("vitals-ping", { t1: Date.now(), ms: 500 }));
      // The server answers every ping with a pong; wait for that rather than
      // for a fixed delay, so the read below cannot race the handler.
      const ponged = await new Promise<boolean>((res) => {
        ws.onmessage = (e) => {
          if (typeof e.data === "string" && e.data.includes("pong")) res(true);
        };
        setTimeout(() => res(false), 2000);
      });
      // Without this, a ping that never landed reads exactly like a client
      // that was never throttled — the "off" case would pass for the wrong
      // reason.
      assert(ponged, "the server must have answered the ping");
      const vitals = await (await fetch(
        `http://127.0.0.1:${port}/__aio/vitals`,
      )).json();
      const bp = vitals.clientBackpressure as Record<string, number>;
      const values = Object.values(bp);
      assert(values.length > 0, "the connected client must be reported");
      return values[0]!;
    } finally {
      ws.close();
    }
  } finally {
    await app.close();
  }
}

Deno.test("vitals: backpressure ON (the default) throttles a stalling client", async () => {
  assertEquals(
    await multiplierAfterStalePing(undefined),
    4,
    "control: without this, the test below proves nothing",
  );
});

Deno.test("vitals: backpressure: false leaves the client un-throttled", async () => {
  assertEquals(
    await multiplierAfterStalePing(false),
    1,
    "the switch must reach the transport, not just the config type",
  );
});

Deno.test("vitals: the system reports the switch it was built with", () => {
  const on = createVitalsSystem({});
  const off = createVitalsSystem({ backpressure: false });
  const explicit = createVitalsSystem({ backpressure: true });
  try {
    assertEquals(on.backpressureEnabled, true, "default is on");
    assertEquals(off.backpressureEnabled, false);
    assertEquals(explicit.backpressureEnabled, true);
  } finally {
    on.destroy();
    off.destroy();
    explicit.destroy();
  }
});
