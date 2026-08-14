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
     *  under backpressure. It never reached the server — this is the app's one
     *  chance to know a local mutation was abandoned. */
    reason: "buffer-full" | "prune-failed" | "stale-evicted",
  ): void;
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
    getMeta: (cell) => storage.loadMeta(cell),
    saveSnapshot: (cell, data) => storage.saveSnapshot(cell, data),
    loadSnapshot: (cell) => storage.loadSnapshot(cell),
    clear: (cell) => storage.clear(cell),
    saveMeta: (cell, data) => storage.saveMeta(cell, data),
  };
}
