// The whole-state frame a WS client gets on CONNECT feeds the pressure
// monitor, like every frame the broadcaster sends.
//
// The broadcaster meters its frames (`_meterSent` → `pressureMonitor
// .onBroadcast`), but the connect frame is sent by server-ws.ts itself and
// was never metered — so the `payload` budget (and the PRESSURE line) saw the
// biggest frame a client ever gets only when a later broadcast happened to
// flip to full. The docs promise "a whole-state frame trips it too".
import { assert, assertEquals } from "@std/assert";
import { dec, enc } from "../src/protocol/envelope.ts";
import { freePort } from "../src/testing/server-test.ts";
import { createWsManager } from "../src/server/server-ws.ts";
import { createVitalsSystem } from "../src/vitals/mod.ts";
import { createBudgetLedger } from "../src/state/budgets.ts";

Deno.test("ws connect: the initial whole-state frame is metered against the payload budget", async () => {
  const state = { rows: { blob: "x".repeat(8_000) } };
  const ledger = createBudgetLedger({ payload: 4_000 });
  const vitals = createVitalsSystem(
    { pressure: { payloadThreshold: 4_000 }, onDiagnostic: () => {} },
    ledger,
  );
  const mgr = createWsManager({
    dispatch: () => {},
    getUIState: () => state,
    debug: () => {},
    prod: false,
    clientCounter: { value: 0 },
    bootId: "b",
    vitalsSystem: vitals,
  });
  const port = freePort();
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    (req) => mgr.handleWs(req),
  );
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.onmessage = (e) => {
        if (dec(String(e.data))?.t === "state") resolve();
      };
      ws.onerror = () => reject(new Error("ws error"));
    });
    ws.close();
    // No broadcast ever ran — only the connect frame can have been metered.
    const report = ledger.report();
    assertEquals(report?.ok, false, "the connect frame was never metered");
    const breach = report!.breaches.find((b) => b.budget === "payload");
    assert(breach && breach.worst > 8_000, JSON.stringify(report));
  } finally {
    mgr.shutdown();
    await server.shutdown();
    vitals.destroy();
  }
});

Deno.test("ws resync: a whole view re-sent on request is metered too", async () => {
  // `resync` (and `subs`, and a user change) re-send the WHOLE view outside
  // the broadcaster — paid in full, and unmetered until 1.0.11.
  const state = { rows: { blob: "x".repeat(8_000) } };
  const ledger = createBudgetLedger({ payload: 4_000 });
  const vitals = createVitalsSystem(
    { pressure: { payloadThreshold: 4_000 }, onDiagnostic: () => {} },
    ledger,
  );
  const metered: number[] = [];
  const pm = vitals.pressureMonitor!;
  const orig = pm.onBroadcast.bind(pm);
  pm.onBroadcast = (id: string, bytes: number) => {
    metered.push(bytes);
    return orig(id, bytes);
  };
  const mgr = createWsManager({
    dispatch: () => {},
    getUIState: () => state,
    debug: () => {},
    prod: false,
    clientCounter: { value: 0 },
    bootId: "b",
    vitalsSystem: vitals,
  });
  const port = freePort();
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    (req) => mgr.handleWs(req),
  );
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    let states = 0;
    await new Promise<void>((resolve, reject) => {
      ws.onmessage = (e) => {
        if (dec(String(e.data))?.t !== "state") return;
        states++;
        if (states === 1) ws.send(enc("resync"));
        else resolve();
      };
      ws.onerror = () => reject(new Error("ws error"));
    });
    ws.close();
    assertEquals(metered.length, 2, "connect frame + resync frame");
    assert(metered.every((b) => b > 8_000), String(metered));
  } finally {
    mgr.shutdown();
    await server.shutdown();
    vitals.destroy();
  }
});

Deno.test("ws: every whole-state frame server-ws.ts sends itself is metered", () => {
  // Four sites send a whole view outside the broadcaster: connect, a user
  // change, `subs`, `resync`. A property over the file, so a fifth cannot
  // land unmetered.
  const src = Deno.readTextFileSync(
    new URL("../src/server/server-ws.ts", import.meta.url),
  );
  const sends = src.match(/encRaw\("state", msg\)/g)?.length ?? 0;
  const meters = src.match(/onBroadcast\(meta\.id, utf8Size\(frame\)\)/g)
    ?.length ?? 0;
  assert(sends >= 4, `expected the four whole-view sites, found ${sends}`);
  assertEquals(meters, sends, "a whole-state send without its meter");
});
