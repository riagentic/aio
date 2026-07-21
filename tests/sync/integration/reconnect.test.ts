// tests/sync/integration/reconnect.test.ts
import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { createSyncEngine } from "../../../src/sync/sync-engine.ts";
import { createOpBuffer } from "../../../src/sync/op-buffer.ts";
import { normalizeSyncConfig } from "../../../src/sync/types.ts";
import { createMemoryStorage } from "../_memory-storage.ts";

describe("Reconnection", () => {
  function setup() {
    const sent: unknown[] = [];
    let confirmedState: Record<string, unknown> = { count: 0 };

    const engine = createSyncEngine({
      clientId: "c1",
      cells: { counter: normalizeSyncConfig(true) },
      buffer: createOpBuffer(createMemoryStorage()),
      send: (msg) => sent.push(JSON.parse(msg)),
      reducer: (state, action) => {
        if (action === "increment") {
          return { ...state, count: (state.count as number) + 1 };
        }
        return state;
      },
      getConfirmedState: () => ({ counter: confirmedState }),
      setConfirmedState: (_f, s) => {
        confirmedState = s;
      },
      onStateUpdate: () => {},
    });

    return {
      engine,
      sent,
      setConfirmed: (s: Record<string, unknown>) => {
        confirmedState = s;
      },
    };
  }

  it("sends sync-req on reconnect", async () => {
    const { engine, sent } = setup();
    engine.setOnline(false);
    await engine.handleLocalAction("counter", "increment", {});
    engine.setOnline(true);

    await engine.requestSync();
    const syncMsg = sent.find((m: any) => m.t === "sync-req") as any;
    assertEquals(!!syncMsg, true);
    assertEquals(syncMsg.d.clientId, "c1");
    assertEquals("counter" in syncMsg.d.cells, true);
  });

  it("handles incremental sync response", async () => {
    const { engine } = setup();
    engine.setOnline(false);
    await engine.handleLocalAction("counter", "increment", {});
    engine.setOnline(true);

    await engine.handleSyncResponse({
      mode: "incremental",
      ops: [], // no missed ops
      lowWater: [500, 0, "s"],
    });

    assertEquals(engine.getStatus("counter").status, "online");
  });

  it("handles snapshot fallback", async () => {
    const { engine, setConfirmed } = setup();
    setConfirmed({ count: 100 }); // server has diverged

    await engine.handleSyncResponse({
      mode: "snapshot",
      snapshot: { counter: { count: 100 } },
      ops: [],
      lowWater: [5000, 0, "s"],
    });

    assertEquals(engine.getStatus("counter").status, "online");
    assertEquals(engine.getStatus("counter").lastSync > 0, true);
  });

  it(">cap pending triggers blocked status", async () => {
    const engine = createSyncEngine({
      clientId: "c1",
      cells: { counter: normalizeSyncConfig(true) },
      buffer: createOpBuffer(createMemoryStorage(), { pendingCap: 2 }),
      send: () => {},
      reducer: (s) => ({ ...s, count: ((s.count as number) || 0) + 1 }),
      getConfirmedState: () => ({ counter: { count: 0 } }),
      setConfirmedState: () => {},
      onStateUpdate: () => {},
    });

    engine.setOnline(false);
    await engine.handleLocalAction("counter", "increment", {});
    await engine.handleLocalAction("counter", "increment", {});
    await engine.handleLocalAction("counter", "increment", {}); // exceeds cap=2

    assertEquals(engine.getStatus("counter").status, "blocked");
  });
});
