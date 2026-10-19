// A HIDDEN page is not graded frozen. Browsers throttle a background tab's
// timers, so its heartbeat arrives late and the watchdog logged
// `ERROR diag [transport] frozen` about once a minute for a healthy tab — and
// `server-broadcast.ts` skipped it. The page says it is hidden (`h: 1` on its
// ping); the server stops grading it until a visible ping, so it keeps getting
// every broadcast. A VISIBLE client that goes silent is still frozen.
//
// Real server, real socket, a raw client; the watchdog tick is driven by hand.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createServer } from "../src/server/server.ts";
import { createVitalsSystem } from "../src/vitals/mod.ts";
import { DEFAULT_THRESHOLDS } from "../src/vitals/types.ts";
import type { PatchEntry } from "../src/protocol/broadcast-utils.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const FROZEN_MS = 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("vitals: a hidden page is not graded frozen and still gets broadcasts; a silent visible one is frozen", async () => {
  const dir = await tempDir("aio-hidden-tab-");
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "dist", "app.js"),
    "export function mount(){}",
  );
  const alerts: string[] = [];
  const vitals = createVitalsSystem({
    thresholds: {
      transport: { ...DEFAULT_THRESHOLDS.transport, frozen: FROZEN_MS },
    },
    pressure: false,
    onVitalAlert: (a) => alerts.push(`${a.layer}:${a.status}`),
  });
  const state = { ctr: { v: 0 } };
  const port = freePort();
  const server = createServer({
    port,
    title: "HiddenTab",
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
  let last: number | undefined;
  ws.onmessage = (e) => {
    const f = JSON.parse(String(e.data));
    if (f.t === "state" && typeof f.d?.ctr?.v === "number") last = f.d.ctr.v;
    else if (f.t === "patches" && Array.isArray(f.d)) {
      for (const op of f.d) {
        if (op.path?.join(".") === "ctr.v") last = op.value;
      }
    }
  };
  const ping = (d: Record<string, unknown> = {}) =>
    ws.send(
      JSON.stringify({ v: 2, t: "vitals-ping", d: { t1: Date.now(), ...d } }),
    );
  const commit = (v: number) => {
    state.ctr = { v };
    server.broadcast(
      [{
        cell: "ctr",
        ops: [{ op: "replace", path: ["v"], value: v }],
      }] as PatchEntry[],
    );
  };
  const waitV = async (v: number, ms: number) => {
    for (let i = 0; i < ms / 10 && last !== v; i++) await sleep(10);
  };
  const status = () => vitals.getEndpointData().clients[0]?.status;
  try {
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    ping();
    await sleep(30);
    commit(1);
    await waitV(1, 1000);
    assertEquals(last, 1);

    // ── hidden: the beat stops (throttled) past the threshold ─────────────
    ping({ h: 1 });
    await sleep(FROZEN_MS + 100);
    vitals.checkAndAlert();
    assert(status() !== "frozen", `a hidden page is not frozen: ${status()}`);
    assertEquals(alerts, [], "no frozen alert for a hidden page");
    commit(2);
    await waitV(2, 1000);
    assertEquals(last, 2, "a hidden page still gets every broadcast");

    // ── visible again, then truly silent: frozen, skipped ─────────────────
    ping();
    await sleep(FROZEN_MS + 100);
    vitals.checkAndAlert();
    assertEquals(status(), "frozen", "a silent VISIBLE client is frozen");
    commit(3);
    await sleep(150);
    assertEquals(last, 2, "a frozen client's round is skipped");

    // ── a frozen client that reports hidden recovers (never stuck) ────────
    ping({ h: 1 });
    await sleep(30);
    vitals.checkAndAlert();
    await waitV(3, 1000);
    assertEquals(last, 3, "a hidden ping lifts the freeze and resyncs");
  } finally {
    ws.close();
    await sleep(50);
    await server.shutdown();
    vitals.destroy();
    await dropTempDir(dir);
  }
});
