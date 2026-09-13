// tests/sync/storage-memory-mirror.test.ts — a browser with no usable
// localStorage must still see its own sync writes.
//
// The localStorage op storage re-read the document from localStorage on every
// call. When a write was refused (private window, storage blocked, quota full)
// the op existed nowhere: the engine's pending list came back without it, so
// the optimistic view never showed it and the ack found no pending op to fold
// into confirmed state. The tab never saw its own write, and an offline write
// was simply gone while its call resolved.
import { assert, assertEquals } from "@std/assert";
import { createLocalStorageOpStorage } from "../../src/sync/browser-storage.ts";
import { createOpBuffer } from "../../src/sync/op-buffer.ts";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";
import type { HLC, SyncOp } from "../../src/sync/types.ts";

function shim(mode: "refuse-writes" | "no-storage"): void {
  const store = new Map<string, string>();
  const refuse = () => {
    throw new DOMException("quota exceeded", "QuotaExceededError");
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) =>
        mode === "no-storage" ? refuse() : store.get(k) ?? null,
      setItem: () => refuse(),
      removeItem: (k: string) =>
        mode === "no-storage" ? refuse() : void store.delete(k),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return mode === "no-storage" ? refuse() : store.size;
      },
    },
  });
}

const op = (id: string): SyncOp => ({
  id,
  cell: "board",
  action: "add",
  payload: id,
  hlc: [Date.now(), 0, "c1"],
  confirmed: false,
  _clientTs: Date.now(),
});

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const e = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = e;
  }
}

for (const mode of ["refuse-writes", "no-storage"] as const) {
  Deno.test(`browser-storage (${mode}): a queued op is still readable this page load`, async () => {
    shim(mode);
    await quietly(async () => {
      const s = createLocalStorageOpStorage();
      await s.saveOp(op("a"));
      await s.saveOp(op("b"));
      assertEquals((await s.loadOps("board")).map((o) => o.id), ["a", "b"]);
      await s.confirmOp("board", "a");
      assertEquals(await s.countUnconfirmed("board"), 1);
      await s.pruneConfirmed("board");
      assertEquals((await s.loadOps("board")).map((o) => o.id), ["b"]);
      await s.saveMeta("board", { lastHlc: null, lastServerTs: 7 });
      assertEquals((await s.loadMeta("board"))?.lastServerTs, 7);
    });
  });

  Deno.test(`browser-storage (${mode}): the tab sees its own sync write, and its ack confirms it`, async () => {
    shim(mode);
    await quietly(async () => {
      let confirmed: Record<string, unknown> = { items: [] };
      let view: Record<string, unknown> = confirmed;
      const sent: { t: string; d: { id: string } }[] = [];
      const engine = createSyncEngine({
        clientId: "c1",
        cells: { board: normalizeSyncConfig(true) },
        buffer: createOpBuffer(createLocalStorageOpStorage()),
        send: (m) => sent.push(JSON.parse(m)),
        reducer: (s, _a, p) => ({
          items: [...(s.items as string[]), p as string],
        }),
        getConfirmedState: () => ({ board: confirmed }),
        setConfirmedState: (_c, s) => {
          confirmed = s;
        },
        onStateUpdate: (_c, s) => {
          view = s;
        },
      });
      try {
        await engine.handleLocalAction("board", "add", "mine");
        assertEquals(view.items, ["mine"], "the optimistic view shows it");
        const frame = sent.find((f) => f.t === "op");
        assert(frame, "the op went out");
        await engine.handleAck(
          "board",
          frame.d.id,
          [Date.now(), 0, "server"] as HLC,
        );
        assertEquals(confirmed.items, ["mine"], "the ack folds it");
        assertEquals(view.items, ["mine"], "and the view keeps it");
      } finally {
        engine.dispose();
      }
    });
  });
}
