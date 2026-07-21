// src/sync/sync-engine.ts — Client-side CRDT sync orchestrator
import { enc } from "../protocol/envelope.ts";
import type { HLC, SyncConfig, SyncOp, SyncStatus } from "./types.ts";
import { SYNC_DEFAULTS } from "./types.ts";
import type { OpBuffer } from "./op-buffer.ts";
import { compareHLC, createHLC, type HLClock } from "./hlc.ts";
import { rebase, type SyncReducer } from "./rebase.ts";
import type { SyncConflict } from "./types.ts";
import { mergeField } from "./merge.ts";

/**
 * Dependencies injected into the client-side sync engine.
 */
export interface SyncEngineDeps {
  clientId: string;
  cells: Record<string, SyncConfig>;
  buffer: OpBuffer;
  send: (msg: string) => void;
  reducer: SyncReducer;
  getConfirmedState: () => Record<string, Record<string, unknown>>;
  /** Update confirmed state for a cell — called on remote ops and snapshots */
  setConfirmedState: (cell: string, state: Record<string, unknown>) => void;
  onStateUpdate: (cell: string, optimistic: Record<string, unknown>) => void;
  log?: {
    warn: (msg: string) => void;
    /** Observe-only dedup visibility — a dropped duplicate hints at a cursor
     *  bug upstream and must be visible in dev, never silent. */
    debug?: (msg: string) => void;
  };
}

/**
 * Client-side CRDT sync engine that buffers local ops, rebases on acks, and manages online/offline state.
 */
export interface SyncEngine {
  handleLocalAction(
    cell: string,
    action: string,
    payload: unknown,
  ): Promise<void>;
  handleAck(cell: string, opId: string, serverHlc: HLC): Promise<void>;
  /** D11: the server refused this op — drop it, rebase (optimistic view
   *  snaps back), log loudly, surface via the cell's sync.onRejected. */
  handleRejection(cell: string, opId: string, reason: string): Promise<void>;
  handleRemoteOp(op: SyncOp): Promise<void>;
  handleSyncResponse(response: {
    mode: string;
    ops?: SyncOp[];
    rebase?: SyncOp[];
    snapshot?: Record<string, Record<string, unknown>>;
    lowWater: HLC | Record<string, HLC>;
    /** Per-cell server_ts cursor echoed by the server. */
    lastServerTs?: Record<string, number>;
  }): Promise<void>;
  setOnline(online: boolean): void;
  getStatus(cell: string): SyncStatus;
  requestSync(): Promise<void>;
  isSyncCell(cellName: string): boolean;
}

/**
 * Create a client-side sync engine that coordinates op buffering, HLC clocks, and rebase.
 */
export function createSyncEngine(deps: SyncEngineDeps): SyncEngine {
  let _opCounter = 0;
  const clock: HLClock = createHLC(deps.clientId);
  let online = true;
  const statuses = new Map<string, SyncStatus>();

  // Per-cell async mutex — serializes all state mutations (local, ack, remote, sync)
  const _locks = new Map<string, Promise<void>>();

  // ── Op-id dedup (defense-in-depth) ────────────────────────────────────
  // The server_ts cursor is the PRIMARY re-delivery guard; this set catches
  // what the cursor cannot: an op racing in via broadcast while a catch-up
  // response that also contains it is already in flight, a duplicated sync
  // request producing two overlapping responses, or re-ordered responses.
  // BOUND: per-cell FIFO set capped at APPLIED_IDS_CAP ids (≈2048 × ~40 B ≈
  // 80 KB per cell worst case; cells are limited to the app's sync cells).
  // Eviction is safe: an id only needs to outlive the overlap window between
  // a broadcast and the catch-up rounds that could re-deliver it (a few
  // response batches, each ≤ pendingCap ops). Once evicted, cursor
  // correctness governs again — the set never becomes load-bearing.
  const APPLIED_IDS_CAP = 2048;
  const _appliedIds = new Map<string, Set<string>>();
  function alreadyApplied(cell: string, id: string): boolean {
    return _appliedIds.get(cell)?.has(id) ?? false;
  }
  function markApplied(cell: string, id: string): void {
    let set = _appliedIds.get(cell);
    if (!set) {
      set = new Set();
      _appliedIds.set(cell, set);
    }
    set.add(id);
    if (set.size > APPLIED_IDS_CAP) {
      // Sets iterate in insertion order — evict the oldest id.
      set.delete(set.values().next().value!);
    }
  }
  // Observe-only (dev/prod-equivalency doctrine): dropping a duplicate is
  // correct in prod AND worth seeing in dev — it means a duplicate got past
  // the cursor. Never silent state damage.
  function logDuplicate(cell: string, id: string, via: string): void {
    deps.log?.debug?.(
      `[sync] ${cell}: duplicate op ${id} dropped (${via}) — already applied`,
    );
  }

  // A buggy reducer that returns undefined does so for EVERY op of that
  // action — warn once per cell:action instead of flooding on every ack/op.
  const _warnedUndef = new Set<string>();
  function _warnUndefReducer(cell: string, action: string): void {
    const key = `${cell}:${action}`;
    if (_warnedUndef.has(key)) return;
    _warnedUndef.add(key);
    console.warn(
      `[aio:sync] reducer returned undefined for action "${action}" in cell "${cell}". Expected state object or null. (logged once)`,
    );
  }

  for (const cell of Object.keys(deps.cells)) {
    statuses.set(cell, { status: "online", pending: 0, lastSync: 0 });
  }

  function updateStatus(cell: string, patch: Partial<SyncStatus>) {
    const current = statuses.get(cell);
    if (!current) return;
    statuses.set(cell, { ...current, ...patch });
  }

  /** Serialize async work per cell to prevent interleaved state. */
  function withLock(cell: string, fn: () => Promise<void>): Promise<void> {
    const prev = _locks.get(cell) ?? Promise.resolve();
    const next = prev.then(fn, fn).finally(() => {
      // Clean up completed lock entry to prevent unbounded memory growth.
      // Only remove if this promise is still the current one (no new work queued).
      if (_locks.get(cell) === next) {
        _locks.delete(cell);
      }
    });
    _locks.set(cell, next);
    return next;
  }

  async function rebaseCell(cell: string): Promise<Record<string, unknown>> {
    const confirmedState = deps.getConfirmedState()[cell] ?? {};
    const unconfirmed = await deps.buffer.getUnconfirmed(cell);
    const result = rebase(confirmedState, unconfirmed, deps.reducer);
    deps.onStateUpdate(cell, result.optimistic);
    updateStatus(cell, { pending: result.surviving.length });
    return result.optimistic;
  }

  return {
    handleLocalAction(cell, action, payload) {
      return withLock(cell, async () => {
        const hlc = clock.tick();
        const id = `${deps.clientId}-${(++_opCounter).toString(36)}`;
        const op: SyncOp = {
          id,
          cell,
          action,
          payload,
          hlc,
          confirmed: false,
          _clientTs: Date.now(),
        };

        // Try to make room by pruning confirmed ops before rejecting
        let accepted = await deps.buffer.add(op);
        if (!accepted) {
          await deps.buffer.pruneConfirmed(cell);
          accepted = await deps.buffer.add(op);
        }
        if (!accepted) {
          updateStatus(cell, { status: "blocked" });
          deps.log?.warn(
            `[sync] ${cell}: op buffer full (pending cap reached) — op dropped. Reconnect or reduce mutation rate.`,
          );
          return;
        }

        await rebaseCell(cell);

        if (online) {
          deps.send(enc("op", { id, hlc, cell, action, payload }));
        }
      });
    },

    handleAck(cell, opId, serverHlc) {
      return withLock(cell, async () => {
        clock.receive(serverHlc);
        // Apply the acked op to confirmed state BEFORE marking it confirmed.
        // Otherwise rebaseCell(confirmed, unconfirmed-without-acked) drops the
        // op's effect from optimistic state — UI snaps back to pre-op value.
        const pending = (await deps.buffer.getUnconfirmed(cell)).find(
          (o) => o.id === opId,
        );
        if (pending) {
          const confirmed = deps.getConfirmedState()[cell] ?? {};
          const next = deps.reducer(
            confirmed,
            pending.action,
            pending.payload,
            cell,
          );
          // Reducer contract: null = no-op. undefined is treated as a bug.
          if (next === undefined) {
            _warnUndefReducer(cell, pending.action);
          } else if (next !== null) {
            deps.setConfirmedState(cell, next);
          }
        }
        await deps.buffer.confirm(cell, opId, serverHlc);
        await rebaseCell(cell);
        updateStatus(cell, { lastSync: Date.now() });
      });
    },

    handleRejection(cell, opId, reason) {
      return withLock(cell, async () => {
        // Drop the rejected op — it will never be confirmed.
        await deps.buffer.pruneStale(cell, opId);
        await rebaseCell(cell);
        // D11: silent rejection is a blank-screen-class bug — always loud.
        console.error(
          `[aio:sync] ${cell}: change rejected by the server — ${reason} ` +
            `(op ${opId}; optimistic view rolled back)`,
        );
        deps.cells[cell]?.onRejected?.({ opId, reason });
        updateStatus(cell, { lastSync: Date.now() });
      });
    },

    handleRemoteOp(op) {
      if (!this.isSyncCell(op.cell)) return Promise.resolve();
      // Self-origin guard (chaos-suite finding, 2026-07-21): a reconnect race
      // can echo our OWN op back as a "remote" broadcast — the server excludes
      // the socket the op arrived on, but after a reconnect we hold a NEW
      // socket, so the exclusion misses. Applying the echo would double the
      // op's effect: once here, once via the sync-ack path (the op is still
      // pending locally). Own ops only ever enter confirmed state through
      // handleAck.
      if (op.hlc[2] === deps.clientId) {
        logDuplicate(op.cell, op.id, "own-op echo");
        return Promise.resolve();
      }
      return withLock(op.cell, async () => {
        clock.receive(op.hlc);
        const meta = await deps.buffer.getMeta(op.cell);
        // Op-id dedup: same op delivered twice (duplicated broadcast, or a
        // broadcast racing a catch-up response that also contains it).
        // Deliberately id-based, NOT `serverTs <= cursor` — a cursor
        // advanced by a LATER op does not prove an earlier op was seen, so a
        // cursor guard could drop a never-applied op under reordered
        // delivery. The id set only skips provably-applied ops.
        const isDup = alreadyApplied(op.cell, op.id);
        const confirmed = deps.getConfirmedState()[op.cell] ?? {};
        let next: Record<string, unknown> | null | undefined = null;
        if (isDup) {
          logDuplicate(op.cell, op.id, "broadcast");
        } else {
          markApplied(op.cell, op.id);
          next = deps.reducer(confirmed, op.action, op.payload, op.cell);
          if (next === undefined) {
            _warnUndefReducer(op.cell, op.action);
          } else if (next !== null) {
            deps.setConfirmedState(op.cell, next);
          }
        }
        // Advance the compaction watermark (lastHlc, never regressing) — the
        // server uses it only to decide snapshot-vs-incremental. Deliberately
        // do NOT advance lastServerTs from broadcast stamps (chaos-suite
        // finding, 2026-07-21): on a fresh connection broadcasts arrive AHEAD
        // of the client's coverage (ops persisted while it was offline are
        // still undelivered), so a stamp jump seals that gap above the cursor
        // — permanent silent loss if the catch-up response is then dropped.
        // The server_ts cursor advances ONLY via a processed sync-res:
        // its reservation echo is self-contained coverage (everything ≤ it
        // was in that response, in a snapshot, or our own). Broadcasts the
        // next catch-up re-delivers are absorbed by the op-id dedup above.
        const lastHlc = !meta?.lastHlc || compareHLC(op.hlc, meta.lastHlc) > 0
          ? op.hlc
          : meta.lastHlc;
        if (lastHlc !== meta?.lastHlc) {
          await deps.buffer.saveMeta(op.cell, {
            lastHlc,
            lastServerTs: meta?.lastServerTs,
          });
        }
        if (isDup) return;
        const optimistic = await rebaseCell(op.cell);

        // Conflict handling: a field the remote op changed that surviving
        // local (unconfirmed) ops still override. Default semantics are
        // rebase-LWW — local replays on top — so `local` is what the user
        // sees and `remote` is the confirmed value underneath. Fields with a
        // configured merge strategy get a CRDT merge applied to the CLIENT
        // VIEW for the conflict window (the server stays the convergence
        // authority — its next snapshot/ack rebase replaces the view).
        const cfg = deps.cells[op.cell];
        const mergeCfg = cfg?.merge ?? {};
        const onConflict = cfg?.onConflict;
        const wantsConflictWork = onConflict !== undefined ||
          Object.keys(mergeCfg).length > 0;
        if (wantsConflictWork && next != null) {
          const after = next as Record<string, unknown>;
          const conflicts: SyncConflict[] = [];
          let mergedView: Record<string, unknown> | null = null;
          // Local-side timestamp for merges: the newest surviving local op.
          const unconfirmed = await deps.buffer.getUnconfirmed(op.cell);
          const localHlc = unconfirmed.reduce(
            (m: HLC | null, o) =>
              m === null || compareHLC(o.hlc, m) > 0 ? o.hlc : m,
            null,
          ) ?? clock.now();
          for (const field of Object.keys(after)) {
            const remoteChanged = confirmed[field] !== after[field];
            const localOverrides = after[field] !== optimistic[field];
            if (!remoteChanged || !localOverrides) continue;
            const strategy = mergeCfg[field] ?? "lww";
            if (strategy !== "lww") {
              try {
                const m = mergeField(
                  strategy,
                  optimistic[field],
                  localHlc,
                  after[field],
                  op.hlc,
                  confirmed[field],
                  cfg?.identity?.[field] ?? "id",
                );
                mergedView ??= { ...optimistic };
                mergedView[field] = m.value;
              } catch (e) {
                deps.log?.warn(
                  `[sync] ${op.cell}.${field}: ${strategy} merge failed (${e}) — keeping rebase-LWW view`,
                );
              }
            }
            conflicts.push({
              field,
              local: optimistic[field],
              remote: after[field],
              resolution: strategy,
            });
          }
          if (mergedView) deps.onStateUpdate(op.cell, mergedView);
          if (conflicts.length > 0 && onConflict) {
            try {
              onConflict(conflicts);
            } catch (e) {
              deps.log?.warn(`[sync] onConflict callback threw: ${e}`);
            }
          }
        }
      });
    },

    async handleSyncResponse(response) {
      // Receive HLCs into global clock (safe outside per-cell lock)
      if (response.ops) {
        for (const op of response.ops) clock.receive(op.hlc);
      }
      if (response.rebase) {
        for (const op of response.rebase) clock.receive(op.hlc);
      }

      // Collect snapshot work per cell
      const snapshots = new Map<string, Record<string, unknown>>();
      if (response.mode === "snapshot" && response.snapshot) {
        for (const [f, s] of Object.entries(response.snapshot)) {
          snapshots.set(f, s);
        }
      }

      // Group ops by cell
      const opsByCell = new Map<string, SyncOp[]>();
      if (response.ops) {
        for (const op of response.ops) {
          const list = opsByCell.get(op.cell) ?? [];
          list.push(op);
          opsByCell.set(op.cell, list);
        }
      }

      // Resolve per-cell lowWater (supports both single HLC and per-cell map)
      const lw = response.lowWater;
      const isPerCell = lw && !Array.isArray(lw) && typeof lw === "object";
      const getLW = (f: string): HLC =>
        isPerCell ? (lw as Record<string, HLC>)[f] ?? clock.now() : lw as HLC;

      // Process each affected cell: snapshot → ops → rebase (all under one lock)
      const affected = new Set([...snapshots.keys(), ...opsByCell.keys()]);
      for (const cell of affected) {
        await withLock(cell, async () => {
          const snap = snapshots.get(cell);
          if (snap) {
            deps.setConfirmedState(cell, snap);
            await deps.buffer.saveSnapshot(cell, {
              state: snap,
              hlc: getLW(cell),
            });
          }
          let newLastHlc: HLC | null = null;
          if (snap) newLastHlc = getLW(cell);
          const ops = opsByCell.get(cell);
          if (ops) {
            for (const op of ops) {
              // Self-origin guard — the server filters our own ops from the
              // catch-up echo, but keep the invariant local too: own ops only
              // enter confirmed state via handleAck (see handleRemoteOp).
              if (op.hlc[2] === deps.clientId) {
                logDuplicate(cell, op.id, "own-op in catch-up");
                continue;
              }
              // Dedup: the op may already have arrived via broadcast while
              // our sync-req (sent with an older cursor) was in flight
              // — the response then contains it a second time. Skipping the
              // re-apply is the fix for that race; the cursor still advances
              // below (the op IS covered).
              if (alreadyApplied(cell, op.id)) {
                logDuplicate(cell, op.id, "catch-up");
                continue;
              }
              markApplied(cell, op.id);
              const confirmed = deps.getConfirmedState()[cell] ?? {};
              const next = deps.reducer(
                confirmed,
                op.action,
                op.payload,
                op.cell,
              );
              if (next !== null) deps.setConfirmedState(cell, next);
            }
            const firstHlc = ops[0]?.hlc;
            if (firstHlc) {
              const highest = ops.reduce(
                (m: HLC, o) => compareHLC(o.hlc, m) > 0 ? o.hlc : m,
                firstHlc,
              );
              if (!newLastHlc || compareHLC(highest, newLastHlc) > 0) {
                newLastHlc = highest;
              }
            }
          }
          if (newLastHlc) {
            // Per-cell cursor from the server; preserve the stored one when
            // the response doesn't cover this cell — overwriting with
            // undefined would regress to the ambiguous HLC cursor and cause
            // re-delivery (double-apply through the reducer). NEVER regress
            // either cursor: two in-flight sync responses delivered out of
            // order would otherwise rewind lastServerTs and re-deliver every
            // op between the two cursors on the next catch-up.
            const prev = await deps.buffer.getMeta(cell);
            const lastHlc =
              prev?.lastHlc && compareHLC(prev.lastHlc, newLastHlc) > 0
                ? prev.lastHlc
                : newLastHlc;
            const respTs = response.lastServerTs?.[cell];
            const lastServerTs =
              respTs != null && respTs > (prev?.lastServerTs ?? 0)
                ? respTs
                : prev?.lastServerTs;
            await deps.buffer.saveMeta(cell, { lastHlc, lastServerTs });
          }
          const s = statuses.get(cell);
          if (s?.status === "blocked") return;
          updateStatus(cell, { status: "syncing" });
          await rebaseCell(cell);
          updateStatus(cell, {
            status: online ? "online" : "offline",
            lastSync: Date.now(),
          });
        });
      }

      // Cells the server echoed a cursor for but delivered nothing (e.g. the
      // only above-cursor ops were our own, filtered from the echo): advance
      // the stored cursor anyway — otherwise it stalls and the server
      // re-loads + re-filters those ops every round. Never regress.
      for (const [cell, ts] of Object.entries(response.lastServerTs ?? {})) {
        if (affected.has(cell)) continue;
        await withLock(cell, async () => {
          const prev = await deps.buffer.getMeta(cell);
          if (ts > (prev?.lastServerTs ?? 0)) {
            await deps.buffer.saveMeta(cell, {
              lastHlc: prev?.lastHlc ?? null,
              lastServerTs: ts,
            });
          }
        });
      }
    },

    setOnline(v) {
      const wasOffline = !online;
      online = v;
      for (const cell of Object.keys(deps.cells)) {
        if (!v) {
          updateStatus(cell, { status: "offline" });
        } else {
          const s = statuses.get(cell);
          if (s?.status === "offline") {
            updateStatus(cell, { status: "online" });
          }
        }
      }
      // Flush queued ops on offline→online transition
      if (v && wasOffline) {
        this.requestSync().catch(() => {
          // Revert to offline if sync request fails
          for (const cell of Object.keys(deps.cells)) {
            const s = statuses.get(cell);
            if (s?.status === "syncing") {
              updateStatus(cell, { status: "offline" });
            }
          }
        });
      }
    },

    getStatus(cell) {
      return statuses.get(cell) ??
        { status: "online", pending: 0, lastSync: 0 };
    },

    async requestSync() {
      if (!online) return; // don't send while offline
      const cells: Record<
        string,
        { lastHlc: HLC | null; lastServerTs?: number }
      > = {};
      const allPending: SyncOp[] = [];

      for (const cell of Object.keys(deps.cells)) {
        const meta = await deps.buffer.getMeta(cell);
        cells[cell] = {
          lastHlc: meta?.lastHlc ?? null,
          lastServerTs: meta?.lastServerTs,
        };
        const unconfirmed = await deps.buffer.getUnconfirmed(cell);
        allPending.push(...unconfirmed.slice(0, SYNC_DEFAULTS.pendingCap));
        updateStatus(cell, { status: "syncing" });
      }

      try {
        deps.send(enc("sync-req", {
          clientId: deps.clientId,
          cells,
          pendingOps: allPending,
        }));
      } catch {
        // Revert status on send failure
        for (const cell of Object.keys(deps.cells)) {
          const s = statuses.get(cell);
          if (s?.status === "syncing") {
            updateStatus(cell, { status: online ? "online" : "offline" });
          }
        }
      }
    },

    isSyncCell(cellName) {
      return cellName in deps.cells;
    },
  };
}
