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
      cells: { todos: normalizeSyncConfig(true) },
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
    const msg = sent[0] as { __op: { cell: string; action: string } };
    assertEquals(msg.__op.cell, "todos");
    assertEquals(msg.__op.action, "add");
  });

  it("queues ops when offline", async () => {
    const sent: unknown[] = [];
    const storage = createMemoryStorage();
    const engine = createSyncEngine({
      clientId: "c1",
      cells: { todos: normalizeSyncConfig(true) },
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
      cells: { todos: normalizeSyncConfig(true) },
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
        cells: Record<string, unknown>;
        pendingOps: unknown[];
      };
    };
    assertEquals(msg.__sync.clientId, "c1");
    assertEquals("todos" in msg.__sync.cells, true);
    assertEquals(msg.__sync.pendingOps.length, 1);
  });

  it("handleSyncResponse with snapshot updates confirmed state", async () => {
    let confirmedState: Record<string, unknown> = { items: [] };
    const engine = createSyncEngine({
      clientId: "c1",
      cells: { todos: normalizeSyncConfig(true) },
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
      cells: { todos: normalizeSyncConfig(true) },
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
      cell: "todos",
      action: "add",
      payload: { text: "from-peer" },
      hlc: [2000, 0, "c2"],
      confirmed: true,
    });

    assertEquals(confirmedState, { items: [{ text: "from-peer" }] });
    assertEquals(optimisticState, { items: [{ text: "from-peer" }] });
  });
});

describe("SyncEngine onConflict", () => {
  it("fires when a remote op changes a field local unconfirmed ops override", async () => {
    let confirmedState: Record<string, unknown> = { title: "base", n: 0 };
    const conflicts: unknown[] = [];
    const engine = createSyncEngine({
      clientId: "c1",
      cells: {
        doc: {
          ...normalizeSyncConfig(true),
          onConflict: (c) => conflicts.push(...c),
        },
      },
      buffer: createOpBuffer(createMemoryStorage()),
      send: () => {},
      reducer: (state, action, payload) => {
        if (action === "set") return { ...state, ...(payload as object) };
        return state;
      },
      getConfirmedState: () => ({ doc: confirmedState }),
      setConfirmedState: (_cell, s) => {
        confirmedState = s;
      },
      onStateUpdate: () => {},
    });

    // Local unconfirmed edit: title = "mine"
    await engine.handleLocalAction("doc", "set", { title: "mine" });
    // Concurrent remote edit lands: title = "theirs"
    await engine.handleRemoteOp({
      id: "r1",
      cell: "doc",
      action: "set",
      payload: { title: "theirs" },
      hlc: [Date.now(), 0, "c2"],
      confirmed: true,
    });

    assertEquals(conflicts.length, 1);
    const c = conflicts[0] as {
      field: string;
      local: unknown;
      remote: unknown;
      resolution: string;
    };
    assertEquals(c.field, "title");
    assertEquals(c.local, "mine"); // rebase-LWW: local replays on top
    assertEquals(c.remote, "theirs"); // confirmed value underneath
    assertEquals(c.resolution, "lww");
  });

  it("does NOT fire for non-overlapping edits", async () => {
    let confirmedState: Record<string, unknown> = { title: "base", n: 0 };
    const conflicts: unknown[] = [];
    const engine = createSyncEngine({
      clientId: "c1",
      cells: {
        doc: {
          ...normalizeSyncConfig(true),
          onConflict: (c) => conflicts.push(...c),
        },
      },
      buffer: createOpBuffer(createMemoryStorage()),
      send: () => {},
      reducer: (state, action, payload) => {
        if (action === "set") return { ...state, ...(payload as object) };
        return state;
      },
      getConfirmedState: () => ({ doc: confirmedState }),
      setConfirmedState: (_cell, s) => {
        confirmedState = s;
      },
      onStateUpdate: () => {},
    });

    await engine.handleLocalAction("doc", "set", { n: 5 }); // local touches n
    await engine.handleRemoteOp({
      id: "r2",
      cell: "doc",
      action: "set",
      payload: { title: "theirs" }, // remote touches title — no overlap
      hlc: [Date.now(), 0, "c2"],
      confirmed: true,
    });

    assertEquals(conflicts.length, 0);
  });
});

describe("SyncEngine per-field merge strategies", () => {
  function mergeSetup(merge: Record<string, string>) {
    let confirmedState: Record<string, unknown> = { n: 0, items: [] };
    const conflicts: { field: string; resolution: string }[] = [];
    const views: Record<string, unknown>[] = [];
    const engine = createSyncEngine({
      clientId: "c1",
      cells: {
        doc: {
          ...normalizeSyncConfig(true),
          merge: merge as Record<string, "lww" | "counter" | "set-add">,
          onConflict: (c) => conflicts.push(...c),
        },
      },
      buffer: createOpBuffer(createMemoryStorage()),
      send: () => {},
      reducer: (state, action, payload) => {
        if (action === "set") return { ...state, ...(payload as object) };
        return state;
      },
      getConfirmedState: () => ({ doc: confirmedState }),
      setConfirmedState: (_cell, s) => {
        confirmedState = s;
      },
      onStateUpdate: (_cell, s) => views.push(s),
    });
    return { engine, conflicts, views };
  }

  it("counter: client view merges both deltas during the conflict window", async () => {
    const { engine, conflicts, views } = mergeSetup({ n: "counter" });
    await engine.handleLocalAction("doc", "set", { n: 5 }); // local: 0 → 5
    await engine.handleRemoteOp({
      id: "r1",
      cell: "doc",
      action: "set",
      payload: { n: 3 }, // remote: 0 → 3, concurrently
      hlc: [Date.now(), 0, "c2"],
      confirmed: true,
    });
    // base 0, local delta +5, remote delta +3 → merged client view 8
    const last = views[views.length - 1]!;
    assertEquals(last.n, 8);
    assertEquals(conflicts.length, 1);
    assertEquals(conflicts[0]!.field, "n");
    assertEquals(conflicts[0]!.resolution, "counter");
  });

  it("set-add: client view is the union of concurrent adds", async () => {
    const { engine, conflicts, views } = mergeSetup({ items: "set-add" });
    await engine.handleLocalAction("doc", "set", { items: [{ id: "a" }] });
    await engine.handleRemoteOp({
      id: "r2",
      cell: "doc",
      action: "set",
      payload: { items: [{ id: "b" }] },
      hlc: [Date.now(), 0, "c2"],
      confirmed: true,
    });
    const last = views[views.length - 1]!;
    const ids = (last.items as { id: string }[]).map((i) => i.id).sort();
    assertEquals(ids, ["a", "b"]);
    assertEquals(conflicts[0]!.resolution, "set-add");
  });

  it("unconfigured fields keep rebase-LWW view and report resolution lww", async () => {
    const { engine, conflicts, views } = mergeSetup({});
    await engine.handleLocalAction("doc", "set", { n: 5 });
    await engine.handleRemoteOp({
      id: "r3",
      cell: "doc",
      action: "set",
      payload: { n: 3 },
      hlc: [Date.now(), 0, "c2"],
      confirmed: true,
    });
    const last = views[views.length - 1]!;
    assertEquals(last.n, 5); // local replays on top — unchanged semantics
    assertEquals(conflicts[0]!.resolution, "lww");
  });

  it("merge applies even without an onConflict callback", async () => {
    let confirmedState: Record<string, unknown> = { n: 0 };
    const views: Record<string, unknown>[] = [];
    const engine = createSyncEngine({
      clientId: "c1",
      cells: {
        doc: { ...normalizeSyncConfig(true), merge: { n: "counter" } },
      },
      buffer: createOpBuffer(createMemoryStorage()),
      send: () => {},
      reducer: (state, action, payload) => {
        if (action === "set") return { ...state, ...(payload as object) };
        return state;
      },
      getConfirmedState: () => ({ doc: confirmedState }),
      setConfirmedState: (_cell, s) => {
        confirmedState = s;
      },
      onStateUpdate: (_cell, s) => views.push(s),
    });
    await engine.handleLocalAction("doc", "set", { n: 5 });
    await engine.handleRemoteOp({
      id: "r4",
      cell: "doc",
      action: "set",
      payload: { n: 3 },
      hlc: [Date.now(), 0, "c2"],
      confirmed: true,
    });
    assertEquals(views[views.length - 1]!.n, 8);
  });
});
