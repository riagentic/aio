// src/sync/op-buffer.ts — Client-side op log with storage abstraction
import type { HLC, SyncOp } from "./types.ts";
import { SYNC_DEFAULTS } from "./types.ts";

/** Storage abstraction — IndexedDB in browser, in-memory for tests */
export interface OpBufferStorage {
  loadOps(cell: string): Promise<SyncOp[]>;
  saveOp(op: SyncOp): Promise<void>;
  confirmOp(opId: string): Promise<void>;
  pruneConfirmed(cell: string): Promise<void>;
  countUnconfirmed(cell: string): Promise<number>;
  loadMeta(cell: string): Promise<{ lastHlc: HLC | null } | undefined>;
  saveMeta(cell: string, data: { lastHlc: HLC | null }): Promise<void>;
  loadSnapshot(cell: string): Promise<
    { state: unknown; hlc: HLC } | undefined
  >;
  saveSnapshot(
    cell: string,
    data: { state: unknown; hlc: HLC },
  ): Promise<void>;
  clear(cell: string): Promise<void>;
}

/** Client-side operation buffer that caps pending ops and delegates to storage. */
export interface OpBuffer {
  add(op: SyncOp): Promise<boolean>;
  confirm(cell: string, opId: string, serverHlc: HLC): Promise<void>;
  getUnconfirmed(cell: string): Promise<SyncOp[]>;
  pruneConfirmed(cell: string): Promise<void>;
  getMeta(cell: string): Promise<{ lastHlc: HLC | null } | undefined>;
  saveSnapshot(
    cell: string,
    data: { state: unknown; hlc: HLC },
  ): Promise<void>;
  loadSnapshot(cell: string): Promise<
    { state: unknown; hlc: HLC } | undefined
  >;
  clear(cell: string): Promise<void>;
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
      const count = await storage.countUnconfirmed(op.cell);
      if (count >= cap) return false;
      await storage.saveOp(op);
      return true;
    },

    async confirm(cell: string, opId: string, serverHlc: HLC) {
      await storage.confirmOp(opId);
      await storage.saveMeta(cell, { lastHlc: serverHlc });
    },

    async getUnconfirmed(cell: string) {
      const ops = await storage.loadOps(cell);
      return ops.filter((o) => !o.confirmed);
    },

    pruneConfirmed: (cell) => storage.pruneConfirmed(cell),
    getMeta: (cell) => storage.loadMeta(cell),
    saveSnapshot: (cell, data) => storage.saveSnapshot(cell, data),
    loadSnapshot: (cell) => storage.loadSnapshot(cell),
    clear: (cell) => storage.clear(cell),
  };
}
