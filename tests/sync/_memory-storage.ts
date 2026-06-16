// tests/sync/_memory-storage.ts — Shared in-memory OpBufferStorage for tests
import type { OpBufferStorage } from "../../src/sync/op-buffer.ts";
import type { HLC, SyncOp } from "../../src/sync/types.ts";

/** In-memory storage adapter — replaces IndexedDB in tests */
export function createMemoryStorage(): OpBufferStorage {
  const ops: SyncOp[] = [];
  const meta: Record<string, { lastHlc: HLC | null }> = {};
  const snapshots: Record<string, { state: unknown; hlc: HLC }> = {};

  return {
    async loadOps(cell: string) {
      return ops.filter((o) => o.cell === cell);
    },
    async saveOp(op: SyncOp) {
      ops.push(op);
    },
    async confirmOp(opId: string) {
      const op = ops.find((o) => o.id === opId);
      if (op) op.confirmed = true;
    },
    async pruneConfirmed(cell: string) {
      for (let i = ops.length - 1; i >= 0; i--) {
        if (ops[i]!.cell === cell && ops[i]!.confirmed) ops.splice(i, 1);
      }
    },
    async pruneStale(_cell: string, opId: string) {
      const idx = ops.findIndex((o) => o.id === opId);
      if (idx !== -1) ops.splice(idx, 1);
    },
    async countUnconfirmed(cell: string) {
      return ops.filter((o) => o.cell === cell && !o.confirmed).length;
    },
    async loadMeta(cell: string) {
      return meta[cell];
    },
    async saveMeta(cell: string, data: { lastHlc: HLC | null }) {
      meta[cell] = data;
    },
    async loadSnapshot(cell: string) {
      return snapshots[cell];
    },
    async saveSnapshot(
      cell: string,
      data: { state: unknown; hlc: HLC },
    ) {
      snapshots[cell] = data;
    },
    async clear(cell: string) {
      for (let i = ops.length - 1; i >= 0; i--) {
        if (ops[i]!.cell === cell) ops.splice(i, 1);
      }
      delete meta[cell];
      delete snapshots[cell];
    },
  };
}
