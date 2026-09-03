// The framework-internal action gate has ONE decider for the sync layer.
//
// `__setX` / `cell:__setX` actions write arbitrary paths through
// `applyMutations`; every network door refuses them. The `op` frame was gated
// in each transport router (WS, UDS), but `sync-req.pendingOps` — a
// reconnect's whole offline queue, reached from WS AND UDS — was forwarded
// straight into `handleSync`, which dispatched every entry. So a client that
// could not write `fetched` through `op` wrote it through `sync-req`: the
// write was applied, persisted to the op-log, acked, broadcast to every peer
// and replayed at the next boot (audit a5, 2026-09-02).
//
// The fix puts the predicate inside `isValidSyncOp`, where `op` and every
// `pendingOps` entry converge, for both transports. These tests send the raw
// frames — no client engine in between — and assert the state never moves.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { enc, type Kind } from "../../../src/protocol/envelope.ts";
import { freePort } from "../../../src/testing/server-test.ts";
import { createUDSListener } from "../../../src/server/uds.ts";
import { createServerSyncHandler } from "../../../src/sync/server-handler.ts";
import { isValidSyncOp } from "../../../src/sync/server-handler.ts";
import { createTestDb } from "../_test-db.ts";
import { tempDir } from "../../../src/testing/temp-dir.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const evilOp = (id: string, value: string) => ({
  id,
  hlc: [Date.now(), 0, "evil"] as [number, number, string],
  cell: "notes",
  action: "__setRefresh",
  payload: { mutations: [{ path: ["fetched"], value }] },
  confirmed: false,
});

Deno.test("isValidSyncOp refuses a framework-internal action (top-level and cell-prefixed)", () => {
  const base = {
    id: "x",
    hlc: [1, 0, "c"],
    cell: "notes",
    action: "add",
    payload: {},
  };
  assertEquals(isValidSyncOp(base), true);
  assertEquals(isValidSyncOp({ ...base, action: "__setRefresh" }), false);
  assertEquals(isValidSyncOp({ ...base, action: "notes:__setRefresh" }), false);
  assertEquals(isValidSyncOp({ ...base, action: "__exec" }), false);
  // A method whose name merely contains underscores is a method.
  assertEquals(isValidSyncOp({ ...base, action: "add_item" }), true);
  assertEquals(isValidSyncOp({ ...base, action: "_private" }), true);
});

Deno.test({
  name:
    "WS: `sync-req.pendingOps` refuses a framework-internal action exactly like `op` does",
  async fn() {
    const { cell, aio } = await import("../../../mod.ts");
    const dir = await Deno.makeTempDir({ prefix: "aio-internal-gate-" });
    const notes = cell("notes", {
      state: { items: [] as string[], fetched: "" },
      sync: true,
      methods: {
        add(s: { items: string[] }, v: string) {
          s.items.push(v);
        },
        async refresh(s: { fetched: string }, v: string) {
          await sleep(1);
          s.fetched = v;
        },
      },
    });
    const port = freePort();
    const app = await aio.run({
      cells: [notes],
      appId: "aio-internal-gate",
      client: "server-only",
      persist: true,
      libraryMode: true,
      port,
      appDir: dir,
    });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const frames: { t: string; d: unknown }[] = [];
      ws.addEventListener("message", (e) => {
        try {
          frames.push(JSON.parse(e.data as string));
        } catch { /* ignore */ }
      });
      await new Promise<void>((r) => ws.addEventListener("open", () => r()));
      await sleep(100);
      const state = () =>
        (app.getState() as { notes: { fetched: string; items: string[] } })
          .notes;

      // The `op` door (already gated by the router).
      ws.send(enc("op", evilOp("evil-op-1", "pwned-by-op")));
      await sleep(200);
      assertEquals(state().fetched, "", "op path refuses an internal action");

      // The `sync-req.pendingOps` door — same action, same payload.
      ws.send(enc("sync-req", {
        clientId: "evil",
        reqId: 1,
        cells: { notes: { lastHlc: null } },
        pendingOps: [evilOp("evil-sync-1", "pwned-by-sync-req")],
      }));
      await sleep(400);
      assertEquals(
        state().fetched,
        "",
        "sync-req pendingOps path refuses an internal action",
      );
      // Nothing was acked either — an ack is the client's "persisted" signal.
      assertEquals(
        frames.some((f) =>
          f.t === "sync-ack" &&
          (f.d as { opId?: string }).opId?.startsWith("evil")
        ),
        false,
        "no ack for a refused op",
      );
      // A legitimate op through the same door still works — the gate is
      // selective, not a broken door.
      ws.send(enc("sync-req", {
        clientId: "evil",
        reqId: 2,
        cells: { notes: { lastHlc: null } },
        pendingOps: [{
          ...evilOp("ok-1", ""),
          action: "add",
          payload: { args: ["hello"] },
        }],
      }));
      await sleep(400);
      assertEquals(state().items, ["hello"], "a method op still applies");
      ws.close();
      await sleep(50);
    } finally {
      await app.close();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "UDS: `sync-req.pendingOps` refuses a framework-internal action exactly like `op` does",
  ignore: Deno.build.os === "windows",
  async fn() {
    const { db, close } = createTestDb();
    const dispatched: string[] = [];
    let state: Record<string, unknown> = { items: [], fetched: "" };
    const handler = createServerSyncHandler({
      dispatch: (a) => {
        dispatched.push(a.type);
        if (a.type === "notes:add") {
          state = {
            ...state,
            items: [...(state.items as string[]), a.payload as string],
          };
        }
      },
      db,
      syncCellIds: ["notes"],
      getCellState: () => state,
      getClientCellState: () => state,
      broadcastRaw: { fn: () => {} },
      log: { debug: () => {}, warn: () => {}, error: () => {} },
    });
    const socketPath = join(
      await tempDir("aio-internal-gate-uds-"),
      "gate.sock",
    );
    const uds = createUDSListener(
      socketPath,
      () => ({ notes: state }),
      (a) => {
        dispatched.push(`network:${(a as { type: string }).type}`);
      },
      () => {},
      undefined,
      handler,
    );
    await sleep(50);
    const conn = await Deno.connect({ path: socketPath, transport: "unix" });
    const writer = conn.writable.getWriter();
    const send = (t: Kind, d: unknown) =>
      writer.write(new TextEncoder().encode(enc(t, d) + "\n"));
    try {
      await send("op", evilOp("evil-op-1", "pwned-by-op"));
      await sleep(150);
      await send("sync-req", {
        clientId: "evil",
        reqId: 1,
        cells: { notes: { lastHlc: null } },
        pendingOps: [evilOp("evil-sync-1", "pwned-by-sync-req")],
      });
      await sleep(300);
      assertEquals(
        dispatched.filter((t) => t.includes("__")),
        [],
        "no framework-internal action reached dispatch over UDS",
      );
      assertEquals(state.fetched, "");
      const { rows } = await db.query<{ n: number }>(
        "SELECT COUNT(*) AS n FROM sync_ops",
      );
      assertEquals(rows[0]?.n, 0, "nothing was persisted to the op-log");
      // The legitimate op through the same door still applies.
      await send("sync-req", {
        clientId: "evil",
        reqId: 2,
        cells: { notes: { lastHlc: null } },
        pendingOps: [{ ...evilOp("ok-1", ""), action: "add", payload: "hi" }],
      });
      await sleep(300);
      assertEquals(state.items, ["hi"]);
    } finally {
      writer.releaseLock();
      try {
        conn.close();
      } catch { /* closed by the server */ }
      uds.shutdown();
      await sleep(50);
      close();
    }
  },
});
