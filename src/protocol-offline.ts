// deno-lint-ignore-file
// Offline action queue persistence via IndexedDB.

import { _diagEmit } from "./protocol-diagnostics.ts";
import { OFFLINE_MAX_AGE } from "./protocol-types.ts";

const _offlineDB = "__aio_offline";
const _offlineStore = "queue";
const _offlineVersion = 1;

interface _QueuedAction {
  id?: number;
  action: { type: string; payload?: unknown };
  ts: number;
}

let _idb: IDBDatabase | null = null;
let _idbPromise: Promise<IDBDatabase | null> | null = null;

function _openIDB(): Promise<IDBDatabase | null> {
  if (_idb) return Promise.resolve(_idb);
  if (_idbPromise) return _idbPromise;
  _idbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = indexedDB.open(_offlineDB, _offlineVersion);
      req.onerror = () => {
        _idbPromise = null;
        resolve(null);
      };
      req.onsuccess = () => {
        _idb = req.result;
        resolve(req.result);
      };
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(_offlineStore)) {
          db.createObjectStore(_offlineStore, {
            keyPath: "id",
            autoIncrement: true,
          });
        }
      };
    } catch {
      _idbPromise = null;
      resolve(null);
    }
  });
  return _idbPromise;
}

export async function _loadOfflineQueue(): Promise<_QueuedAction[]> {
  const db = await _openIDB();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(_offlineStore, "readonly");
      const store = tx.objectStore(_offlineStore);
      const req = store.getAll();
      req.onerror = () => resolve([]);
      req.onsuccess = () => {
        const actions = req.result as _QueuedAction[];
        const cutoff = Date.now() - OFFLINE_MAX_AGE;
        const valid = actions.filter((a) => a.ts >= cutoff);
        // AIO-224: prune expired entries from IDB to prevent unbounded growth
        const expired = actions.filter((a) => a.ts < cutoff);
        if (expired.length > 0) {
          try {
            const delTx = db.transaction(_offlineStore, "readwrite");
            const delStore = delTx.objectStore(_offlineStore);
            for (const e of expired) if (e.id != null) delStore.delete(e.id); // AIO-242: use primary key, not timestamp
          } catch { /* best-effort prune */ }
        }
        resolve(valid);
      };
    } catch (e) {
      _diagEmit({
        type: "offline-storage-error",
        severity: "info",
        source: "browser",
        message: "IndexedDB operation failed — offline persistence unavailable",
        detail: { error: String(e) },
        hint:
          "Offline action queue will use memory only. Check browser storage quota.",
      });
      resolve([]);
    }
  });
}

export const MAX_OFFLINE_ACTIONS = 1000;

export async function _saveOfflineAction(
  action: { type: string; payload?: unknown },
): Promise<void> {
  const db = await _openIDB();
  if (!db) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(_offlineStore, "readwrite");
      const store = tx.objectStore(_offlineStore);
      const countReq = store.count();
      countReq.onsuccess = () => {
        if (countReq.result >= MAX_OFFLINE_ACTIONS) return; // tx will auto-complete
        const addReq = store.add({ action, ts: Date.now() });
        addReq.onerror = () => {
          _diagEmit({
            type: "offline-storage-error",
            severity: "info",
            source: "browser",
            message: "IndexedDB add() failed — offline action lost",
            detail: { error: String(addReq.error) },
            hint:
              "Offline action queue will use memory only. Check browser storage quota.",
          });
        };
      };
      countReq.onerror = () => {
        _diagEmit({
          type: "offline-storage-error",
          severity: "info",
          source: "browser",
          message: "IndexedDB count() failed — offline action lost",
          detail: { error: String(countReq.error) },
          hint:
            "Offline action queue will use memory only. Check browser storage quota.",
        });
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (e) {
    _diagEmit({
      type: "offline-storage-error",
      severity: "info",
      source: "browser",
      message: "IndexedDB operation failed — offline persistence unavailable",
      detail: { error: String(e) },
      hint:
        "Offline action queue will use memory only. Check browser storage quota.",
    });
  }
}

export async function _clearOfflineQueue(): Promise<void> {
  const db = await _openIDB();
  if (!db) return;
  try {
    // AIO-221: await transaction completion to prevent duplicate replay
    const tx = db.transaction(_offlineStore, "readwrite");
    const store = tx.objectStore(_offlineStore);
    store.clear();
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (e) {
    _diagEmit({
      type: "offline-storage-error",
      severity: "info",
      source: "browser",
      message: "IndexedDB operation failed — offline persistence unavailable",
      detail: { error: String(e) },
      hint:
        "Offline action queue will use memory only. Check browser storage quota.",
    });
  }
}

/** Reset IDB state — for _reset() */
export function _resetIDB(): void {
  _idb = null;
  _idbPromise = null;
}
