// `am cost` was blind on UDS — the transport a desktop app actually uses.
//
// Field report: "am cost reports connections: 0 on UDS, so push volume isn't
// visible there — I used am timeline mutations instead."
//
// A local Electron app opens ZERO TCP ports by design (the port doctrine), so
// its clients live in the UDS server's own `clientMap` and never appear in the
// WS `connections` map. The cost meter read only the latter: the client count
// stayed 0, and — because the attribution block sits inside the WS send loop —
// nothing the UDS path pushed was attributed to any cell either. The one
// command that answers "what is this app moving, and which cell is moving it"
// answered "nothing" for the whole desktop target.
//
// `server-broadcast.ts` had already learned this exact lesson one function
// away: "An electron-only app has ZERO WS connections — the UDS path must
// count, or its panel silently starves." It was never applied to the meter.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createCostMeter } from "../src/vitals/cost-meter.ts";
import { attributeRound } from "../src/server/server-broadcast.ts";
import type { PatchEntry } from "../src/protocol/broadcast-utils.ts";
import { createUDSListener } from "../src/server/aio.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { join } from "@std/path";

const PATCHES: PatchEntry[] = [
  {
    cell: "balances",
    ops: [{ op: "replace", path: ["sol"], value: 48 } as never],
  },
];

Deno.test("cost: a UDS push is attributed to its cell, like a WS one", () => {
  const meter = createCostMeter();
  meter.setKnownCells(["balances", "nav"]);
  // What the UDS broadcaster does: it sent patches to its own clients.
  attributeRound(meter, {
    anyPatchSend: true,
    anyFullSend: false,
    force: false,
    patchesToSend: PATCHES,
    getUIState: () => ({ balances: { sol: 48 }, nav: { i: 1 } }),
  });
  const r = meter.report({ windowSec: 60 });
  const balances = r.cells.find((c) => c.cell === "balances");
  assert(balances, `the pushing cell must appear: ${JSON.stringify(r.cells)}`);
  assert(
    balances.pushesPerSec > 0,
    "a UDS round is a push — otherwise `am cost` reports an idle app that is not",
  );
  assertEquals(
    r.idleCells,
    ["nav"],
    "…and the cell that really was idle is the only one reported idle",
  );
});

Deno.test("cost: a full send over UDS is attributed as the whole slice", () => {
  const meter = createCostMeter();
  meter.setKnownCells(["balances"]);
  attributeRound(meter, {
    anyPatchSend: false,
    anyFullSend: true,
    force: true,
    patchesToSend: [],
    getUIState: () => ({ balances: { sol: 48, usd: 1200 } }),
  });
  const r = meter.report({ windowSec: 60 });
  const c = r.cells.find((x) => x.cell === "balances");
  assert(
    c && c.bytesPerSec > 0,
    `a full send moves real bytes: ${JSON.stringify(c)}`,
  );
  assertEquals(
    c!.fullResends,
    1,
    "…and it is reported as a whole-slice resend",
  );
});

Deno.test("cost: the client count includes UDS clients", () => {
  // The number `bytesPerSecPerClient` divides by. Zero clients made the whole
  // per-client column meaningless on the desktop target.
  const meter = createCostMeter();
  meter.setClientCount(0 + 2); // ws + uds
  assertEquals(meter.report({ windowSec: 60 }).clients, 2);
});

// ── the wiring, not just the rule ───────────────────────────────────
//
// The rule above is shared; this is the half that was missing — the UDS
// broadcaster calling it, and calling it with what ACTUALLY went out.
import { createUdsBroadcastController } from "../src/server/aio-run-helpers.ts";
import type { UDSHandle } from "../src/server/uds.ts";

function handleThatSends(
  sent: { full: number; patch: number },
  clients = 1,
): UDSHandle {
  return {
    broadcast: () => {},
    broadcastState: () => sent,
    shutdown: () => {},
    socketPath: "/tmp/fake.sock",
    clients: () => Array.from({ length: clients }, () => ({})) as never,
    requestClientState: () => Promise.resolve(null),
  };
}

const settle = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

Deno.test("cost: the UDS broadcaster attributes its own rounds", async () => {
  const meter = createCostMeter();
  meter.setKnownCells(["balances"]);
  const ctrl = createUdsBroadcastController({
    getUdsHandle: () => handleThatSends({ full: 0, patch: 1 }),
    syncIntervalMs: 5,
    costMeter: () => meter,
    getUIState: () => ({ balances: { sol: 48 } }),
  });
  try {
    ctrl.onUdsBroadcast(PATCHES);
    await settle(40);
    const c = meter.report({ windowSec: 60 }).cells.find((x) =>
      x.cell === "balances"
    );
    assert(
      c && c.bytesPerSec > 0,
      `a UDS push must reach the meter: ${JSON.stringify(c)}`,
    );
  } finally {
    ctrl.dispose();
  }
});

Deno.test("cost: a round that sent NOTHING is not counted as a push", async () => {
  // The reason `broadcastState` reports what it sent instead of the caller
  // assuming. Every client already holds that exact state ⇒ nothing leaves the
  // socket, and attributing a push there is a plausible number that is wrong —
  // the failure mode `am cost` exists to remove, not to create.
  const meter = createCostMeter();
  meter.setKnownCells(["balances"]);
  const ctrl = createUdsBroadcastController({
    getUdsHandle: () => handleThatSends({ full: 0, patch: 0 }),
    syncIntervalMs: 5,
    costMeter: () => meter,
    getUIState: () => ({ balances: { sol: 48 } }),
  });
  try {
    ctrl.onUdsBroadcast(PATCHES);
    await settle(40);
    assertEquals(
      meter.report({ windowSec: 60 }).idleCells,
      ["balances"],
      "no bytes left the socket, so the cell is idle",
    );
  } finally {
    ctrl.dispose();
  }
});

Deno.test("cost: a controller with no meter still broadcasts", async () => {
  // Every unit test of the throttle builds one without a meter; attribution
  // must be an addition, never a requirement.
  let calls = 0;
  const ctrl = createUdsBroadcastController({
    getUdsHandle: () => {
      calls++;
      return handleThatSends({ full: 1, patch: 0 });
    },
    syncIntervalMs: 5,
  });
  try {
    ctrl.onUdsBroadcast(true);
    await settle(40);
    assert(calls > 0, "the broadcast still happens");
  } finally {
    ctrl.dispose();
  }
});

Deno.test("vitals: a UDS round feeds the broadcasts/sec alarm too", () => {
  // The same class, one function up from the cost meter: the WS flush counts a
  // round only when it has WS clients — right for WS, and it left the
  // broadcasts/sec pressure alarm permanently silent on the desktop target,
  // where every client is on the socket. A diagnostic that cannot fire is not
  // a diagnostic.
  let rounds = 0;
  const ctrl = createUdsBroadcastController({
    getUdsHandle: () => handleThatSends({ full: 0, patch: 1 }),
    syncIntervalMs: 5,
    onBroadcastRound: () => rounds++,
  });
  const quiet = createUdsBroadcastController({
    getUdsHandle: () => handleThatSends({ full: 0, patch: 0 }),
    syncIntervalMs: 5,
    onBroadcastRound: () => rounds++,
  });
  try {
    ctrl.broadcastFull();
    assertEquals(rounds, 1, "bytes on the wire is a round");
    // …and a send that produced nothing is NOT a round, or the rate the alarm
    // watches would climb on an app that is pushing nothing at all.
    quiet.broadcastFull();
    assertEquals(rounds, 1);
  } finally {
    ctrl.dispose();
    quiet.dispose();
  }
});

// ── /__aio/metrics, the surface a supervisor scrapes ────────────────
//
// The fourth instance of the same class. `aio_clients_connected` was counted
// from `clientBackpressure`, a map keyed by WS client id — so a desktop app,
// whose clients are ALL on the socket, exported a confident `0` to whatever is
// watching it. A metric that is absent invites a question; a metric that is
// wrong ends one.
import { formatPrometheus } from "../src/server/server-metrics.ts";

Deno.test("metrics: aio_clients_connected counts BOTH transports", () => {
  const wsOnly = formatPrometheus({ uptimeSeconds: 1, clients: 2 });
  assertStringIncludes(wsOnly, "aio_clients_connected 2");
  // The name is generic, so the HELP text must not promise WS only — a
  // scraper's dashboard legend is read far more often than this file.
  assertStringIncludes(wsOnly, "Connected clients (WS + UDS)");
  assert(
    !wsOnly.includes("Connected WebSocket clients"),
    "the old help text claimed a transport the gauge no longer means",
  );
});

// ── The other half: the BYTES on the wire ────────────────────────────────
//
// Attribution (above) answers "which cell pushed". The wire totals answer "how
// much went out", and on UDS they were never measured at all: `recordSend` was
// wired to the WS `socket.send` wrapper only, so `am cost` printed
// `bytes/s 0` for every cell on the DEFAULT desktop transport.
//
// That is worse than unmeasured. A field report hunting a suspected re-render
// storm in an Electron app asked the tool built for exactly that, was told
// `0 bytes/s`, and concluded the server was quiet. It was not — a 5-second
// poller was reassigning a ~100 KB array on every tick, found through
// `am timeline` instead. A measured zero and an unmeasured one must not print
// the same number.
//
// Held to the same standard as the WS path (`cost-wire-accuracy.test.ts`):
// what the meter reports must EQUAL what a real socket received.
Deno.test("cost: UDS wire bytes equal what the socket actually received", async () => {
  const dir = await tempDir("cost-uds-");
  const socketPath = join(dir, "cost.sock");
  const meter = createCostMeter();
  let state = { balances: { sol: 1 } };
  const uds = createUDSListener(
    socketPath,
    () => state,
    () => {},
    () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    meter,
  );
  const conn = await Deno.connect({ path: socketPath, transport: "unix" });
  let received = 0;
  const reader = conn.readable.getReader();
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        received += value.byteLength;
      }
    } catch { /* aio-ok: the socket closes at the end of the test */ }
  })();
  try {
    await new Promise((r) => setTimeout(r, 100)); // handshake frames
    state = { balances: { sol: 2 } };
    uds.broadcastState(true);
    await new Promise((r) => setTimeout(r, 150));

    const r = meter.report({ windowSec: 60 });
    assert(
      r.wire.totalBytes > 0,
      "the desktop transport reported ZERO bytes — a measured zero and an " +
        "unmeasured one must not print the same number",
    );
    assertEquals(
      r.wire.totalBytes,
      received,
      `the meter must count what the socket got: reported ${r.wire.totalBytes}, ` +
        `received ${received}`,
    );
    // NOT asserted here: `clients`. That count comes from `attributeRound` in
    // the app's broadcast path (covered by the first tests in this file); a
    // bare listener has no broadcaster, so asserting it here would be testing
    // wiring this harness deliberately does not build.
  } finally {
    try {
      await reader.cancel();
    } catch { /* aio-ok: already closed */ }
    try {
      conn.close();
    } catch { /* aio-ok: already closed */ }
    uds.shutdown();
    await dropTempDir(dir);
  }
});

// An ack is 40 bytes; a full state can be 8 KB. Counting a wall of acks as
// "the whole state went out" is a plausible headline that is wrong, and people
// act on those. The WS path classifies by the envelope's kind read EXACTLY;
// this pins that UDS uses the same classifier and not a substring match — a
// patch payload can carry the literal `"t":"state"` in its own data.
Deno.test("cost: a UDS frame is classified by its envelope, not by substring", async () => {
  const dir = await tempDir("cost-uds-kind-");
  const socketPath = join(dir, "kind.sock");
  const meter = createCostMeter();
  // The trap: a full-state frame whose PAYLOAD contains the text of a patches
  // envelope. Classified by substring it would be counted as a patch.
  let state = { note: { text: '{"v":2,"t":"patches","d":[]}' } };
  const uds = createUDSListener(
    socketPath,
    () => state,
    () => {},
    () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    meter,
  );
  const conn = await Deno.connect({ path: socketPath, transport: "unix" });
  const reader = conn.readable.getReader();
  (async () => {
    try {
      for (;;) if ((await reader.read()).done) break;
    } catch { /* aio-ok: closed at teardown */ }
  })();
  try {
    await new Promise((r) => setTimeout(r, 100));
    state = { note: { text: '{"v":2,"t":"patches","d":[]}!' } };
    uds.broadcastState(true); // force → a FULL state frame
    await new Promise((r) => setTimeout(r, 150));
    const r = meter.report({ windowSec: 60 });
    assert(
      r.wire.byKind.full > 0 && r.wire.byKind.patch === 0,
      `a forced full send must count as a full resend, not a patch: ${
        JSON.stringify(r.wire.byKind)
      }`,
    );
  } finally {
    try {
      await reader.cancel();
    } catch { /* aio-ok: already closed */ }
    try {
      conn.close();
    } catch { /* aio-ok: already closed */ }
    uds.shutdown();
    await dropTempDir(dir);
  }
});
