// One refused op is ONE refusal report — however many times the server says it.
//
// The server's refusal STICKS to the op id (`refuseIfRefusedBefore`,
// tests/sync/refusal-sticks.test.ts): an op it already refused is refused
// again, with the same reason, however it comes back — a duplicated frame, a
// reconnect flush that re-sent the queue before the first refusal landed, a
// twin tab flushing the shared queue. That is right on the server, and it means
// the CLIENT can be told the same refusal several times.
//
// It handled each one from scratch: `onRejected` fired again, the error log
// printed again, and the optimistic view was rebased again — for an op it had
// already dropped and already reported. An app counting rejections ("3 changes
// were refused") counted one change three times, and a toast-per-rejection
// showed three toasts for one edit. Exactly the shape
// `cap-drop-reported-once.test.ts` pins for the drop channel, applied to the
// rejection channel.
import { assertEquals } from "@std/assert";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import { normalizeSyncConfig, STALE_OP_REASON } from "../../src/sync/types.ts";
import {
  createMemoryStorage,
  createOpBuffer,
} from "../../src/sync/op-buffer.ts";

interface Rig {
  engine: ReturnType<typeof createSyncEngine>;
  rejected: string[];
  drops: string[];
  /** Op ids the buffer currently holds, in the order they were made. */
  pending: () => Promise<string[]>;
}

function rig(): Rig {
  const rejected: string[] = [];
  const drops: string[] = [];
  const storage = createMemoryStorage();
  const buffer = createOpBuffer(storage, {
    onDrop: (op, reason) => drops.push(`${op.id}:${reason}`),
  });
  const engine = createSyncEngine({
    clientId: "c1",
    cells: {
      todos: normalizeSyncConfig({
        onRejected: ({ opId, reason }) => rejected.push(`${opId}:${reason}`),
      }),
    },
    buffer,
    send: () => {},
    reducer: (s: Record<string, unknown>) => s,
    getConfirmedState: () => ({ todos: {} }),
    setConfirmedState: () => {},
    onStateUpdate: () => {},
  });
  return {
    engine,
    rejected,
    drops,
    pending: async () =>
      (await storage.loadOps("todos")).filter((o) => !o.confirmed).map((o) =>
        o.id
      ),
  };
}

Deno.test("sync refusal: a repeated refusal for one op is reported once", async () => {
  const { engine, rejected, pending } = rig();
  try {
    engine.setOnline(false);
    await engine.handleLocalAction("todos", "add", { text: "1" });
    const [id] = await pending();
    assertEquals(typeof id, "string", "the op is queued");

    await engine.handleRejection("todos", id!, "dispatch failed: nope");
    await engine.handleRejection("todos", id!, "dispatch failed: nope");
    await engine.handleRejection("todos", id!, "dispatch failed: nope");

    assertEquals(
      rejected,
      [`${id}:dispatch failed: nope`],
      `one refused op is one onRejected call, got ${rejected.length}`,
    );
  } finally {
    engine.dispose();
  }
});

Deno.test("sync refusal: a repeated STALE refusal drops the op once", async () => {
  const { engine, rejected, drops, pending } = rig();
  try {
    engine.setOnline(false);
    await engine.handleLocalAction("todos", "add", { text: "1" });
    const [id] = await pending();
    const reason = `${STALE_OP_REASON}: 5h old, past the 4h window`;
    await engine.handleRejection("todos", id!, reason);
    await engine.handleRejection("todos", id!, reason);
    assertEquals(rejected.length, 1, "one onRejected");
    assertEquals(drops, [`${id}:stale-beyond-retention`], "one onDrop");
  } finally {
    engine.dispose();
  }
});

Deno.test("sync refusal: a refusal whose prune FAILED is not counted as handled", async () => {
  // Dedup marks work that happened. If the prune throws — a localStorage
  // quota or permission error — the op is still queued, still re-sent on
  // every reconnect, and still re-refused; swallowing those repeats would
  // make a storage failure permanent AND silent.
  const rejected: string[] = [];
  const storage = createMemoryStorage();
  let failNextPrune = true;
  const buffer = createOpBuffer(storage);
  const flaky = {
    ...buffer,
    pruneStale(cell: string, opId: string): Promise<void> {
      if (failNextPrune) {
        failNextPrune = false;
        return Promise.reject(new Error("localStorage: quota exceeded"));
      }
      return buffer.pruneStale(cell, opId);
    },
  };
  const engine = createSyncEngine({
    clientId: "c1",
    cells: {
      todos: normalizeSyncConfig({
        onRejected: ({ opId }) => rejected.push(opId),
      }),
    },
    buffer: flaky,
    send: () => {},
    reducer: (s: Record<string, unknown>) => s,
    getConfirmedState: () => ({ todos: {} }),
    setConfirmedState: () => {},
    onStateUpdate: () => {},
  });
  try {
    engine.setOnline(false);
    await engine.handleLocalAction("todos", "add", { text: "1" });
    const [id] = (await storage.loadOps("todos")).map((o) => o.id);
    await engine.handleRejection("todos", id!, "nope").then(
      () => {
        throw new Error("the prune failure must reach the caller");
      },
      () => {},
    );
    assertEquals(rejected, [], "nothing was reported — nothing was done");
    // The server re-refuses it, and this time the prune works.
    await engine.handleRejection("todos", id!, "nope");
    assertEquals(rejected, [id], "the retry reports it, once");
    assertEquals(await storage.loadOps("todos"), [], "…and drops it");
  } finally {
    engine.dispose();
  }
});

Deno.test("sync refusal: two different ops are still two reports", async () => {
  const { engine, rejected, pending } = rig();
  try {
    engine.setOnline(false);
    await engine.handleLocalAction("todos", "add", { text: "1" });
    await engine.handleLocalAction("todos", "add", { text: "2" });
    const ids = await pending();
    assertEquals(ids.length, 2);
    for (const id of ids) await engine.handleRejection("todos", id, "nope");
    for (const id of ids) await engine.handleRejection("todos", id, "nope");
    assertEquals(rejected.length, 2, "two ops, two reports");
    assertEquals(new Set(rejected).size, 2);
  } finally {
    engine.dispose();
  }
});
