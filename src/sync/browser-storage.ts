// browser-storage.ts — localStorage-backed OpBufferStorage for the client
// sync engine. Survives reloads (that's the whole point of the offline op
// queue); one JSON document per cell keeps reads/writes atomic enough for
// the engine's per-cell lock discipline.
import { randomUuid } from "../rand.ts";
import type { HLC, SyncOp } from "./types.ts";
import type { OpBufferStorage } from "./op-buffer.ts";

type CellDoc = {
  ops: SyncOp[];
  meta?: { lastHlc: HLC | null; lastServerTs?: number };
  /** Which page load wrote `meta` — see the session note on `loadMeta`. */
  metaSession?: string;
  snapshot?: { state: unknown; hlc: HLC; serverTs?: number };
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
  // This page load. The catch-up cursor may be exactly as durable as the state
  // it describes — and the client's CONFIRMED state is not durable at all: the
  // engine is handed a plain object that browser-sync re-seeds from the cell's
  // initialState on every boot. A cursor that outlived it made the reloaded
  // client tell the server "I'm caught up to T"; the server duly sent nothing,
  // and the first op or ack after that rebased the UI onto an empty base — the
  // user's data vanishing on a refresh. Ops still survive (the offline queue
  // is the entire point of persisting here); the cursor is session-scoped, so
  // a reload re-syncs from scratch.
  const session = randomUuid();
  // One-time sweep of `<key>.corrupt.corrupt…` chains left by the old
  // confirmOp key-scan (see the note on `confirmOp`): only that scan ever
  // wrote a SECOND `.corrupt` suffix, growing one key per ack until quota, so
  // any key carrying one is its garbage. Single-`.corrupt` forensic copies of
  // real cell documents are deliberate and stay.
  try {
    const junk: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(`${prefix}:`)) continue;
      if (
        /\.corrupt(\.corrupt)+$/.test(k) || k === `${prefix}:clientId.corrupt`
      ) {
        junk.push(k);
      }
    }
    for (const k of junk) localStorage.removeItem(k);
  } catch { /* storage unavailable (private mode) — nothing to sweep */ }
  const read = (cell: string): CellDoc => {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(key(cell));
    } catch {
      return { ops: [] }; // storage unavailable (private mode) — documented
    }
    if (!raw) return { ops: [] };
    try {
      return JSON.parse(raw) as CellDoc;
    } catch (e) {
      // A corrupt document is NOT the same as no document. Returning `{ops: []}`
      // silently made the next `saveOp` overwrite it, discarding every pending
      // offline mutation — in the subsystem whose entire purpose is not losing
      // them. The ops are unrecoverable either way (the JSON is broken), but
      // the user is owed the fact, and the bytes are worth keeping for anyone
      // who wants to look.
      try {
        localStorage.setItem(`${key(cell)}.corrupt`, raw);
      } catch { /* no room for the copy — the warning still goes out */ }
      console.error(
        `[aio:sync] offline queue for "${cell}" is corrupt and was discarded ` +
          `— any unsent changes in it are lost (${e}). The raw document was ` +
          `kept at "${key(cell)}.corrupt".`,
      );
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
    confirmOp: (cell, opId) => {
      // ONLY this cell's document. This used to scan every `prefix:*` key as
      // a cell doc, which swept up NON-doc keys sharing the prefix — the
      // clientId key and the forensic `.corrupt` copies. Each scan re-flagged
      // those as "corrupt queues" (a false data-loss alarm plus a new
      // `.corrupt.corrupt…` key per ack), and a clientId whose 8 hex chars
      // were all digits PARSED as a JSON number, so `doc.ops.find` threw and
      // the catch ate the confirm — the op then rebased on top of every
      // snapshot forever (the double-apply flake, ~2% of clients).
      const doc = read(cell);
      const op = doc.ops.find((o) => o.id === opId);
      if (op) {
        op.confirmed = true;
        write(cell, doc);
      }
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
    loadMeta: (cell) => {
      const doc = read(cell);
      // A cursor from an earlier page load describes state this session does
      // not have (see `session` above) — report "no cursor" and let the
      // catch-up rebuild from a snapshot or the full log.
      return Promise.resolve(
        doc.metaSession === session ? doc.meta : undefined,
      );
    },
    saveMeta: (cell, data) => {
      const doc = read(cell);
      doc.meta = { ...(doc.metaSession === session ? doc.meta : {}), ...data };
      doc.metaSession = session;
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
