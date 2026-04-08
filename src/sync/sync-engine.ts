// src/sync/sync-engine.ts — Client-side CRDT sync orchestrator
import type { HLC, SyncConfig, SyncOp, SyncStatus } from "./types.ts";
import { SYNC_DEFAULTS } from "./types.ts";
import type { OpBuffer } from "./op-buffer.ts";
import { createHLC, type HLClock } from "./hlc.ts";
import { rebase, type SyncReducer } from "./rebase.ts";

/** Dependencies injected into the client-side sync engine. */
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

/** Client-side CRDT sync engine that buffers local ops, rebases on acks, and manages online/offline state. */
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
  }): Promise<void>;
  setOnline(online: boolean): void;
  getStatus(cell: string): SyncStatus;
  requestSync(): Promise<void>;
  isSyncCell(cellName: string): boolean;
}

/** Create a client-side sync engine that coordinates op buffering, HLC clocks, and rebase. */
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
    const next = prev.then(fn, fn); // run even if prev rejected
    _locks.set(cell, next);
    return next;
  }

  async function rebaseCell(cell: string) {
    const confirmedState = deps.getConfirmedState()[cell] ?? {};
    const unconfirmed = await deps.buffer.getUnconfirmed(cell);
    const result = rebase(confirmedState, unconfirmed, deps.reducer);
    deps.onStateUpdate(cell, result.optimistic);
    updateStatus(cell, { pending: result.surviving.length });
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
        if (next !== null) {
          deps.setConfirmedState(op.cell, next);
        }
        await rebaseCell(op.cell);
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
          const ops = opsByCell.get(cell);
          if (ops) {
            for (const op of ops) {
              const confirmed = deps.getConfirmedState()[cell] ?? {};
              const next = deps.reducer(confirmed, op.action, op.payload);
              if (next !== null) deps.setConfirmedState(cell, next);
            }
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
      const cells: Record<string, { lastHlc: HLC | null }> = {};
      const allPending: SyncOp[] = [];

      for (const cell of Object.keys(deps.cells)) {
        const meta = await deps.buffer.getMeta(cell);
        cells[cell] = { lastHlc: meta?.lastHlc ?? null };
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
