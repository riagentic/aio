// One op refused at the pending cap is ONE drop — reported once.
//
// `handleLocalAction` called `buffer.add(op)`, and on a refusal pruned the
// confirmed ops and called `add` AGAIN. But `createOpBuffer().add` already
// prunes confirmed ops (and evicts stale ones) before it refuses, and it fires
// `onDrop(op, "prune-failed")` on the way out — so the retry could not find
// room the first call had not, and every refused op was reported twice: two
// console errors and two `sync-op-dropped` events in a browser (browser-sync.ts
// wires `onDrop` to both) for one lost change. Measured by the r3 chaos hunt:
// 520 offline acts against the 500 cap → "DROP lines 40, unique ops 20".
// A handler counting drops (a "N changes were lost" banner) said 40.
import { assertEquals, assertRejects } from "@std/assert";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";
import { createOpBuffer } from "../../src/sync/op-buffer.ts";
import { createMemoryStorage } from "./_memory-storage.ts";

Deno.test("sync cap: a refused op fires onDrop exactly once", async () => {
  const drops: string[] = [];
  const engine = createSyncEngine({
    clientId: "c1",
    cells: { todos: normalizeSyncConfig(true) },
    buffer: createOpBuffer(createMemoryStorage(), {
      pendingCap: 2,
      onDrop: (op, reason) => drops.push(`${op.id}:${reason}`),
    }),
    send: () => {},
    reducer: (s: Record<string, unknown>) => s,
    getConfirmedState: () => ({ todos: {} }),
    setConfirmedState: () => {},
    onStateUpdate: () => {},
  });
  engine.setOnline(false);
  await engine.handleLocalAction("todos", "add", { text: "1" });
  await engine.handleLocalAction("todos", "add", { text: "2" });
  for (let i = 3; i <= 5; i++) {
    await assertRejects(
      () => engine.handleLocalAction("todos", "add", { text: String(i) }),
      Error,
      "DROPPED",
    );
  }
  assertEquals(
    drops.length,
    3,
    `three refused ops must be three drop reports, got ${drops.length}: ${
      drops.join(", ")
    }`,
  );
  assertEquals(new Set(drops).size, 3, "…one per op, none repeated");
  assertEquals(
    drops.every((d) => d.endsWith(":prune-failed")),
    true,
    "…each naming the reason",
  );
  // The cap still means what it says: the two accepted ops are pending.
  assertEquals(engine.getStatus("todos").pending, 2);
});
