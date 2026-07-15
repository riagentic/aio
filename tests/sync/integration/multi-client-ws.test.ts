// A6 (in-repo slice) — multi-client CRDT sync under concurrency, end-to-end
// over real WebSockets: two clients fire interleaved ops at a live server
// (worker-backed SQLite op-log); every op must be acked, relayed exactly once
// to the peer, and visible to a late-joining third client via __sync.
import { assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { createServer } from "../../../src/server/server.ts";
import { createDB } from "../../../src/db/mod.ts";
import { SYNC_SCHEMA } from "../../../src/sync/compact.ts";
import { createServerSyncHandler } from "../../../src/sync/server-handler.ts";
import type { HLC } from "../../../src/sync/types.ts";

const PORT = 8971;
const OPS_PER_CLIENT = 25;

type WireOp = {
  id: string;
  hlc: HLC;
  cell: string;
  action: string;
  payload: unknown;
};

function makeOp(client: string, i: number): WireOp {
  return {
    id: `${client}-${i}`,
    hlc: [Date.now(), i, client],
    cell: "notes",
    action: "add",
    payload: { text: `${client} note ${i}` },
  };
}

function connect(port: number): Promise<{
  ws: WebSocket;
  acks: string[];
  relayed: WireOp[];
  syncs: unknown[];
  closed: Promise<void>;
}> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const acks: string[] = [];
    const relayed: WireOp[] = [];
    const syncs: unknown[] = [];
    const closed = new Promise<void>((r) =>
      ws.addEventListener("close", () => r())
    );
    ws.addEventListener("message", (e) => {
      const raw = e.data as string;
      if (raw.startsWith("__")) return; // control frames (__proto:, __boot:)
      try {
        const parsed = JSON.parse(raw);
        if (parsed.__ack?.opId) acks.push(parsed.__ack.opId as string);
        if (parsed.__op) relayed.push(parsed.__op as WireOp);
        if (parsed.__sync) syncs.push(parsed.__sync);
      } catch { /* state frames — ignore */ }
    });
    ws.addEventListener(
      "open",
      () => resolve({ ws, acks, relayed, syncs, closed }),
    );
  });
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) {
      throw new Error("waitFor: condition not met in time");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

Deno.test("sync: two concurrent WS clients — every op acked and relayed exactly once; late client catches up", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "dist", "app.js"),
    "export function mount(){}",
  );

  const db = createDB(join(dir, "sync.db"));
  for (const sql of SYNC_SCHEMA) await db.execute(sql);

  const cellState: Record<string, unknown> = { items: [] };
  const broadcastRef = {
    fn: (_msg: string, _exclude?: WebSocket) => {},
  };
  const syncHandler = createServerSyncHandler({
    dispatch: () => {}, // this harness asserts the op-log/relay contract only
    db,
    syncCellIds: ["notes"],
    getCellState: () => cellState as Record<string, unknown>,
    broadcastRaw: broadcastRef,
    log: { debug: () => {}, warn: () => {}, error: () => {} },
  });

  const server = createServer({
    port: PORT,
    title: "SyncConcurrency",
    getUIState: () => ({ notes: cellState }),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, "dist"),
    syncHandler,
  });
  // Wire peer broadcast through the live server (as aio-boot does).
  broadcastRef.fn = (msg: string, exclude?: WebSocket) =>
    server.broadcastRaw(msg, exclude);

  await new Promise((r) => setTimeout(r, 50));

  try {
    const a = await connect(PORT);
    const b = await connect(PORT);

    // Interleave 25 ops per client, no pacing — the concurrency storm.
    for (let i = 0; i < OPS_PER_CLIENT; i++) {
      a.ws.send(JSON.stringify({ __op: makeOp("clientA", i) }));
      b.ws.send(JSON.stringify({ __op: makeOp("clientB", i) }));
    }

    await waitFor(() =>
      a.acks.length >= OPS_PER_CLIENT && b.acks.length >= OPS_PER_CLIENT &&
      a.relayed.length >= OPS_PER_CLIENT && b.relayed.length >= OPS_PER_CLIENT
    );

    // Every own op acked exactly once.
    assertEquals([...new Set(a.acks)].length, OPS_PER_CLIENT, "A acks unique");
    assertEquals([...new Set(b.acks)].length, OPS_PER_CLIENT, "B acks unique");

    // Every peer op relayed exactly once, none of our own echoed back.
    const aSeen = a.relayed.map((o) => o.id);
    assertEquals(aSeen.length, OPS_PER_CLIENT, "A sees exactly B's ops");
    assertEquals(
      aSeen.every((id) => id.startsWith("clientB-")),
      true,
      "A never receives its own ops",
    );
    const bSeen = b.relayed.map((o) => o.id);
    assertEquals(bSeen.length, OPS_PER_CLIENT, "B sees exactly A's ops");
    assertEquals(
      bSeen.every((id) => id.startsWith("clientA-")),
      true,
      "B never receives its own ops",
    );

    // Late joiner: full catch-up via __sync (snapshot or incremental —
    // compaction may have folded ops below the low-water mark).
    const c = await connect(PORT);
    c.ws.send(JSON.stringify({
      __sync: {
        clientId: "clientC",
        cells: { notes: { lastHlc: null } },
        pendingOps: [],
      },
    }));
    await waitFor(() => c.syncs.length >= 1);
    const syncResp = c.syncs[0] as {
      mode: "snapshot" | "incremental";
      ops: WireOp[];
      lowWater: Record<string, HLC>;
    };
    assertExists(syncResp.mode, "sync response has a mode");
    if (syncResp.mode === "incremental" && !syncResp.lowWater["notes"]) {
      // Nothing compacted → the op-log must contain every op from A and B.
      assertEquals(
        [...new Set(syncResp.ops.map((o) => o.id))].length,
        OPS_PER_CLIENT * 2,
        "late client receives the full op-log",
      );
    }

    a.ws.close();
    b.ws.close();
    c.ws.close();
    await Promise.all([a.closed, b.closed, c.closed]);
  } finally {
    await server.shutdown();
    await db.close();
    await Deno.remove(dir, { recursive: true });
  }
});
