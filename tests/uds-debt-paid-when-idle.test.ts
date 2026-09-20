// A round the DESKTOP transport lost is owed to its window — and the debt has
// to be paid even when no later round ever comes.
//
// `uds.ts` marks a peer `needsFull` when its round threw or its snapshot could
// not be built, and only a LATER round honoured the mark. An app that goes
// idle after the loss never has one, so the Electron window sat on the state
// from before it for as long as nothing changed — health green, nothing
// logged after the first error. The WS twin got an idle retry for exactly
// this (tests/ws-backlog-debt-paid-when-idle.test.ts); this is the same
// payment on the transport where every desktop client lives, through the SAME
// retry scheduler (`createDebtRetry`), and metered like any other round.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createUDSListener } from "../src/server/uds.ts";
import { createUdsBroadcastController } from "../src/server/aio-run-helpers.ts";
import { createCostMeter } from "../src/vitals/cost-meter.ts";
import type { PatchEntry } from "../src/protocol/broadcast-utils.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PAD = "p".repeat(400); // keeps a one-field patch under the threshold

function readFrames(conn: Deno.Conn): string[] {
  const lines: string[] = [];
  const reader = conn.readable.getReader();
  const dec = new TextDecoder();
  let buf = "";
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n");
        buf = parts.pop()!;
        for (const p of parts) if (p) lines.push(p);
      }
    } catch { /* aio-ok: closed at teardown */ }
  })();
  return lines;
}

async function setup(prefix: string, getUIState: () => unknown) {
  const dir = await tempDir(prefix);
  const socketPath = join(dir, "debt.sock");
  const uds = createUDSListener(socketPath, getUIState, () => {}, () => {});
  const meter = createCostMeter();
  meter.setKnownCells(["c", "f"]);
  let rounds = 0;
  const ctrl = createUdsBroadcastController({
    getUdsHandle: () => uds,
    syncIntervalMs: 1,
    costMeter: () => meter,
    getUIState: () => getUIState() as Record<string, unknown>,
    onBroadcastRound: () => rounds++,
  });
  await wait(30);
  const conn = await Deno.connect({ path: socketPath, transport: "unix" });
  const lines = readFrames(conn);
  await wait(80);
  return {
    uds,
    ctrl,
    meter,
    lines,
    rounds: () => rounds,
    async close() {
      ctrl.dispose();
      conn.close();
      await wait(30);
      uds.shutdown();
      await dropTempDir(dir);
    },
  };
}

Deno.test("uds idle debt: a round lost to a transient snapshot failure is paid with no later round", async () => {
  const state = { c: { v: 1, pad: PAD }, f: { x: 1 } };
  let broken = false;
  const t = await setup("uds-debt-idle-", () => {
    if (broken) throw new Error("transient: view threw");
    return state;
  });
  try {
    t.lines.length = 0;
    // A "full"-strategy cell changes; its force round cannot be built.
    state.f = { x: 2 };
    broken = true;
    t.ctrl.onUdsBroadcast(true);
    await wait(20);
    assertEquals(t.lines.length, 0, "instrument: nothing could go out");
    assertEquals(t.uds.clients()[0]?.needsFull, true, "…and it is owed");

    // The view heals — and the app is idle from here on: no dispatch, no round.
    broken = false;
    const t0 = Date.now();
    while (t.lines.length === 0 && Date.now() - t0 < 3000) await wait(20);
    assertEquals(
      t.lines.length,
      1,
      "the window must be paid its state — it sat on f.x=1 against a server " +
        "at 2, with the server idle",
    );
    const frame = JSON.parse(t.lines[0]!) as {
      t: string;
      d: { f: { x: number } };
    };
    assertEquals(frame.t, "state");
    assertEquals(frame.d.f.x, 2);
    await wait(30);
    assertEquals(t.uds.clients()[0]?.needsFull, false, "the debt is settled");

    // Metered like a round: `am cost` sees the resend, attributed as a whole
    // slice (the ws retry was blind here too — see ws-debt-metered).
    const r = t.meter.report({ windowSec: 60 });
    const f = r.cells.find((x) => x.cell === "f");
    assert(f && f.fullResends >= 1, `unattributed: ${JSON.stringify(r.cells)}`);

    // Paid once, not polled forever.
    await wait(300);
    assertEquals(t.lines.length, 1, t.lines.join("\n"));
  } finally {
    await t.close();
  }
});

Deno.test("uds idle debt: a view that stays broken is retried, never sent garbage, and backs off", async () => {
  const state = { c: { v: 1, pad: PAD } };
  let calls = 0;
  let broken = false;
  const t = await setup("uds-debt-broken-", () => {
    if (broken) {
      calls++;
      throw new Error("still broken");
    }
    return state;
  });
  try {
    t.lines.length = 0;
    broken = true;
    t.ctrl.onUdsBroadcast(true);
    await wait(700);
    assertEquals(t.lines.length, 0);
    assertEquals(t.uds.clients()[0]?.needsFull, true, "the debt is kept");
    // 50, 100, 200, 400 ms… — a handful of attempts in 700 ms, not hundreds.
    assert(calls >= 2 && calls <= 8, `retry attempts in 700 ms: ${calls}`);
  } finally {
    await t.close();
  }
});

Deno.test("uds idle debt: a thrown round is repaired without a later round", async () => {
  const state = { c: { v: 1, pad: PAD } };
  const t = await setup("uds-debt-thrown-", () => state);
  try {
    t.lines.length = 0;
    state.c = { v: 2, pad: PAD };
    // A patch JSON cannot carry — the round throws for this peer.
    t.ctrl.onUdsBroadcast([
      { cell: "c", ops: [{ op: "replace", path: ["v"], value: 2n }] },
    ] as unknown as PatchEntry[]);
    const t0 = Date.now();
    while (t.lines.length === 0 && Date.now() - t0 < 3000) await wait(20);
    assertEquals(t.lines.length, 1, t.lines.join("\n"));
    const frame = JSON.parse(t.lines[0]!) as {
      t: string;
      d: { c: { v: number } };
    };
    assertEquals(frame.t, "state");
    assertEquals(frame.d.c.v, 2);
  } finally {
    await t.close();
  }
});
