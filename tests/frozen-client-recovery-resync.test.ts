// A client graded FROZEN that then recovers gets the state it missed at once —
// not whenever the app next happens to change.
//
// While the freeze watchdog grades a client frozen, the broadcaster skips its
// rounds and marks it `needsFull`. The debt was only ever paid by the NEXT
// state-change round, and `onClientRecovered` raised an alert and nothing
// else. On an idle app there is no next round, so the recovered client sat on
// stale state indefinitely: the r3 chaos hunt watched a client hold v=4 for
// 8 s+ after its heartbeat resumed while the server held v=6, dev and prod
// alike. The real triggers are ordinary — a background tab, a closed laptop
// lid, a GC pause longer than the 2 s frozen threshold.
//
// Real server, real socket, a raw client speaking the heartbeat protocol; the
// watchdog tick is driven by hand so the test does not sleep through the
// production 2 s threshold.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createServer } from "../src/server/server.ts";
import { createVitalsSystem } from "../src/vitals/mod.ts";
import { DEFAULT_THRESHOLDS } from "../src/vitals/types.ts";
import type { PatchEntry } from "../src/protocol/broadcast-utils.ts";
import { freePort } from "../src/testing/server-test.ts";

const FROZEN_MS = 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("vitals: a frozen client that recovers on an IDLE app is resynced immediately", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "dist", "app.js"),
    "export function mount(){}",
  );
  const vitals = createVitalsSystem({
    thresholds: {
      transport: { ...DEFAULT_THRESHOLDS.transport, frozen: FROZEN_MS },
    },
    pressure: false,
  });
  const state = { ctr: { v: 0 } };
  const port = freePort();
  const server = createServer({
    port,
    title: "FrozenRecovery",
    getUIState: () => state,
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, "dist"),
    syncIntervalMs: 10,
    vitalsSystem: vitals,
  });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  /** Every `v` the client has been handed, in order, from state or patches. */
  const seen: Array<{ t: string; v: number }> = [];
  ws.onmessage = (e) => {
    const f = JSON.parse(String(e.data));
    if (f.t === "state" && typeof f.d?.ctr?.v === "number") {
      seen.push({ t: "state", v: f.d.ctr.v });
    } else if (f.t === "patches" && Array.isArray(f.d)) {
      for (const op of f.d) {
        if (op.path?.join(".") === "ctr.v") {
          seen.push({ t: "patch", v: op.value });
        }
      }
    }
  };
  const ping = () =>
    ws.send(JSON.stringify({ v: 2, t: "vitals-ping", d: { t1: Date.now() } }));
  const commit = (v: number) => {
    state.ctr = { v };
    server.broadcast(
      [{
        cell: "ctr",
        ops: [{ op: "replace", path: ["v"], value: v }],
      }] as PatchEntry[],
    );
  };
  const last = () => seen[seen.length - 1]?.v;
  const waitV = async (v: number, ms: number) => {
    for (let i = 0; i < ms / 10 && last() !== v; i++) await sleep(10);
  };
  try {
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    // ── online: the client beats and follows every change ────────────────
    ping();
    await sleep(30);
    commit(1);
    await waitV(1, 1000);
    assertEquals(last(), 1, "an online client follows the state");

    // ── frozen: silent past the threshold; the change is skipped for it ──
    await sleep(FROZEN_MS + 100);
    vitals.checkAndAlert();
    assert(
      vitals.getEndpointData().clients.some((c) => c.status === "frozen"),
      "the silent client is graded frozen",
    );
    commit(2);
    await sleep(150);
    assertEquals(last(), 1, "a frozen client's round is skipped");

    // ── recovered, and the app is IDLE: no further commit happens ─────────
    ping();
    await sleep(50);
    vitals.checkAndAlert(); // the watchdog tick that sees the heartbeat again
    await waitV(2, 1000);
    assertEquals(
      last(),
      2,
      `a recovered client must be sent the state its skipped rounds carried ` +
        `without waiting for another change — it is still on v=${last()}`,
    );
    assertEquals(
      seen[seen.length - 1]!.t,
      "state",
      "…as WHOLE state: the skipped patches are gone",
    );
  } finally {
    ws.close();
    await sleep(50);
    await server.shutdown();
    vitals.destroy();
    await Deno.remove(dir, { recursive: true });
  }
});
