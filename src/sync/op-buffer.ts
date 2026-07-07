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
 * @experimental Excluded from the 1.0 stability guarantee.
 */
export interface OpBufferStorage {
  loadOps(cell: string): Promise<SyncOp[]>;
  saveOp(op: SyncOp): Promise<void>;
  confirmOp(opId: string): Promise<void>;
  pruneConfirmed(cell: string): Promise<void>;
  pruneStale(cell: string, opId: string): Promise<void>;
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

/**
 * In-memory storage for testing and non-persistent use cases
 * @experimental Excluded from the 1.0 stability guarantee.
 */
export function createMemoryStorage(): OpBufferStorage {
  const ops = new Map<string, SyncOp[]>();
  const metas = new Map<string, { lastHlc: HLC | null }>();
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
 * IndexedDB-backed storage for production browser use
 * @experimental Excluded from the 1.0 stability guarantee.
 */
export function createIndexedDBStorage(
  dbName = "aio-sync",
  storeName = "op-buffer",
): OpBufferStorage {
  let dbPromise: Promise<IDBDatabase> | null = null;

  function openDB(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(storeName)) {
          const store = db.createObjectStore(storeName, { keyPath: "id" });
          store.createIndex("cell", "cell");
          store.createIndex("type-cell", ["type", "cell"]);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return dbPromise;
  }

  async function withDB<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
    const db = await openDB();
    return fn(db);
  }

  return {
    loadOps(cell: string): Promise<SyncOp[]> {
      return withDB((db) => {
        const tx = db.transaction(storeName, "readonly");
        const store = tx.objectStore(storeName);
        const index = store.index("type-cell");
        const key = ["op", cell] as [string, string];
        return new Promise<Array<Record<string, unknown>>>(
          (resolve, reject) => {
            const request = index.getAll(key);
            request.onsuccess = () => resolve(request.result ?? []);
            request.onerror = () => reject(request.error);
          },
        );
      }).then((ops) =>
        ops
          .filter((o: Record<string, unknown>) => o.type === "op")
          .map((o: Record<string, unknown>) => o.data as SyncOp)
      );
    },

    saveOp(op: SyncOp): Promise<void> {
      return withDB(async (db) => {
        const tx = db.transaction(storeName, "readwrite");
        const store = tx.objectStore(storeName);
        await new Promise<void>((resolve, reject) => {
          const request = store.put({
            id: `op:${op.id}`,
            type: "op",
            cell: op.cell,
            data: op,
          });
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
      });
    },

    confirmOp(opId: string): Promise<void> {
      return withDB(async (db) => {
        const tx = db.transaction(storeName, "readwrite");
        const store = tx.objectStore(storeName);
        await new Promise<void>((resolve, reject) => {
          const request = store.get(`op:${opId}`);
          request.onsuccess = () => {
            if (request.result) {
              const entry = request.result as Record<string, unknown>;
              (entry.data as SyncOp).confirmed = true;
              const putReq = store.put(entry);
              putReq.onsuccess = () => resolve();
              putReq.onerror = () => reject(putReq.error);
            } else {
              resolve();
            }
          };
          request.onerror = () => reject(request.error);
        });
      });
    },

    pruneConfirmed(cell: string): Promise<void> {
      return withDB((db) => {
        const tx = db.transaction(storeName, "readwrite");
        const store = tx.objectStore(storeName);
        const index = store.index("type-cell");
        const key = ["op", cell] as [string, string];
        return new Promise<void>((resolve, reject) => {
          const request = index.getAll(key);
          request.onsuccess = () => {
            // Entries are wrappers `{ id, type, cell, data: SyncOp }`;
            // the actual op lives on `.data`. Reading `.confirmed` off the
            // wrapper yields undefined, so the previous code pruned nothing.
            const entries = (request.result ?? []).filter(
              (o: Record<string, unknown>) => o.type === "op",
            ) as Array<{ id: string; data: SyncOp }>;
            // F-5: cache confirmed count once — previous implementation
            // recomputed confirmed filter inside every onsuccess callback,
            // producing O(n^2) work at pendingCap (500) ≈ 250k ops.
            const confirmedTotal = entries.reduce(
              (n, e) => e.data.confirmed ? n + 1 : n,
              0,
            );
            if (confirmedTotal === 0) {
              resolve();
              return;
            }
            let count = 0;
            for (const entry of entries) {
              if (!entry.data.confirmed) continue;
              const delReq = store.delete(`op:${entry.data.id}`);
              delReq.onsuccess = () => {
                count++;
                if (count === confirmedTotal) resolve();
              };
              delReq.onerror = () => reject(delReq.error);
            }
          };
          request.onerror = () => reject(request.error);
        });
      });
    },

    pruneStale(_cell: string, opId: string): Promise<void> {
      return withDB(async (db) => {
        const tx = db.transaction(storeName, "readwrite");
        const store = tx.objectStore(storeName);
        await new Promise<void>((resolve, reject) => {
          const delReq = store.delete(`op:${opId}`);
          delReq.onsuccess = () => resolve();
          delReq.onerror = () => reject(delReq.error);
        });
      });
    },

    countUnconfirmed(cell: string): Promise<number> {
      return withDB((db) => {
        const tx = db.transaction(storeName, "readonly");
        const store = tx.objectStore(storeName);
        const index = store.index("type-cell");
        const key = ["op", cell] as [string, string];
        return new Promise<number>((resolve, reject) => {
          const request = index.getAll(key);
          request.onsuccess = () => {
            // Read confirmed from the inner SyncOp, not the wrapper (see pruneConfirmed).
            const entries = (request.result ?? []).filter(
              (o: Record<string, unknown>) => o.type === "op",
            ) as Array<{ data: SyncOp }>;
            resolve(entries.filter((e) => !e.data.confirmed).length);
          };
          request.onerror = () => reject(request.error);
        });
      });
    },

    loadMeta(
      cell: string,
    ): Promise<{ lastHlc: HLC | null; lastServerTs?: number } | undefined> {
      return withDB((db) => {
        const tx = db.transaction(storeName, "readonly");
        const store = tx.objectStore(storeName);
        return new Promise((resolve, reject) => {
          const request = store.get(`meta:${cell}`);
          request.onsuccess = () => resolve(request.result?.data ?? undefined);
          request.onerror = () => reject(request.error);
        });
      });
    },

    saveMeta(
      cell: string,
      data: { lastHlc: HLC | null; lastServerTs?: number },
    ): Promise<void> {
      return withDB(async (db) => {
        const tx = db.transaction(storeName, "readwrite");
        const store = tx.objectStore(storeName);
        await new Promise<void>((resolve, reject) => {
          const request = store.put({
            id: `meta:${cell}`,
            type: "meta",
            cell,
            data,
          });
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
      });
    },

    loadSnapshot(
      cell: string,
    ): Promise<{ state: unknown; hlc: HLC } | undefined> {
      return withDB((db) => {
        const tx = db.transaction(storeName, "readonly");
        const store = tx.objectStore(storeName);
        return new Promise((resolve, reject) => {
          const request = store.get(`snapshot:${cell}`);
          request.onsuccess = () => resolve(request.result?.data ?? undefined);
          request.onerror = () => reject(request.error);
        });
      });
    },

    saveSnapshot(
      cell: string,
      data: { state: unknown; hlc: HLC },
    ): Promise<void> {
      return withDB(async (db) => {
        const tx = db.transaction(storeName, "readwrite");
        const store = tx.objectStore(storeName);
        await new Promise<void>((resolve, reject) => {
          const request = store.put({
            id: `snapshot:${cell}`,
            type: "snapshot",
            cell,
            data,
          });
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
      });
    },

    clear(cell: string): Promise<void> {
      return withDB(async (db) => {
        const tx = db.transaction(storeName, "readwrite");
        const store = tx.objectStore(storeName);
        const index = store.index("type-cell");
        await new Promise<void>((resolve, reject) => {
          const key = ["op", cell] as [string, string];
          const request = index.getAll(key);
          request.onsuccess = () => {
            let count = 0;
            const total = (request.result ?? []).length;
            for (const entry of request.result ?? []) {
              const delReq = store.delete(entry.id as string);
              delReq.onsuccess = () => {
                count++;
                if (count === total) resolve();
              };
              delReq.onerror = () => reject(delReq.error);
            }
            if (total === 0) resolve();
          };
          request.onerror = () => reject(request.error);
        });
      }).then(async () => {
        await withDB(async (db) => {
          const tx = db.transaction(storeName, "readwrite");
          const store = tx.objectStore(storeName);
          await new Promise<void>((resolve, reject) => {
            const delReq1 = store.delete(`meta:${cell}`);
            delReq1.onsuccess = () => resolve();
            delReq1.onerror = () => reject(delReq1.error);
          });
        }).catch(() => {});
        await withDB((db) => {
          const tx = db.transaction(storeName, "readwrite");
          const store = tx.objectStore(storeName);
          return new Promise<void>((resolve, reject) => {
            const delReq = store.delete(`snapshot:${cell}`);
            delReq.onsuccess = () => resolve();
            delReq.onerror = () => reject(delReq.error);
          });
        }).catch(() => {});
      });
    },
  };
}

/**
 * Client-side operation buffer that caps pending ops and delegates to storage.
 * @experimental Excluded from the 1.0 stability guarantee.
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
 * @experimental Excluded from the 1.0 stability guarantee.
 */
export interface OpBufferDropCallback {
  (op: SyncOp, reason: "buffer-full" | "prune-failed"): void;
}

/**
 * Configuration options for the op buffer.
 * @experimental Excluded from the 1.0 stability guarantee.
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
 * @experimental Excluded from the 1.0 stability guarantee.
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
    saveMeta: (cell, data) => storage.saveMeta(cell, data),
  };
}
