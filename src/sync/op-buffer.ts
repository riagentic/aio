// src/sync/op-buffer.ts — Client-side op log with storage abstraction
import type { HLC, SyncOp } from "./types.ts";
import { SYNC_DEFAULTS } from "./types.ts";

/** Parse a retention string like "4h" or "7d" into milliseconds.
 *
 *  Throws on anything it cannot read. It used to fall back to 4h, so
 *  `retention: "7d"` — the value `docs/persistence/crdt.md` puts in its own
 *  example — silently became 4h: the queue evicted the user's unsent changes
 *  42× earlier than the app asked for, with nothing to see. A retention it
 *  cannot honour is a misconfig, and a misconfig speaks. */
export function parseRetention(retention: string): number {
  const match = retention.trim().match(/^(\d+)(ms|s|m|h|d)$/);
  if (!match) {
    throw new Error(
      `[aio:sync] offline.retention "${retention}" is not a duration — ` +
        `use digits plus one of ms, s, m, h, d (e.g. "4h", "7d").`,
    );
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
      return n * 86_400_000; // "d" — the regex admits nothing else
  }
}

/**
 * Storage abstraction for op buffer persistence

 *  @internal Engine/framework wiring (alpha52 sweep) — not public API.
 */
export interface OpBufferStorage {
  loadOps(cell: string): Promise<SyncOp[]>;
  saveOp(op: SyncOp): Promise<void>;
  confirmOp(cell: string, opId: string): Promise<void>;
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
    { state: unknown; hlc: HLC; serverTs?: number } | undefined
  >;
  saveSnapshot(
    cell: string,
    data: { state: unknown; hlc: HLC; serverTs?: number },
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
    { state: unknown; hlc: HLC; serverTs?: number }
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

    confirmOp(cell: string, opId: string): Promise<void> {
      const op = (ops.get(cell) ?? []).find((o) => o.id === opId);
      if (op) op.confirmed = true;
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
    ): Promise<{ state: unknown; hlc: HLC; serverTs?: number } | undefined> {
      return Promise.resolve(snapshots.get(cell));
    },

    saveSnapshot(
      cell: string,
      data: { state: unknown; hlc: HLC; serverTs?: number },
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

 *  @internal Engine/framework wiring (alpha52 sweep) — not public API.
 */
export interface OpBuffer {
  add(op: SyncOp): Promise<boolean>;
  confirm(cell: string, opId: string, serverHlc: HLC): Promise<void>;
  getUnconfirmed(cell: string): Promise<SyncOp[]>;
  pruneConfirmed(cell: string): Promise<void>;
  /** Drop a single op (D11 rejection rollback). */
  pruneStale(cell: string, opId: string): Promise<void>;
  /** Drop a single op the server refused as STALE, and tell the app
   *  (`onDrop`, reason `stale-beyond-retention`). `pruneStale` is the silent
   *  rollback of a rejection the app already hears through `onRejected`; this
   *  is for the one rejection that is also an abandoned local change — the
   *  server could no longer recognise the op as a resend (`STALE_OP_REASON`)
   *  — so the drop must reach the same channel every other abandoned change
   *  reaches. The reason is the buffer's, not the caller's: every reason a
   *  handler can be written for is emitted here, by name (a gate reads them).
   *  Optional: additive on the interface. */
  dropStale?(cell: string, opId: string): Promise<void>;
  /** Ops this buffer discarded on its OWN initiative — the backpressure
   *  eviction inside {@link OpBuffer.add} — since the last call, which also
   *  clears the list.
   *
   *  The engine needs the difference between "this op left the queue" and
   *  "this op left the queue AND nobody here folded it": the second is a twin
   *  tab having confirmed it, and costs a re-sync of the cell; an eviction is
   *  neither and costs nothing. Only `add` evicts, and only the engine calls
   *  `add`, so draining right after it attributes every eviction exactly.
   *  Optional: additive on the interface — a buffer without it puts the engine
   *  back on the previous (over-attributing) behaviour, never on damage. */
  takeEvicted?(): { cell: string; id: string }[];
  getMeta(
    cell: string,
  ): Promise<{ lastHlc: HLC | null; lastServerTs?: number } | undefined>;
  saveSnapshot(
    cell: string,
    data: { state: unknown; hlc: HLC; serverTs?: number },
  ): Promise<void>;
  loadSnapshot(cell: string): Promise<
    { state: unknown; hlc: HLC; serverTs?: number } | undefined
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
  (
    op: SyncOp,
    /** `stale-evicted`: an UNCONFIRMED op past its TTL, discarded to make room
     *  under backpressure. This is the app's one chance to know a local
     *  mutation was abandoned — but NOT proof that it never landed: the op was
     *  sent, and it may have been applied on the server with its ack lost on a
     *  dropped socket. `dropReport` is the wording; do not upgrade the unknown
     *  to a "never arrived" in a handler either.
     *  `prune-failed`: the buffer was over its cap and pruning could not free a
     *  slot, so the NEW op was refused.
     *
     *  `stale-beyond-retention`: the SERVER refused the op because it was
     *  stamped older than its tombstone window and it could no longer tell a
     *  resend (after a lost ack) from a new change — see `STALE_OP_REASON`.
     *  The op is dropped so it is never re-sent; `sync.onRejected` fires
     *  too, with the server's full sentence.
     *
     *  There is no fourth reason. `"buffer-full"` was listed here and never
     *  emitted — a handler could switch on it forever and be dead code, and a
     *  reader would reasonably conclude aio distinguishes a case it does not. */
    reason: "prune-failed" | "stale-evicted" | "stale-beyond-retention",
  ): void;
}

/** The reasons an op leaves the buffer without being confirmed — the argument
 *  {@link OpBufferDropCallback} gets, and the key {@link dropReport} answers.
 *  @internal Engine/framework wiring — not public API. */
export type OpDropReason =
  | "prune-failed"
  | "stale-evicted"
  | "stale-beyond-retention";

/** What a drop reason actually PROVES, in one sentence plus what to do — the
 *  one wording the console line and the `sync-op-dropped` diagnostic share.
 *
 *  One sentence used to cover all three: "this mutation never reached the
 *  server and is now gone." True of `prune-failed` (the buffer refused the op
 *  before it was ever sent) and of `stale-beyond-retention` (the SERVER
 *  refused it, so it was not applied). Not true of `stale-evicted`: that op
 *  was sent, and it may have been applied and acked with the ack lost on a
 *  dropped socket — whether the server holds the change is exactly what nobody
 *  knows. Telling the user it never arrived turns an unknown into a false
 *  negative, and the natural repair (make the change again) then writes it
 *  twice. A report that overstates is the same class of bug as one that stays
 *  silent; each reason gets the sentence its evidence supports.
 *
 *  Pure: same reason in, same strings out. */
export function dropReport(
  reason: OpDropReason,
): { what: string; hint: string } {
  switch (reason) {
    case "prune-failed":
      return {
        what:
          "the offline queue is full (pending cap reached), so this change " +
          "was refused before it was ever sent — it never reached the server " +
          "and is gone.",
        hint:
          "The offline queue holds SYNC_DEFAULTS.pendingCap unconfirmed ops " +
          "per cell and is full, so the client has not reached the server in " +
          "a long time. Check connectivity and backpressure.",
      };
    case "stale-evicted":
      return {
        what:
          "this change sat unconfirmed past its retention and was evicted to " +
          "make room in a full offline queue. The server never acknowledged " +
          "it, so it may have been applied there (an ack can be lost with the " +
          "socket) or may never have arrived — this client will not re-send " +
          "it either way.",
        hint:
          "Read the cell's state to see whether the change is there; nothing " +
          "on this side can tell. Raise the cell's sync offline.retention to " +
          "keep unsent changes longer, and check connectivity/backpressure.",
      };
    case "stale-beyond-retention":
      return {
        what:
          "the server refused it as stamped older than its tombstone window — " +
          "it could no longer tell a resend from a new change, so the change " +
          "was NOT applied and will not be re-sent.",
        hint:
          "This client was offline longer than the server's tombstone window " +
          "(24h, or the cell's offline.retention when longer). Make the " +
          "change again, or raise the retention on both sides.",
      };
  }
}

/**
 * Configuration options for the op buffer.

 *  @internal Engine/framework wiring (alpha52 sweep) — not public API.
 */
export interface OpBufferOptions {
  pendingCap?: number;
  /** Called when an op is silently dropped due to capacity limits */
  onDrop?: OpBufferDropCallback;
  /** TTL in ms for stale unconfirmed op eviction (default: SYNC_DEFAULTS.defaultRetention) */
  staleAfter?: number;
  /** Per-cell TTL override in ms — this is how a cell's
   *  `sync: { offline: { retention } }` reaches the eviction rule. Falls back
   *  to `staleAfter` when it returns undefined. */
  staleAfterFor?: (cell: string) => number | undefined;
}

/**
 * Create an op buffer backed by the given storage implementation.

 *  @internal Engine/framework wiring (alpha52 sweep) — not public API.
 */
export function createOpBuffer(
  storage: OpBufferStorage,
  opts?: OpBufferOptions,
): OpBuffer {
  const cap = opts?.pendingCap ?? SYNC_DEFAULTS.pendingCap;
  const onDrop = opts?.onDrop;
  const defaultStaleAfterMs = opts?.staleAfter ??
    parseRetention(SYNC_DEFAULTS.defaultRetention);
  const staleAfterOf = (cell: string): number =>
    opts?.staleAfterFor?.(cell) ?? defaultStaleAfterMs;

  // Evictions since the last `takeEvicted()` — see the interface note. Bounded
  // because a host that never drains it must not grow a list forever: past the
  // bound the oldest entry is forgotten, and the engine is back on its previous
  // behaviour for that one op (one spurious re-sync), never on damage.
  const EVICTED_CAP = SYNC_DEFAULTS.pendingCap;
  let _evicted: { cell: string; id: string }[] = [];

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
        const cutoff = Date.now() - staleAfterOf(op.cell);
        let evictedCount = 0;

        for (const staleOp of staleOps) {
          if (!staleOp._clientTs || staleOp._clientTs > cutoff) continue;
          // Evict this stale op by removing it from storage.
          //
          // These are UNCONFIRMED ops: mutations the user made that never
          // reached the server. Eviction is a deliberate backpressure escape,
          // but it was also completely silent — `onDrop` fired only for the
          // INCOMING op when pruning failed, never for the ones actually
          // thrown away, so the exact offline-queue mutations this subsystem
          // exists to preserve disappeared with nothing to observe.
          await storage.pruneStale(op.cell, staleOp.id);
          // Cell + id, not the op: the payload was just discarded, and
          // keeping a copy of it alive until the next drain would be a second
          // queue nobody asked for.
          _evicted.push({ cell: staleOp.cell, id: staleOp.id });
          if (_evicted.length > EVICTED_CAP) _evicted.shift();
          onDrop?.(staleOp, "stale-evicted");
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

    async confirm(cell: string, opId: string, _serverHlc: HLC) {
      // An ack confirms OUR op — it is NOT a delivery watermark, so it must
      // not touch the catch-up cursor (chaos-suite finding, 2026-07-21). The
      // ack's serverHlc is ≥ every peer op persisted before it, so advancing
      // lastHlc here made the next HLC-fallback catch-up SKIP peer ops the
      // client never received (the response's cursor echo then sealed them
      // above the server_ts cursor — permanent, silent op loss). The cursor
      // advances only on actually delivered data: handleRemoteOp (broadcast
      // stamps) and handleSyncResponse (response ops / reserved-cursor echo,
      // which establishes lastServerTs on the very first sync round).
      await storage.confirmOp(cell, opId);
      // …and let it go. An acked op is dead weight: `getUnconfirmed` filters
      // it out, `requestSync` never re-sends it, `rebase` never replays it.
      // The only thing that dropped one was the backpressure path in `add`,
      // which fires when 500 UNCONFIRMED ops have piled up — i.e. never, for a
      // client whose acks are arriving. So the browser's per-cell document
      // grew for the lifetime of the app, and every single op paid a
      // parse+stringify of the entire history. Worse, the growth has an end:
      // at the origin's quota `setItem` throws, which this storage swallows by
      // design ("degrade to memory-only"), and from that moment the offline
      // queue is not persisted at all — the next offline edits die with the
      // tab, silently. Pruning here bounds the document by the pending cap.
      await storage.pruneConfirmed(cell);
    },

    async getUnconfirmed(cell: string) {
      const ops = await storage.loadOps(cell);
      return ops.filter((o) => !o.confirmed);
    },

    pruneConfirmed: (cell) => storage.pruneConfirmed(cell),
    pruneStale: (cell, opId) => storage.pruneStale(cell, opId),

    takeEvicted(): { cell: string; id: string }[] {
      if (_evicted.length === 0) return [];
      const out = _evicted;
      _evicted = [];
      return out;
    },

    async dropStale(cell, opId) {
      // Read before prune: `onDrop` names the op (cell, action, id), and the
      // storage forgets it on prune. An op the buffer no longer holds (already
      // pruned by a duplicate rejection) is nothing to report.
      const op = (await storage.loadOps(cell)).find((o) => o.id === opId);
      if (!op) return;
      await storage.pruneStale(cell, opId);
      onDrop?.(op, "stale-beyond-retention");
    },
    getMeta: (cell) => storage.loadMeta(cell),
    saveSnapshot: (cell, data) => storage.saveSnapshot(cell, data),
    loadSnapshot: (cell) => storage.loadSnapshot(cell),
    clear: (cell) => storage.clear(cell),
    saveMeta: (cell, data) => storage.saveMeta(cell, data),
  };
}
