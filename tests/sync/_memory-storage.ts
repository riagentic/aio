// tests/sync/_memory-storage.ts — Shared in-memory OpBufferStorage for tests
import type { OpBufferStorage } from "../../src/sync/op-buffer.ts";
import type { HLC, SyncOp } from "../../src/sync/types.ts";

/** In-memory storage adapter — replaces IndexedDB in tests */
export function createMemoryStorage(): OpBufferStorage {
  const ops: SyncOp[] = [];
  const meta: Record<string, { lastHlc: HLC | null }> = {};
  const snapshots: Record<string, { state: unknown; hlc: HLC }> = {};

  return {
    async loadOps(feature: string) {
      return ops.filter((o) => o.feature === feature);
    },
    async saveOp(op: SyncOp) {
      ops.push(op);
    },
    async confirmOp(opId: string) {
      const op = ops.find((o) => o.id === opId);
      if (op) op.confirmed = true;
    },
    async pruneConfirmed(feature: string) {
      for (let i = ops.length - 1; i >= 0; i--) {
        if (ops[i]!.feature === feature && ops[i]!.confirmed) ops.splice(i, 1);
      }
    },
    async countUnconfirmed(feature: string) {
      return ops.filter((o) => o.feature === feature && !o.confirmed).length;
    },
    async loadMeta(feature: string) {
      return meta[feature];
    },
    async saveMeta(feature: string, data: { lastHlc: HLC | null }) {
      meta[feature] = data;
    },
    async loadSnapshot(feature: string) {
      return snapshots[feature];
    },
    async saveSnapshot(
      feature: string,
      data: { state: unknown; hlc: HLC },
    ) {
      snapshots[feature] = data;
    },
    async clear(feature: string) {
      for (let i = ops.length - 1; i >= 0; i--) {
        if (ops[i]!.feature === feature) ops.splice(i, 1);
      }
      delete meta[feature];
      delete snapshots[feature];
    },
  };
}
