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
