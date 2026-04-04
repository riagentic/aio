import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  createSyncEngine,
  type SyncEngineDeps,
} from "../../src/sync/sync-engine.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";
import { createOpBuffer } from "../../src/sync/op-buffer.ts";
import { createMemoryStorage } from "./_memory-storage.ts";

describe("SyncEngine", () => {
  function setup() {
    const sent: unknown[] = [];
    const buffer = createOpBuffer(createMemoryStorage());

    const deps: SyncEngineDeps = {
      clientId: "c1",
      features: { todos: normalizeSyncConfig(true) },
      buffer,
      send: (msg: string) => sent.push(JSON.parse(msg)),
      reducer: (
        state: Record<string, unknown>,
        action: string,
        payload: unknown,
      ) => {
        if (action === "add") {
          return {
            ...state,
            items: [...((state.items as unknown[]) || []), payload],
          };
        }
        return state;
      },
      getConfirmedState: () => ({ todos: { items: [] } }),
      setConfirmedState: () => {},
      onStateUpdate: () => {},
    };

    const engine = createSyncEngine(deps);
    return { engine, sent };
  }

  it("stamps and sends ops", async () => {
    const { engine, sent } = setup();
    await engine.handleLocalAction("todos", "add", { text: "hello" });
    assertEquals(sent.length, 1);
    const msg = sent[0] as { __op: { feature: string; action: string } };
    assertEquals(msg.__op.feature, "todos");
    assertEquals(msg.__op.action, "add");
  });

  it("queues ops when offline", async () => {
    const sent: unknown[] = [];
    const storage = createMemoryStorage();
    const engine = createSyncEngine({
      clientId: "c1",
      features: { todos: normalizeSyncConfig(true) },
      buffer: createOpBuffer(storage),
      send: (msg: string) => sent.push(msg),
      reducer: (s) => s,
      getConfirmedState: () => ({ todos: {} }),
      setConfirmedState: () => {},
      onStateUpdate: () => {},
    });

    engine.setOnline(false);
    await engine.handleLocalAction("todos", "add", { text: "offline" });
    assertEquals(sent.length, 0);
    const ops = await storage.loadOps("todos");
    assertEquals(ops.length, 1);
  });

  it("handles ack — confirms op", async () => {
    const { engine, sent } = setup();
    await engine.handleLocalAction("todos", "add", { text: "test" });
    assertEquals(engine.getStatus("todos").pending, 1);

    const msg = sent[0] as { __op: { id: string } };
    await engine.handleAck("todos", msg.__op.id, [2000, 0, "s"]);
    assertEquals(engine.getStatus("todos").pending, 0);
  });

  it("reports blocked when cap exceeded", async () => {
    const engine = createSyncEngine({
      clientId: "c1",
      features: { todos: normalizeSyncConfig(true) },
      buffer: createOpBuffer(createMemoryStorage(), { pendingCap: 2 }),
      send: () => {},
      reducer: (s: Record<string, unknown>) => s,
      getConfirmedState: () => ({ todos: {} }),
      setConfirmedState: () => {},
      onStateUpdate: () => {},
    });

    await engine.handleLocalAction("todos", "add", { text: "1" });
    await engine.handleLocalAction("todos", "add", { text: "2" });
    await engine.handleLocalAction("todos", "add", { text: "3" });
    assertEquals(engine.getStatus("todos").status, "blocked");
  });

  it("returns correct status transitions", () => {
    const { engine } = setup();
    assertEquals(engine.getStatus("todos").status, "online");
    engine.setOnline(false);
    assertEquals(engine.getStatus("todos").status, "offline");
  });

  it("requestSync sends __sync with lastHlc and pending ops", async () => {
    const { engine, sent } = setup();
    await engine.handleLocalAction("todos", "add", { text: "pending" });
    sent.length = 0; // clear the __op message

    await engine.requestSync();
    assertEquals(sent.length, 1);
    const msg = sent[0] as {
      __sync: {
        clientId: string;
        features: Record<string, unknown>;
        pendingOps: unknown[];
      };
    };
    assertEquals(msg.__sync.clientId, "c1");
    assertEquals("todos" in msg.__sync.features, true);
    assertEquals(msg.__sync.pendingOps.length, 1);
  });

  it("handleSyncResponse with snapshot updates confirmed state", async () => {
    let confirmedState: Record<string, unknown> = { items: [] };
    const engine = createSyncEngine({
      clientId: "c1",
      features: { todos: normalizeSyncConfig(true) },
      buffer: createOpBuffer(createMemoryStorage()),
      send: () => {},
      reducer: (s) => s,
      getConfirmedState: () => ({ todos: confirmedState }),
      setConfirmedState: (_f, s) => {
        confirmedState = s;
      },
      onStateUpdate: () => {},
    });

    await engine.handleSyncResponse({
      mode: "snapshot",
      snapshot: { todos: { items: ["from-server"] } },
      ops: [],
      lowWater: [5000, 0, "s"],
    });
    assertEquals(engine.getStatus("todos").status, "online");
    assertEquals(engine.getStatus("todos").lastSync > 0, true);
    assertEquals(confirmedState, { items: ["from-server"] });
  });

  it("handleRemoteOp applies op to confirmed state and rebases", async () => {
    let confirmedState: Record<string, unknown> = { items: [] };
    let optimisticState: Record<string, unknown> = {};
    const engine = createSyncEngine({
      clientId: "c1",
      features: { todos: normalizeSyncConfig(true) },
      buffer: createOpBuffer(createMemoryStorage()),
      send: () => {},
      reducer: (state, action, payload) => {
        if (action === "add") {
          return {
            ...state,
            items: [...((state.items as unknown[]) || []), payload],
          };
        }
        return state;
      },
      getConfirmedState: () => ({ todos: confirmedState }),
      setConfirmedState: (_f, s) => {
        confirmedState = s;
      },
      onStateUpdate: (_f, s) => {
        optimisticState = s;
      },
    });

    await engine.handleRemoteOp({
      id: "remote-1",
      feature: "todos",
      action: "add",
      payload: { text: "from-peer" },
      hlc: [2000, 0, "c2"],
      confirmed: true,
    });

    assertEquals(confirmedState, { items: [{ text: "from-peer" }] });
    assertEquals(optimisticState, { items: [{ text: "from-peer" }] });
  });
});
