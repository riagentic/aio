// browser-storage.ts — localStorage-backed OpBufferStorage for the client
// sync engine. Survives reloads (that's the whole point of the offline op
// queue); one JSON document per cell keeps reads/writes atomic enough for
// the engine's per-cell lock discipline.
import type { HLC, SyncOp } from "./types.ts";
import type { OpBufferStorage } from "./op-buffer.ts";
import { log } from "../diagnostics/logger-api.ts";
import { degraded } from "../diagnostics/degraded.ts";

type CellMeta = { lastHlc: HLC | null; lastServerTs?: number };
type CellDoc = {
  ops: SyncOp[];
  /** Per tab (a page load), the number of the newest op of its own that this
   *  document's line of writes has seen — so that tab can tell an op taken
   *  out on purpose from one lost to a stale write (see `repair`). */
  seen?: Record<string, number>;
  /** The tab that wrote it last, and the ops that write added — queued or
   *  put back (see the `storage` listener). */
  by?: string;
  q?: string[];
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
  } catch {
    // aio-ok: storage unavailable (private mode) — nothing to adopt.
  }
}

/** Just enough shape for every storage call to run: a plain object whose
 *  `ops` is an array of objects. */
function isCellDoc(v: unknown): v is CellDoc {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const ops = (v as { ops?: unknown }).ops;
  return Array.isArray(ops) &&
    ops.every((o) => o !== null && typeof o === "object" && !Array.isArray(o));
}

/** `mine` — a tab's copy of a cell document that localStorage refused, built
 *  on `base` — replayed onto `theirs`, what localStorage holds now that
 *  another tab has written. Ops are matched by id: one this tab added is
 *  appended if missing, one it removed is removed, one it confirmed is
 *  confirmed; everything else is theirs. The snapshot is this tab's when it
 *  changed it, theirs otherwise. */
function rebaseDoc(base: CellDoc, mine: CellDoc, theirs: CellDoc): CellDoc {
  const inBase = new Map(base.ops.map((o) => [o.id, o]));
  const inMine = new Map(mine.ops.map((o) => [o.id, o]));
  const ops = theirs.ops
    .filter((o) => !(inBase.has(o.id) && !inMine.has(o.id)))
    .map((o) =>
      inMine.get(o.id)?.confirmed && !inBase.get(o.id)?.confirmed
        ? { ...o, confirmed: true }
        : o
    );
  const have = new Set(ops.map((o) => o.id));
  for (const o of mine.ops) {
    if (!inBase.has(o.id) && !have.has(o.id)) ops.push(o);
  }
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  // `seen` is theirs: it describes theirs' ops (mine's removals only take out
  // ops on purpose; its additions are this tab's own, re-stamped on write).
  const doc: CellDoc = { ...theirs, ops };
  if (!same(mine.snapshot, base.snapshot)) doc.snapshot = mine.snapshot;
  return doc;
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
  // is the entire point of persisting here); the cursor lives in this page
  // load's memory, so a reload re-syncs from scratch.
  //
  // And NOT in the shared document. It used to be written there (tagged with
  // this page load's id), which made every cursor move a read-modify-write of
  // the queue two tabs share — and a second tab moves its cursor on every
  // broadcast, i.e. at the very moment the writing tab confirms the same op on
  // its ack. Tabs are separate processes and localStorage has no lock across
  // them: the passive tab's write, built on a read from before the confirm,
  // put the confirmed op back into the queue as unconfirmed. The writing tab
  // then replayed it on top of a state that already held it — every item
  // shown twice, until a reload (measured: 16 of 20 clicks, two tabs open).
  const metas = new Map<string, CellMeta>();
  // The ops THIS tab queued, per cell, until it sees them leave the queue on
  // purpose (its own prune, or another tab's — told apart by `seen`, below).
  //
  // Tabs are separate processes and each reads localStorage from its own
  // cache, which another tab's write reaches a moment later. Two tabs queueing
  // at the same moment (offline, both typing) each appended to the document
  // they had read and wrote it back: the second write, built on a read from
  // before the first, dropped the first tab's op from the queue — an unsent
  // change gone for good (measured: 1 of 120). Every read here puts back an
  // op of this tab that vanished without a trace, and a `storage` event (the
  // other tab's write arriving) triggers that read at once.
  //
  // "On purpose" is proven by a watermark, not a list of removed ids (a list
  // is bounded, and an op whose id fell off it came back to life): each op of
  // this tab gets a number `n`, and every write of this tab stamps
  // `seen[tab]` with the newest — its read was repaired first, so it holds
  // all of them. Other tabs carry `seen` over from what they read. A document
  // whose `seen[tab]` reaches `n` therefore descends from one that held the
  // op, and every write since took ops out only on purpose: a stale write
  // descends from a read without the op, so it carries a lower mark.
  const tab = Math.random().toString(36).slice(2, 10);
  let seq = 0;
  const mine = new Map<string, Map<string, [SyncOp, number]>>();
  /** The ops the next write adds (see `CellDoc.q`). */
  let queued: string[] = [];
  const repair = (cell: string, doc: CellDoc): CellDoc => {
    const own = mine.get(cell);
    if (!own?.size) return doc;
    const have = new Map(doc.ops.map((o) => [o.id, o]));
    let fix = false;
    for (const [id, [o, n]] of own) {
      const d = have.get(id);
      // A stale write can also take back this tab's confirm.
      if (d) o.confirmed && !d.confirmed && (fix = d.confirmed = true);
      else if (n <= (doc.seen?.[tab] ?? 0)) own.delete(id);
      else {
        doc.ops.push(o);
        queued.push(id);
        fix = true;
      }
    }
    if (fix) write(cell, doc);
    return doc;
  };
  /** Remove the ops `keep` rejects. */
  const remove = (cell: string, keep: (o: SyncOp) => boolean): void => {
    const doc = read(cell);
    doc.ops = doc.ops.filter((o) =>
      keep(o) || (mine.get(cell)?.delete(o.id), dropped.add(o.id), false)
    );
    // Only needed while a write from before this one can still be heard —
    // a moment; the cap keeps a long session's list small.
    for (const id of dropped) {
      if (dropped.size <= 1024) break;
      dropped.delete(id);
    }
    write(cell, doc);
  };
  /** What this tab took out of the queue on purpose (see the listener). */
  const dropped = new Set<string>();
  const docOf = (raw: string | null): CellDoc | undefined => {
    try {
      const d: unknown = JSON.parse(raw ?? "");
      return isCellDoc(d) ? d : undefined;
    } catch {
      return undefined; // aio-ok: not a queue document — nothing to restore
    }
  };
  globalThis.addEventListener?.("storage", (e) => {
    const { key: k, newValue } = e as StorageEvent;
    // Only this queue's keys: another app's queue on this origin is not ours.
    if (!k?.startsWith(`${prefix}:`)) return;
    const cell = k.slice(prefix.length + 1);
    if (mine.has(cell)) read(cell);
    // Another tab's write that added ops, heard after a stale write (built on
    // a read from before it) took them out again. Their owner puts them back
    // on its next read — unless it is gone (closed, reloaded, navigated right
    // after the call); then only a tab that hears the write can. Not when the
    // queue descends from that write (it carries the write's `seen` mark: the
    // ops left on purpose), nor when the owner wrote since (it put back what
    // it lost first), nor for an op this tab took out itself. What this tab
    // puts back is its own to keep from then on, and its write names it: a
    // third tab's stale write can take it out again.
    const theirs = docOf(newValue);
    const t = theirs?.by;
    const n = t && theirs!.seen?.[t];
    if (!n || !theirs!.q?.length || mirror.has(cell)) return;
    const doc = read(cell);
    if (doc.by === t || (doc.seen?.[t] ?? 0) >= n) return;
    const have = new Set(doc.ops.map((o) => o.id));
    for (const o of theirs!.ops) {
      if (!theirs!.q.includes(o.id) || have.has(o.id) || dropped.has(o.id)) {
        continue;
      }
      if (!mine.has(cell)) mine.set(cell, new Map());
      mine.get(cell)!.set(o.id, [{ ...o }, ++seq]);
      doc.ops.push(o);
      queued.push(o.id);
    }
    if (queued.length) write(cell, doc);
  });
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
  } catch {
    // aio-ok: storage unavailable (private mode) — nothing to sweep.
  }
  adoptLegacyQueue(prefix);
  // The in-memory copy of every document whose last WRITE did not reach
  // localStorage — and, while it exists, the copy that is read.
  //
  // Without it a refused write was not "not durable", it was GONE: `read` went
  // back to localStorage, which still held the document from before (or
  // nothing). The engine's pending list therefore never contained the op it
  // had just queued, so the optimistic view did not show it, the ack found no
  // pending op to fold into confirmed state, and the tab never saw its own
  // write — in a private window, a site with storage blocked, or at a full
  // quota. An offline write was lost outright while its call resolved.
  //
  // Only failed cells live here, and only until a write succeeds again: the
  // document stays in localStorage whenever localStorage takes it, which is
  // what lets two tabs of one app share a queue.
  //
  // …and the copy is an OVERLAY on localStorage, never a replacement for it.
  // Each entry remembers the localStorage text it was built on (`base`). A
  // tab that returned its copy blindly never saw another tab's writes again
  // after one refused write (a quota blip) — and its next write that DID land
  // wrote its copy over the shared document, deleting the other tab's queued
  // ops from the queue both tabs read (measured: tab B's `b1` gone after tab
  // A's next save). When localStorage has moved since, the copy is re-based:
  // this tab's own unwritten changes (ops added, confirmed, removed; its
  // cursor) are replayed onto what is there now.
  const mirror = new Map<string, { doc: CellDoc; base: string | null }>();
  /** The localStorage text each cell's last `read` parsed — the base a copy
   *  made from that read is built on. */
  const lastRaw = new Map<string, string | null>();
  const read = (cell: string): CellDoc => {
    let raw: string | null = null;
    let readable = true;
    try {
      raw = localStorage.getItem(key(cell));
    } catch {
      readable = false; // storage unavailable (private mode) — documented
    }
    const held = mirror.get(cell);
    if (held !== undefined) {
      // Nothing else can have written (or nothing can be read): ours is it.
      if (!readable || raw === held.base) return repair(cell, held.doc);
      const doc = rebaseDoc(
        parseDoc(cell, held.base),
        held.doc,
        parseDoc(cell, raw),
      );
      mirror.set(cell, { doc, base: raw });
      lastRaw.set(cell, raw);
      return repair(cell, doc);
    }
    lastRaw.set(cell, raw);
    return repair(cell, readable ? parseDoc(cell, raw) : { ops: [] });
  };
  const parseDoc = (cell: string, raw: string | null): CellDoc => {
    if (!raw) return { ops: [] };
    try {
      const doc: unknown = JSON.parse(raw);
      // Well-formed JSON is not yet a cell document. `null`, `[]`, `42` or
      // `{ops: "x"}` used to be returned as-is, and every storage call on the
      // cell then died on `doc.ops.push`/`.filter` — forever, with no copy and
      // no data-loss report. A wrong shape is corrupt exactly like broken
      // JSON is, so it takes the same branch below.
      if (!isCellDoc(doc)) {
        throw new TypeError("not an offline-queue document (wrong shape)");
      }
      return doc;
    } catch (e) {
      // A corrupt document is NOT the same as no document. Returning `{ops: []}`
      // silently made the next `saveOp` overwrite it, discarding every pending
      // offline mutation — in the subsystem whose entire purpose is not losing
      // them. The ops are unrecoverable either way (the JSON is broken), but
      // the user is owed the fact, and the bytes are worth keeping for anyone
      // who wants to look.
      try {
        localStorage.setItem(`${key(cell)}.corrupt`, raw);
      } catch {
        // aio-ok: no room for the copy — the warning still goes out below.
      }
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
    if (mine.get(cell)?.size) (doc.seen ??= {})[tab] = seq;
    else delete doc.seen?.[tab];
    doc.by = tab;
    doc.q = queued.length ? queued : undefined;
    queued = [];
    try {
      localStorage.setItem(key(cell), JSON.stringify(doc));
      mirror.delete(cell);
      writeFailed.delete(cell);
      storeHealth.ok();
    } catch (e) {
      // Kept in memory FIRST — this page load goes on working from it — on
      // top of the localStorage text the document was read from.
      const held = mirror.get(cell);
      mirror.set(cell, {
        doc,
        base: held !== undefined ? held.base : lastRaw.get(cell) ?? null,
      });
      storeHealth.fail(e);
      if (writeFailed.has(cell)) return;
      writeFailed.add(cell);
      log.error(
        "sync",
        `the offline queue for "${cell}" could not be written to ` +
          `localStorage (${e}) — it is kept in memory for this page load, so ` +
          `sync goes on working, but unsent changes in this cell will NOT ` +
          `survive a reload. Usual causes: the origin's storage quota is full ` +
          `(clear it, or reduce what the app keeps there) or storage is ` +
          `disabled for this context (private mode, a blocked third-party ` +
          `frame). Reported once per cell until a write succeeds again.`,
      );
    }
  };

  return {
    loadOps: (cell) => Promise.resolve(read(cell).ops),
    saveOp: (op) => {
      const doc = read(op.cell);
      doc.ops.push(op);
      if (!mine.has(op.cell)) mine.set(op.cell, new Map());
      mine.get(op.cell)!.set(op.id, [{ ...op }, ++seq]);
      queued.push(op.id);
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
      const own = mine.get(cell)?.get(opId);
      if (own) own[0].confirmed = true;
      if (op) {
        op.confirmed = true;
        write(cell, doc);
      }
      return Promise.resolve();
    },
    pruneConfirmed: (cell) =>
      Promise.resolve(remove(cell, (o) => !o.confirmed)),
    pruneStale: (cell, opId) =>
      Promise.resolve(remove(cell, (o) => o.id !== opId)),
    countUnconfirmed: (cell) =>
      Promise.resolve(read(cell).ops.filter((o) => !o.confirmed).length),
    loadMeta: (cell) => Promise.resolve(metas.get(cell)),
    saveMeta: (cell, data) => {
      metas.set(cell, { ...metas.get(cell), ...data } as CellMeta);
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
      mine.delete(cell);
      mirror.delete(cell);
      lastRaw.delete(cell);
      try {
        localStorage.removeItem(key(cell));
      } catch {
        // aio-ok: storage unavailable — clear() has nothing left to remove.
      }
      return Promise.resolve();
    },
  };
}
