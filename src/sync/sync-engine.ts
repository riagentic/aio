// src/sync/sync-engine.ts — Client-side CRDT sync orchestrator
import type { HLC, SyncConfig, SyncOp, SyncStatus } from "./types.ts";
import { SYNC_DEFAULTS } from "./types.ts";
import type { OpBuffer } from "./op-buffer.ts";
import { createHLC, type HLClock } from "./hlc.ts";
import { rebase, type SyncReducer } from "./rebase.ts";

/** Dependencies injected into the client-side sync engine. */
export interface SyncEngineDeps {
  clientId: string;
  features: Record<string, SyncConfig>;
  buffer: OpBuffer;
  send: (msg: string) => void;
  reducer: SyncReducer;
  getConfirmedState: () => Record<string, Record<string, unknown>>;
  /** Update confirmed state for a feature — called on remote ops and snapshots */
  setConfirmedState: (feature: string, state: Record<string, unknown>) => void;
  onStateUpdate: (feature: string, optimistic: Record<string, unknown>) => void;
}

/** Client-side CRDT sync engine that buffers local ops, rebases on acks, and manages online/offline state. */
export interface SyncEngine {
  handleLocalAction(
    feature: string,
    action: string,
    payload: unknown,
  ): Promise<void>;
  handleAck(feature: string, opId: string, serverHlc: HLC): Promise<void>;
  handleRemoteOp(op: SyncOp): Promise<void>;
  handleSyncResponse(response: {
    mode: string;
    ops?: SyncOp[];
    rebase?: SyncOp[];
    snapshot?: Record<string, Record<string, unknown>>;
    lowWater: HLC;
  }): Promise<void>;
  setOnline(online: boolean): void;
  getStatus(feature: string): SyncStatus;
  requestSync(): Promise<void>;
  isSyncFeature(featureName: string): boolean;
}

/** Create a client-side sync engine that coordinates op buffering, HLC clocks, and rebase. */
export function createSyncEngine(deps: SyncEngineDeps): SyncEngine {
  let _opCounter = 0;
  const clock: HLClock = createHLC(deps.clientId);
  let online = true;
  const statuses = new Map<string, SyncStatus>();

  // Per-feature async mutex to prevent interleaved handleLocalAction calls
  const _locks = new Map<string, Promise<void>>();

  for (const feature of Object.keys(deps.features)) {
    statuses.set(feature, { status: "online", pending: 0, lastSync: 0 });
  }

  function updateStatus(feature: string, patch: Partial<SyncStatus>) {
    const current = statuses.get(feature);
    if (!current) return;
    statuses.set(feature, { ...current, ...patch });
  }

  /** Serialize async work per feature to prevent interleaved state. */
  function withLock(feature: string, fn: () => Promise<void>): Promise<void> {
    const prev = _locks.get(feature) ?? Promise.resolve();
    const next = prev.then(fn, fn); // run even if prev rejected
    _locks.set(feature, next);
    return next;
  }

  async function rebaseFeature(feature: string) {
    const confirmedState = deps.getConfirmedState()[feature] ?? {};
    const unconfirmed = await deps.buffer.getUnconfirmed(feature);
    const result = rebase(confirmedState, unconfirmed, deps.reducer);
    deps.onStateUpdate(feature, result.optimistic);
    updateStatus(feature, { pending: result.surviving.length });
  }

  return {
    handleLocalAction(feature, action, payload) {
      return withLock(feature, async () => {
        const hlc = clock.tick();
        const id = `${deps.clientId}-${(++_opCounter).toString(36)}`;
        const op: SyncOp = {
          id,
          feature,
          action,
          payload,
          hlc,
          confirmed: false,
        };

        const accepted = await deps.buffer.add(op);
        if (!accepted) {
          updateStatus(feature, { status: "blocked" });
          return;
        }

        await rebaseFeature(feature);

        if (online) {
          deps.send(
            JSON.stringify({ __op: { id, hlc, feature, action, payload } }),
          );
        }
      });
    },

    async handleAck(feature, opId, serverHlc) {
      clock.receive(serverHlc);
      await deps.buffer.confirm(feature, opId, serverHlc);
      await rebaseFeature(feature);
      updateStatus(feature, { lastSync: Date.now() });
    },

    async handleRemoteOp(op) {
      if (!this.isSyncFeature(op.feature)) return;
      clock.receive(op.hlc);

      const confirmed = deps.getConfirmedState()[op.feature] ?? {};
      const next = deps.reducer(confirmed, op.action, op.payload);
      if (next !== null) {
        deps.setConfirmedState(op.feature, next);
      }
      await rebaseFeature(op.feature);
    },

    async handleSyncResponse(response) {
      // Track which features were affected
      const affected = new Set<string>();

      // Apply snapshot to confirmed state before rebase
      if (response.mode === "snapshot" && response.snapshot) {
        for (const [feature, state] of Object.entries(response.snapshot)) {
          deps.setConfirmedState(feature, state);
          await deps.buffer.saveSnapshot(feature, {
            state,
            hlc: response.lowWater,
          });
          affected.add(feature);
        }
      }

      // Apply incremental ops to confirmed state
      if (response.ops) {
        for (const op of response.ops) {
          clock.receive(op.hlc);
          const confirmed = deps.getConfirmedState()[op.feature] ?? {};
          const next = deps.reducer(confirmed, op.action, op.payload);
          if (next !== null) {
            deps.setConfirmedState(op.feature, next);
          }
          affected.add(op.feature);
        }
      }

      if (response.rebase) {
        for (const op of response.rebase) clock.receive(op.hlc);
      }

      // Only rebase affected features; preserve "blocked" status
      for (const feature of affected) {
        const s = statuses.get(feature);
        if (s?.status === "blocked") continue; // don't clear blocked until buffer resolved
        updateStatus(feature, { status: "syncing" });
        await rebaseFeature(feature);
        updateStatus(feature, {
          status: online ? "online" : "offline",
          lastSync: Date.now(),
        });
      }
    },

    setOnline(v) {
      const wasOffline = !online;
      online = v;
      for (const feature of Object.keys(deps.features)) {
        if (!v) {
          updateStatus(feature, { status: "offline" });
        } else {
          const s = statuses.get(feature);
          if (s?.status === "offline") {
            updateStatus(feature, { status: "online" });
          }
        }
      }
      // Flush queued ops on offline→online transition
      if (v && wasOffline) {
        this.requestSync().catch(() => {
          // Revert to offline if sync request fails
          for (const feature of Object.keys(deps.features)) {
            const s = statuses.get(feature);
            if (s?.status === "syncing") {
              updateStatus(feature, { status: "offline" });
            }
          }
        });
      }
    },

    getStatus(feature) {
      return statuses.get(feature) ??
        { status: "online", pending: 0, lastSync: 0 };
    },

    async requestSync() {
      if (!online) return; // don't send while offline
      const features: Record<string, { lastHlc: HLC | null }> = {};
      const allPending: SyncOp[] = [];

      for (const feature of Object.keys(deps.features)) {
        const meta = await deps.buffer.getMeta(feature);
        features[feature] = { lastHlc: meta?.lastHlc ?? null };
        const unconfirmed = await deps.buffer.getUnconfirmed(feature);
        allPending.push(...unconfirmed.slice(0, SYNC_DEFAULTS.pendingCap));
        updateStatus(feature, { status: "syncing" });
      }

      try {
        deps.send(JSON.stringify({
          __sync: {
            clientId: deps.clientId,
            features,
            pendingOps: allPending,
          },
        }));
      } catch {
        // Revert status on send failure
        for (const feature of Object.keys(deps.features)) {
          const s = statuses.get(feature);
          if (s?.status === "syncing") {
            updateStatus(feature, { status: online ? "online" : "offline" });
          }
        }
      }
    },

    isSyncFeature(featureName) {
      return featureName in deps.features;
    },
  };
}
