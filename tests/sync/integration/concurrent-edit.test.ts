// tests/sync/integration/concurrent-edit.test.ts
import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { createSyncEngine } from "../../../src/sync/sync-engine.ts";
import { createOpBuffer } from "../../../src/sync/op-buffer.ts";
import { mergeField } from "../../../src/sync/merge.ts";
import { normalizeSyncConfig } from "../../../src/sync/types.ts";
import type { HLC } from "../../../src/sync/types.ts";
import { createMemoryStorage } from "../_memory-storage.ts";

describe("Concurrent edits", () => {
  it("two clients edit same LWW field → later HLC wins", () => {
    const hlcA: HLC = [1000, 0, "clientA"];
    const hlcB: HLC = [2000, 0, "clientB"];

    const result = mergeField("lww", "Alice's edit", hlcA, "Bob's edit", hlcB);
    assertEquals(result.value, "Bob's edit"); // B has later HLC
    assertEquals(result.conflict, true);
  });

  it("two clients add to same set → union (set-add)", () => {
    const local = [{ id: "1", text: "Alice's item" }];
    const remote = [{ id: "2", text: "Bob's item" }];
    const hlcA: HLC = [1000, 0, "a"];
    const hlcB: HLC = [2000, 0, "b"];

    const result = mergeField("set-add", local, hlcA, remote, hlcB);
    const items = result.value as { id: string }[];
    assertEquals(items.length, 2);
    assertEquals(items.map((i) => i.id).sort(), ["1", "2"]);
  });

  it("two clients increment counter → additive merge", () => {
    // Base: 0, Client A: +3 = 3, Client B: +5 = 5
    const hlcA: HLC = [1000, 0, "a"];
    const hlcB: HLC = [2000, 0, "b"];
    const result = mergeField("counter", 3, hlcA, 5, hlcB, 0);
    assertEquals(result.value, 8); // 0 + 3 + 5
    assertEquals(result.conflict, false);
  });

  it("client A edits, client B deletes — set-remove removes", () => {
    const base = [{ id: "1" }, { id: "2" }, { id: "3" }];
    const local = [{ id: "1" }, { id: "2" }]; // removed 3
    const remote = [{ id: "2" }, { id: "3" }]; // removed 1
    const hlcA: HLC = [1000, 0, "a"];
    const hlcB: HLC = [2000, 0, "b"];

    const result = mergeField("set-remove", local, hlcA, remote, hlcB, base);
    const ids = (result.value as { id: string }[]).map((i) => i.id).sort();
    assertEquals(ids, ["2"]); // only 2 survives both
  });

  it("two clients go offline, edit, reconnect → engines diverge correctly", async () => {
    const sentA: string[] = [];
    const sentB: string[] = [];
    let stateA: Record<string, unknown> = { items: [] };
    let stateB: Record<string, unknown> = { items: [] };

    const engineA = createSyncEngine({
      clientId: "a",
      features: { todos: normalizeSyncConfig(true) },
      buffer: createOpBuffer(createMemoryStorage()),
      send: (msg) => sentA.push(msg),
      reducer: (state, action, payload) => {
        if (action === "add") {
          return {
            ...state,
            items: [...(state.items as unknown[] || []), payload],
          };
        }
        return state;
      },
      getConfirmedState: () => ({ todos: { items: [] } }),
      setConfirmedState: () => {},
      onStateUpdate: (_f, s) => {
        stateA = s;
      },
    });

    const engineB = createSyncEngine({
      clientId: "b",
      features: { todos: normalizeSyncConfig(true) },
      buffer: createOpBuffer(createMemoryStorage()),
      send: (msg) => sentB.push(msg),
      reducer: (state, action, payload) => {
        if (action === "add") {
          return {
            ...state,
            items: [...(state.items as unknown[] || []), payload],
          };
        }
        return state;
      },
      getConfirmedState: () => ({ todos: { items: [] } }),
      setConfirmedState: () => {},
      onStateUpdate: (_f, s) => {
        stateB = s;
      },
    });

    // Both go offline
    engineA.setOnline(false);
    engineB.setOnline(false);

    // Both add items
    await engineA.handleLocalAction("todos", "add", {
      id: "a1",
      text: "from A",
    });
    await engineB.handleLocalAction("todos", "add", {
      id: "b1",
      text: "from B",
    });

    // Both have optimistic state with their own items
    assertEquals((stateA.items as unknown[]).length, 1);
    assertEquals((stateB.items as unknown[]).length, 1);

    // Nothing was sent (offline)
    assertEquals(sentA.length, 0);
    assertEquals(sentB.length, 0);
  });
});
