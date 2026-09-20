// tests/sync/resync-survives-reconnect.test.ts — a cell re-sync the engine
// asked for is asked for again until a response to it lands.
//
// Found by the r4 sync hunt (2026-09-19), a randomized twin-tab model. The r3
// fixes made `SyncRequest.resync` load-bearing: a late ack (late-ack-resync)
// and an own op another tab confirmed (twin-tab-own-op) leave confirmed state
// wrong until the snapshot they ask for arrives. The ask was consumed when the
// request was SENT, so a request that died with its connection — sent, then
// the socket dropped before the server read it or before its response came
// back — took the ask with it. The reconnect's catch-up was incremental, the
// tab kept a state the server never had (the other tab's later `rm` of the op
// then failed to fold on it), and nothing asked again.
import { assertEquals } from "@std/assert";
import {
  createMemoryStorage,
  createOpBuffer,
} from "../../src/sync/op-buffer.ts";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";
import type { HLC } from "../../src/sync/types.ts";

type Frame = { t: string; d: Record<string, unknown> };

function makeEngine() {
  const sent: Frame[] = [];
  let confirmed: Record<string, unknown> = { items: [] };
  const engine = createSyncEngine({
    clientId: "me",
    cells: { c: normalizeSyncConfig(true) },
    buffer: createOpBuffer(createMemoryStorage()),
    send: (m) => void sent.push(JSON.parse(m)),
    reducer: (s, _a, p) => ({
      items: [...((s.items as string[]) ?? []), p as string],
    }),
    getConfirmedState: () => ({ c: confirmed }),
    setConfirmedState: (_c, s) => void (confirmed = s),
    onStateUpdate: () => {},
    log: { warn: () => {}, debug: () => {} },
  });
  return { engine, sent };
}

const tick = () => new Promise((r) => setTimeout(r, 5));
const lastReq = (sent: Frame[]) => sent.findLast((f) => f.t === "sync-req")!.d;

/** An ack below what confirmed state covers — the engine asks for the cell. */
async function wantResync() {
  const { engine, sent } = makeEngine();
  await engine.requestSync();
  // A catch-up that moves confirmed state to position 10.
  await engine.handleSyncResponse({
    mode: "incremental",
    reqId: lastReq(sent).reqId as number,
    ops: [{
      id: "peer-s-1",
      cell: "c",
      action: "add",
      payload: "p",
      hlc: [1000, 0, "peer"] as HLC,
      confirmed: true,
      serverTs: 10,
    }],
    lastServerTs: { c: 10 },
    lowWater: { c: [1000, 0, "peer"] as HLC },
  });
  await engine.handleLocalAction("c", "add", "x");
  const x = sent.findLast((f) => f.t === "op")!.d;
  await engine.handleAck("c", x.id as string, [2000, 0, "server"], 5);
  await tick(); // the coalesced re-sync request goes out
  assertEquals(lastReq(sent).resync, ["c"], "the late ack asks for the cell");
  return { engine, sent };
}

Deno.test("sync: a re-sync whose request died with the connection is asked for again", async () => {
  const { engine, sent } = await wantResync();
  try {
    // The request never reached the server (or its response never came
    // back): the connection dropped.
    engine.setOnline(false);
    engine.setOnline(true);
    await tick();
    assertEquals(
      lastReq(sent).resync,
      ["c"],
      "the reconnect's catch-up must still ask for the cell",
    );
  } finally {
    engine.dispose();
  }
});

Deno.test("sync: a re-sync is asked for once its response has landed, not again", async () => {
  const { engine, sent } = await wantResync();
  try {
    await engine.handleSyncResponse({
      mode: "snapshot",
      reqId: lastReq(sent).reqId as number,
      snapshot: { c: { items: ["x", "p"] } },
      lastServerTs: { c: 11 },
      lowWater: { c: [2000, 0, "server"] as HLC },
    });
    engine.setOnline(false);
    engine.setOnline(true);
    await tick();
    assertEquals(lastReq(sent).resync, undefined, "answered — not re-asked");
  } finally {
    engine.dispose();
  }
});
