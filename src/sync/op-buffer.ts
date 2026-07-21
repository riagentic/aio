// src/sync/op-buffer.ts — Client-side op log with storage abstraction
import type { HLC, SyncOp } from "./types.ts";
import { SYNC_DEFAULTS } from "./types.ts";

/** Parse a retention string like "4h" into milliseconds. */
function parseRetention(retention: string): number {
  const match = retention.match(/^(\d+)(ms|s|m|h)$/);
  if (!match) {
    return SYNC_DEFAULTS.defaultRetention === "4h" ? 4 * 3600_000 : 1000;
  }
  const [, value, unit] = match;
  const n = Number(value);
  switch (unit) {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3600_000;
    default:
      return 1000;
  }
}

/**
 * Storage abstraction for op buffer persistence
 */
export interface OpBufferStorage {
  loadOps(cell: string): Promise<SyncOp[]>;
  saveOp(op: SyncOp): Promise<void>;
  confirmOp(opId: string): Promise<void>;
  pruneConfirmed(cell: string): Promise<void>;
  pruneStale(cell: string, opId: string): Promise<void>;
  countUnconfirmed(cell: string): Promise<number>;
  loadMeta(
    cell: string,
  ): Promise<{ lastHlc: HLC | null; lastServerTs?: number } | undefined>;
  saveMeta(
    cell: string,
    data: { lastHlc: HLC | null; lastServerTs?: number },
  ): Promise<void>;
  loadSnapshot(cell: string): Promise<
    { state: unknown; hlc: HLC } | undefined
  >;
  saveSnapshot(
    cell: string,
    data: { state: unknown; hlc: HLC },
  ): Promise<void>;
  clear(cell: string): Promise<void>;
}

/**
 * In-memory storage for testing and non-persistent use cases
 */
export function createMemoryStorage(): OpBufferStorage {
  const ops = new Map<string, SyncOp[]>();
  const metas = new Map<
    string,
    { lastHlc: HLC | null; lastServerTs?: number }
  >();
  const snapshots = new Map<
    string,
    { state: unknown; hlc: HLC }
  >();

  // Synchronous in-memory maps wrapped to satisfy the async OpBufferStorage
  // contract — Promise.resolve() keeps the return types without a no-op `async`.
  return {
    loadOps(cell: string): Promise<SyncOp[]> {
      return Promise.resolve(ops.get(cell) ?? []);
    },

    saveOp(op: SyncOp): Promise<void> {
      const cellOps = ops.get(op.cell) ?? [];
      cellOps.push(op);
      ops.set(op.cell, cellOps);
      return Promise.resolve();
    },

    confirmOp(opId: string): Promise<void> {
      for (const cellOps of ops.values()) {
        const op = cellOps.find((o) => o.id === opId);
        if (op) {
          op.confirmed = true;
          break;
        }
      }
      return Promise.resolve();
    },

    pruneConfirmed(cell: string): Promise<void> {
      const cellOps = ops.get(cell);
      if (cellOps) {
        ops.set(
          cell,
          cellOps.filter((o) => !o.confirmed),
        );
      }
      return Promise.resolve();
    },

    pruneStale(cell: string, opId: string): Promise<void> {
      const cellOps = ops.get(cell);
      if (cellOps) {
        ops.set(
          cell,
          cellOps.filter((o) => o.id !== opId),
        );
      }
      return Promise.resolve();
    },

    countUnconfirmed(cell: string): Promise<number> {
      return Promise.resolve(
        (ops.get(cell) ?? []).filter((o) => !o.confirmed).length,
      );
    },

    loadMeta(
      cell: string,
    ): Promise<{ lastHlc: HLC | null; lastServerTs?: number } | undefined> {
      return Promise.resolve(metas.get(cell));
    },

    saveMeta(
      cell: string,
      data: { lastHlc: HLC | null; lastServerTs?: number },
    ): Promise<void> {
      metas.set(cell, data);
      return Promise.resolve();
    },

    loadSnapshot(
      cell: string,
    ): Promise<{ state: unknown; hlc: HLC } | undefined> {
      return Promise.resolve(snapshots.get(cell));
    },

    saveSnapshot(
      cell: string,
      data: { state: unknown; hlc: HLC },
    ): Promise<void> {
      snapshots.set(cell, data);
      return Promise.resolve();
    },

    clear(cell: string): Promise<void> {
      ops.delete(cell);
      metas.delete(cell);
      snapshots.delete(cell);
      return Promise.resolve();
    },
  };
}

/**
 * Client-side operation buffer that caps pending ops and delegates to storage.
 */
export interface OpBuffer {
  add(op: SyncOp): Promise<boolean>;
  confirm(cell: string, opId: string, serverHlc: HLC): Promise<void>;
  getUnconfirmed(cell: string): Promise<SyncOp[]>;
  pruneConfirmed(cell: string): Promise<void>;
  getMeta(
    cell: string,
  ): Promise<{ lastHlc: HLC | null; lastServerTs?: number } | undefined>;
  saveSnapshot(
    cell: string,
    data: { state: unknown; hlc: HLC },
  ): Promise<void>;
  loadSnapshot(cell: string): Promise<
    { state: unknown; hlc: HLC } | undefined
  >;
  clear(cell: string): Promise<void>;
  saveMeta(
    cell: string,
    data: { lastHlc: HLC | null; lastServerTs?: number },
  ): Promise<void>;
}

/**
 * Callback invoked when an op is dropped due to buffer capacity limits.
 */
export interface OpBufferDropCallback {
  (op: SyncOp, reason: "buffer-full" | "prune-failed"): void;
}

/**
 * Configuration options for the op buffer.
 */
export interface OpBufferOptions {
  pendingCap?: number;
  /** Called when an op is silently dropped due to capacity limits */
  onDrop?: OpBufferDropCallback;
  /** TTL in ms for stale unconfirmed op eviction (default: SYNC_DEFAULTS.defaultRetention) */
  staleAfter?: number;
}

/**
 * Create an op buffer backed by the given storage implementation.
 */
export function createOpBuffer(
  storage: OpBufferStorage,
  opts?: OpBufferOptions,
): OpBuffer {
  const cap = opts?.pendingCap ?? SYNC_DEFAULTS.pendingCap;
  const onDrop = opts?.onDrop;
  const staleAfterMs = opts?.staleAfter ??
    parseRetention(SYNC_DEFAULTS.defaultRetention);

  return {
    async add(op: SyncOp): Promise<boolean> {
      const count = await storage.countUnconfirmed(op.cell);
      if (count >= cap) {
        // Try pruning confirmed ops to make room
        await storage.pruneConfirmed(op.cell);
        let newCount = await storage.countUnconfirmed(op.cell);
        if (newCount < cap) {
          await storage.saveOp(op);
          return true;
        }

        // Buffer still full — evict stale unconfirmed ops based on _clientTs TTL.
        // This prevents backpressure deadlock where a throttled client's pending
        // queue grows indefinitely while acks can't flow through fast enough.
        const staleOps = await storage.loadOps(op.cell);
        const cutoff = Date.now() - staleAfterMs;
        let evictedCount = 0;

        for (const staleOp of staleOps) {
          if (!staleOp._clientTs || staleOp._clientTs > cutoff) continue;
          // Evict this stale op by removing it from storage
          await storage.pruneStale(op.cell, staleOp.id);
          evictedCount++;
        }

        newCount = await storage.countUnconfirmed(op.cell);
        if (newCount < cap) {
          await storage.saveOp(op);
          return true;
        }

        onDrop?.(op, "prune-failed");
        return false;
      }
      await storage.saveOp(op);
      return true;
    },

    async confirm(cell: string, opId: string, serverHlc: HLC) {
      await storage.confirmOp(opId);
      // Preserve the server_ts cursor — writing { lastHlc } alone would wipe
      // it and regress the next catch-up to the ambiguous HLC cursor
      // (re-delivery → double-apply through the reducer).
      const meta = await storage.loadMeta(cell);
      await storage.saveMeta(cell, {
        lastHlc: serverHlc,
        lastServerTs: meta?.lastServerTs,
      });
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
    saveMeta: (cell, data) => storage.saveMeta(cell, data),
  };
}
