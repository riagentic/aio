// src/sync/op-buffer.ts — Client-side op log with storage abstraction
import type { HLC, SyncOp } from "./types.ts";
import { SYNC_DEFAULTS } from "./types.ts";

/** Storage abstraction — IndexedDB in browser, in-memory for tests */
export interface OpBufferStorage {
  loadOps(feature: string): Promise<SyncOp[]>;
  saveOp(op: SyncOp): Promise<void>;
  confirmOp(opId: string): Promise<void>;
  pruneConfirmed(feature: string): Promise<void>;
  countUnconfirmed(feature: string): Promise<number>;
  loadMeta(feature: string): Promise<{ lastHlc: HLC | null } | undefined>;
  saveMeta(feature: string, data: { lastHlc: HLC | null }): Promise<void>;
  loadSnapshot(feature: string): Promise<
    { state: unknown; hlc: HLC } | undefined
  >;
  saveSnapshot(
    feature: string,
    data: { state: unknown; hlc: HLC },
  ): Promise<void>;
  clear(feature: string): Promise<void>;
}

/** Client-side operation buffer that caps pending ops and delegates to storage. */
export interface OpBuffer {
  add(op: SyncOp): Promise<boolean>;
  confirm(feature: string, opId: string, serverHlc: HLC): Promise<void>;
  getUnconfirmed(feature: string): Promise<SyncOp[]>;
  pruneConfirmed(feature: string): Promise<void>;
  getMeta(feature: string): Promise<{ lastHlc: HLC | null } | undefined>;
  saveSnapshot(
    feature: string,
    data: { state: unknown; hlc: HLC },
  ): Promise<void>;
  loadSnapshot(feature: string): Promise<
    { state: unknown; hlc: HLC } | undefined
  >;
  clear(feature: string): Promise<void>;
}

/** Configuration options for the op buffer. */
export interface OpBufferOptions {
  pendingCap?: number;
}

/** Create an op buffer backed by the given storage implementation. */
export function createOpBuffer(
  storage: OpBufferStorage,
  opts?: OpBufferOptions,
): OpBuffer {
  const cap = opts?.pendingCap ?? SYNC_DEFAULTS.pendingCap;

  return {
    async add(op: SyncOp): Promise<boolean> {
      const count = await storage.countUnconfirmed(op.feature);
      if (count >= cap) return false;
      await storage.saveOp(op);
      return true;
    },

    async confirm(feature: string, opId: string, serverHlc: HLC) {
      await storage.confirmOp(opId);
      await storage.saveMeta(feature, { lastHlc: serverHlc });
    },

    async getUnconfirmed(feature: string) {
      const ops = await storage.loadOps(feature);
      return ops.filter((o) => !o.confirmed);
    },

    pruneConfirmed: (feature) => storage.pruneConfirmed(feature),
    getMeta: (feature) => storage.loadMeta(feature),
    saveSnapshot: (feature, data) => storage.saveSnapshot(feature, data),
    loadSnapshot: (feature) => storage.loadSnapshot(feature),
    clear: (feature) => storage.clear(feature),
  };
}
