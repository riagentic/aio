// src/sync/sync-engine.ts — Client-side CRDT sync orchestrator
import type { HLC, SyncConfig, SyncOp, SyncStatus } from "./types.ts";
import { SYNC_DEFAULTS } from "./types.ts";
import type { OpBuffer } from "./op-buffer.ts";
import { compareHLC, createHLC, type HLClock } from "./hlc.ts";
import { rebase, type SyncReducer } from "./rebase.ts";
import type { SyncConflict } from "./types.ts";

/**
 * Dependencies injected into the client-side sync engine.
 * @experimental Excluded from the 1.0 stability guarantee.
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
  };
}

/**
 * Client-side CRDT sync engine that buffers local ops, rebases on acks, and manages online/offline state.
 * @experimental Excluded from the 1.0 stability guarantee.
 */
export interface SyncEngine {
  handleLocalAction(
    cell: string,
    action: string,
    payload: unknown,
  ): Promise<void>;
  handleAck(cell: string, opId: string, serverHlc: HLC): Promise<void>;
  handleRemoteOp(op: SyncOp): Promise<void>;
  handleSyncResponse(response: {
    mode: string;
    ops?: SyncOp[];
    rebase?: SyncOp[];
    snapshot?: Record<string, Record<string, unknown>>;
    lowWater: HLC | Record<string, HLC>;
    lastServerTs?: number;
  }): Promise<void>;
  setOnline(online: boolean): void;
  getStatus(cell: string): SyncStatus;
  requestSync(): Promise<void>;
  isSyncCell(cellName: string): boolean;
}

/**
 * Create a client-side sync engine that coordinates op buffering, HLC clocks, and rebase.
 * @experimental Excluded from the 1.0 stability guarantee.
 */
export function createSyncEngine(deps: SyncEngineDeps): SyncEngine {
  let _opCounter = 0;
  const clock: HLClock = createHLC(deps.clientId);
  let online = true;
  const statuses = new Map<string, SyncStatus>();

  // Per-cell async mutex — serializes all state mutations (local, ack, remote, sync)
  const _locks = new Map<string, Promise<void>>();

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
          deps.send(
            JSON.stringify({ __op: { id, hlc, cell, action, payload } }),
          );
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
          const next = deps.reducer(confirmed, pending.action, pending.payload);
          // Reducer contract: null = no-op. undefined is treated as a bug.
          if (next === undefined) {
            console.warn(
              `[aio:sync] reducer returned undefined for action "${pending.action}" in cell "${cell}". Expected state object or null.`,
            );
          } else if (next !== null) {
            deps.setConfirmedState(cell, next);
          }
        }
        await deps.buffer.confirm(cell, opId, serverHlc);
        await rebaseCell(cell);
        updateStatus(cell, { lastSync: Date.now() });
      });
    },

    handleRemoteOp(op) {
      if (!this.isSyncCell(op.cell)) return Promise.resolve();
      return withLock(op.cell, async () => {
        clock.receive(op.hlc);
        const confirmed = deps.getConfirmedState()[op.cell] ?? {};
        const next = deps.reducer(confirmed, op.action, op.payload);
        if (next === undefined) {
          console.warn(
            `[aio:sync] reducer returned undefined for action "${op.action}" in cell "${op.cell}". Expected state object or null.`,
          );
        } else if (next !== null) {
          deps.setConfirmedState(op.cell, next);
        }
        // Advance lastHlc cursor for remote broadcasted ops
        const meta = await deps.buffer.getMeta(op.cell);
        if (!meta?.lastHlc || compareHLC(op.hlc, meta.lastHlc) > 0) {
          await deps.buffer.saveMeta(op.cell, { lastHlc: op.hlc });
        }
        const optimistic = await rebaseCell(op.cell);

        // Conflict reporting: a field the remote op changed that surviving
        // local (unconfirmed) ops still override. The engine's semantics are
        // rebase-LWW — local replays on top — so `local` is what the user
        // sees and `remote` is the confirmed value underneath.
        const onConflict = deps.cells[op.cell]?.onConflict;
        if (onConflict && next && next !== null) {
          const after = next as Record<string, unknown>;
          const conflicts: SyncConflict[] = [];
          for (const field of Object.keys(after)) {
            const remoteChanged = confirmed[field] !== after[field];
            const localOverrides = after[field] !== optimistic[field];
            if (remoteChanged && localOverrides) {
              conflicts.push({
                field,
                local: optimistic[field],
                remote: after[field],
                resolution: "lww",
              });
            }
          }
          if (conflicts.length > 0) {
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
              const confirmed = deps.getConfirmedState()[cell] ?? {};
              const next = deps.reducer(confirmed, op.action, op.payload);
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
            await deps.buffer.saveMeta(cell, {
              lastHlc: newLastHlc,
              lastServerTs: response.lastServerTs,
            });
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
        deps.send(JSON.stringify({
          __sync: {
            clientId: deps.clientId,
            cells,
            pendingOps: allPending,
          },
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
