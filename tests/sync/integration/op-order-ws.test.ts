// tests/sync/integration/op-order-ws.test.ts — the fold-order contract over a
// REAL WebSocket, against a live server and a worker-backed SQLite op-log.
//
// The in-process harnesses can order frames however they like; only the real
// transport proves what a client actually sees. Scenario is the ordinary
// offline-first one: a peer writes while our client is offline, our client
// edits offline too, then reconnects. The server applies the peer's op first
// and ours second — so the client must end up with OUR value. Folding the
// catch-up on top of its own already-acked op reverted the user's own edit on
// the user's own screen while the server and every peer kept it.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createServer } from "../../../src/server/server.ts";
import { createDB } from "../../../src/db/mod.ts";
import { SYNC_SCHEMA } from "../../../src/sync/compact.ts";
import { createServerSyncHandler } from "../../../src/sync/server-handler.ts";
import { createSyncEngine } from "../../../src/sync/sync-engine.ts";
import {
  createMemoryStorage,
  createOpBuffer,
} from "../../../src/sync/op-buffer.ts";
import { normalizeSyncConfig } from "../../../src/sync/types.ts";
import type { HLC, SyncOp } from "../../../src/sync/types.ts";
import { freePort } from "../../e2e-harness.ts";

const CELL = "board";

/** Order-sensitive on purpose — the shape of every `s.field = x` method. */
const reduce = (
  s: Record<string, unknown>,
  action: string,
  payload: unknown,
): Record<string, unknown> => action === "set" ? { ...s, value: payload } : s;

function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", () => reject(new Error("ws failed")));
  });
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor: ${what}`);
}

Deno.test("sync over a real socket: an offline edit lands where the server put it", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "dist", "app.js"),
    "export function mount(){}",
  );
  const port = freePort();
  const db = createDB(join(dir, "order.db"));
  for (const sql of SYNC_SCHEMA) await db.execute(sql);

  let live: Record<string, unknown> = { value: "initial" };
  const broadcastRef = { fn: (_m: string, _e?: WebSocket) => {} };
  const syncHandler = createServerSyncHandler({
    dispatch: (a) => {
      const m = a as { type: string; payload?: unknown };
      live = reduce(live, m.type.slice(m.type.indexOf(":") + 1), m.payload);
    },
    db,
    syncCellIds: [CELL],
    getCellState: () => live,
    getClientCellState: () => live,
    broadcastRaw: broadcastRef,
    log: { debug: () => {}, warn: () => {}, error: () => {} },
  });
  const server = createServer({
    port,
    title: "OpOrder",
    getUIState: () => ({ [CELL]: live }),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, "dist"),
    syncHandler,
  });
  broadcastRef.fn = (msg, exclude) => server.broadcastRaw(msg, exclude);
  await new Promise((r) => setTimeout(r, 50));

  try {
    // ── a peer writes while our client is offline ──────────────────────
    const peer = await openWs(`ws://127.0.0.1:${port}/ws`);
    const peerAcked: string[] = [];
    peer.addEventListener("message", (e) => {
      const f = JSON.parse(e.data as string);
      if (f?.t === "sync-ack") peerAcked.push(f.d.opId);
    });
    peer.send(JSON.stringify({
      v: 2,
      t: "op",
      d: {
        id: "peer-1",
        hlc: [Date.now(), 0, "peer"] as HLC,
        cell: CELL,
        action: "set",
        payload: "peer-value",
      },
    }));
    await waitFor(() => peerAcked.length === 1, "peer op acked");

    // ── our client: offline edit, then reconnect ───────────────────────
    let confirmed: Record<string, unknown> = { value: "initial" };
    let ws: WebSocket | null = null;
    const engine = createSyncEngine({
      clientId: "me",
      cells: { [CELL]: normalizeSyncConfig(true) },
      buffer: createOpBuffer(createMemoryStorage()),
      send: (m) => ws?.send(m),
      reducer: (s, action, payload) => reduce(s, action, payload),
      getConfirmedState: () => ({ [CELL]: confirmed }),
      setConfirmedState: (_c, s) => {
        confirmed = s;
      },
      onStateUpdate: () => {},
    });

    engine.setOnline(false);
    await engine.handleLocalAction(CELL, "set", "mine");

    let frames = 0;
    ws = await openWs(`ws://127.0.0.1:${port}/ws`);
    ws.addEventListener("message", (e) => {
      const f = JSON.parse(e.data as string);
      if (f?.v !== 2) return;
      if (f.t === "sync-ack") {
        frames++;
        void engine.handleAck(f.d.cell, f.d.opId, f.d.serverHlc, f.d.serverTs);
      } else if (f.t === "op") {
        frames++;
        void engine.handleRemoteOp({ ...f.d, confirmed: true } as SyncOp);
      } else if (f.t === "sync-res") {
        frames++;
        void engine.handleSyncResponse(f.d);
      }
    });
    engine.setOnline(true); // flushes the offline queue via a real sync-req

    await waitFor(() => frames >= 2, "ack + sync-res over the wire");
    await new Promise((r) => setTimeout(r, 150)); // let the folds settle

    assertEquals(live.value, "mine", "server applied the queued op last");
    assertEquals(
      confirmed.value,
      live.value,
      "the client must end on the server's value — its own offline edit is " +
        "the newest write and must not be reverted by the catch-up",
    );

    peer.close();
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    await server.shutdown();
    await db.close();
    await Deno.remove(dir, { recursive: true });
  }
});
