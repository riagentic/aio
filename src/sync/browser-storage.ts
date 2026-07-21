// browser-storage.ts — localStorage-backed OpBufferStorage for the client
// sync engine. Survives reloads (that's the whole point of the offline op
// queue); one JSON document per cell keeps reads/writes atomic enough for
// the engine's per-cell lock discipline.
import type { HLC, SyncOp } from "./types.ts";
import type { OpBufferStorage } from "./op-buffer.ts";

type CellDoc = {
  ops: SyncOp[];
  meta?: { lastHlc: HLC | null; lastServerTs?: number };
  snapshot?: { state: unknown; hlc: HLC };
};

/**
 * OpBufferStorage persisted in `localStorage` — the browser counterpart of
 * {@linkcode createMemoryStorage}. Namespaced by `prefix` so several apps on
 * one origin don't collide.
 */
export function createLocalStorageOpStorage(
  prefix = "__aio_sync",
): OpBufferStorage {
  const key = (cell: string) => `${prefix}:${cell}`;
  const read = (cell: string): CellDoc => {
    try {
      const raw = localStorage.getItem(key(cell));
      return raw ? JSON.parse(raw) as CellDoc : { ops: [] };
    } catch {
      return { ops: [] };
    }
  };
  const write = (cell: string, doc: CellDoc): void => {
    try {
      localStorage.setItem(key(cell), JSON.stringify(doc));
    } catch { /* quota/private mode — degrade to memory-only semantics */ }
  };

  return {
    loadOps: (cell) => Promise.resolve(read(cell).ops),
    saveOp: (op) => {
      const doc = read(op.cell);
      doc.ops.push(op);
      write(op.cell, doc);
      return Promise.resolve();
    },
    confirmOp: (opId) => {
      // opId is globally unique (clientId-counter) — scan cells we know of
      // is impossible here without the cell; the engine always confirms via
      // buffer which passes through per-cell — find by scanning stored keys.
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (!k?.startsWith(`${prefix}:`)) continue;
          const cell = k.slice(prefix.length + 1);
          const doc = read(cell);
          const op = doc.ops.find((o) => o.id === opId);
          if (op) {
            op.confirmed = true;
            write(cell, doc);
            break;
          }
        }
      } catch { /* storage unavailable */ }
      return Promise.resolve();
    },
    pruneConfirmed: (cell) => {
      const doc = read(cell);
      doc.ops = doc.ops.filter((o) => !o.confirmed);
      write(cell, doc);
      return Promise.resolve();
    },
    pruneStale: (cell, opId) => {
      const doc = read(cell);
      doc.ops = doc.ops.filter((o) => o.id !== opId);
      write(cell, doc);
      return Promise.resolve();
    },
    countUnconfirmed: (cell) =>
      Promise.resolve(read(cell).ops.filter((o) => !o.confirmed).length),
    loadMeta: (cell) => Promise.resolve(read(cell).meta),
    saveMeta: (cell, data) => {
      const doc = read(cell);
      doc.meta = { ...doc.meta, ...data };
      write(cell, doc);
      return Promise.resolve();
    },
    loadSnapshot: (cell) => Promise.resolve(read(cell).snapshot),
    saveSnapshot: (cell, data) => {
      const doc = read(cell);
      doc.snapshot = data;
      write(cell, doc);
      return Promise.resolve();
    },
    clear: (cell) => {
      try {
        localStorage.removeItem(key(cell));
      } catch { /* storage unavailable */ }
      return Promise.resolve();
    },
  };
}
