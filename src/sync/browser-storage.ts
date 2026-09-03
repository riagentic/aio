// browser-storage.ts — localStorage-backed OpBufferStorage for the client
// sync engine. Survives reloads (that's the whole point of the offline op
// queue); one JSON document per cell keeps reads/writes atomic enough for
// the engine's per-cell lock discipline.
import { randomUuid } from "../rand.ts";
import type { HLC, SyncOp } from "./types.ts";
import type { OpBufferStorage } from "./op-buffer.ts";
import { log } from "../diagnostics/logger-api.ts";
import { degraded } from "../diagnostics/degraded.ts";

type CellDoc = {
  ops: SyncOp[];
  meta?: { lastHlc: HLC | null; lastServerTs?: number };
  /** Which page load wrote `meta` — see the session note on `loadMeta`. */
  metaSession?: string;
  snapshot?: { state: unknown; hlc: HLC; serverTs?: number };
};

/** The unscoped namespace every build before app-scoping wrote under, and the
 *  fallback for a client that was never told which app it is. */
export const SYNC_STORAGE_PREFIX = "__aio_sync";

/** The localStorage namespace for ONE app's offline queue.
 *
 *  `localStorage` is per ORIGIN, and an app id is not part of an origin: two
 *  aio apps served from the same host:port (a pinned port, a shared host, or
 *  simply one app replacing another on the dev port) shared the queue of every
 *  cell whose NAME they had in common — app B's first `requestSync` flushed
 *  app A's unsent ops into B's server, as B's user, silently. The app id is
 *  the only thing that separates them, so it is part of the key. */
export function syncStoragePrefix(appId?: string | null): string {
  if (!appId) return SYNC_STORAGE_PREFIX;
  // The key format is `<prefix>:<cell>`; an id carrying the separator (or
  // anything else exotic) must not be able to reshape a key into another
  // app's. Slugified server-side already — this is the belt.
  return `${SYNC_STORAGE_PREFIX}.${appId.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

/** One-time adoption of a queue written under the unscoped prefix by a build
 *  from before {@linkcode syncStoragePrefix} existed.
 *
 *  The alternative — ignoring it — loses real unsent mutations for every
 *  single-app origin (the overwhelming case) at the one moment the queue
 *  exists to survive: an upgrade while offline. So it is MOVED, loudly, and
 *  exactly once: the legacy key is removed, so a second app on the same origin
 *  finds nothing to adopt and the two are isolated from then on. It can only
 *  ever be adopted by whichever app boots first — which is strictly better
 *  than the permanent, silent sharing it replaces, and it is announced rather
 *  than guessed at. Never duplicated: a scoped document already present wins
 *  and the legacy key is left untouched (write-then-remove, so a crash between
 *  the two leaves a stale copy, never two live queues). */
function adoptLegacyQueue(prefix: string): void {
  if (prefix === SYNC_STORAGE_PREFIX) return; // unscoped: it IS the legacy one
  try {
    const cells: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(`${SYNC_STORAGE_PREFIX}:`)) continue;
      const cell = k.slice(SYNC_STORAGE_PREFIX.length + 1);
      // `clientId` is the sync identity, not a cell document, and `.corrupt`
      // keys are forensic copies — neither is a queue.
      if (cell === "clientId" || cell.includes(".corrupt")) continue;
      cells.push(cell);
    }
    for (const cell of cells) {
      const from = `${SYNC_STORAGE_PREFIX}:${cell}`;
      const to = `${prefix}:${cell}`;
      if (localStorage.getItem(to) !== null) continue; // this app already has one
      const raw = localStorage.getItem(from);
      if (raw === null) continue;
      localStorage.setItem(to, raw);
      localStorage.removeItem(from);
      log.warn(
        "sync",
        `adopted the offline queue at "${from}" (written by a build that did ` +
          `not scope the queue per app) into "${to}". If more than one aio ` +
          `app is served from this origin, those pending changes may have ` +
          `belonged to the other one — check before they flush. Happens once.`,
      );
    }
  } catch { /* storage unavailable (private mode) — nothing to adopt */ }
}

/**
 * OpBufferStorage persisted in `localStorage` — the browser counterpart of
 * {@linkcode createMemoryStorage}. Namespaced by `prefix` (see
 * {@linkcode syncStoragePrefix}) so several apps on one origin don't collide.
 */
export function createLocalStorageOpStorage(
  prefix: string = SYNC_STORAGE_PREFIX,
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
  adoptLegacyQueue(prefix);
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
      log.error(
        "sync",
        `offline queue for "${cell}" is corrupt and was discarded ` +
          `— any unsent changes in it are lost (${e}). The raw document was ` +
          `kept at "${key(cell)}.corrupt".`,
      );
      return { ops: [] };
    }
  };
  // A refused `setItem` is NOT a retryable blip, and it does not "degrade to
  // memory-only" either: `read` goes back to localStorage on every call, so
  // there is no in-memory copy to fall back on. Quota exhausted, or storage
  // disabled (private mode, a blocked third-party context), means every unsent
  // change in this cell is gone at the next reload — while `saveOp` resolves
  // and the engine goes on believing the op is queued. That is the one failure
  // the offline queue exists to prevent, and it was swallowed by a bare catch.
  //
  // Said ONCE per cell at error level (it is data loss, not a hiccup — and
  // repeating it on every keystroke is what made the original invisible), and
  // routed through `degraded` so a queue that has stopped persisting shows up
  // in health output rather than only in one console line.
  const storeHealth = degraded("sync:offline-queue");
  const writeFailed = new Set<string>();
  const write = (cell: string, doc: CellDoc): void => {
    try {
      localStorage.setItem(key(cell), JSON.stringify(doc));
      writeFailed.delete(cell);
      storeHealth.ok();
    } catch (e) {
      storeHealth.fail(e);
      if (writeFailed.has(cell)) return;
      writeFailed.add(cell);
      log.error(
        "sync",
        `the offline queue for "${cell}" could not be written to ` +
          `localStorage (${e}) — unsent changes in this cell will NOT survive ` +
          `a reload, and the sync engine is not told. Usual causes: the ` +
          `origin's storage quota is full (clear it, or reduce what the app ` +
          `keeps there) or storage is disabled for this context (private ` +
          `mode, a blocked third-party frame). Reported once per cell until ` +
          `a write succeeds again.`,
      );
    }
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
