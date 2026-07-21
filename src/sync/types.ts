// src/sync/types.ts — Shared CRDT types

/**
 * Hybrid Logical Clock: [physical_ms, counter, nodeId]
 */
export type HLC = [physical: number, counter: number, nodeId: string];

/** Merge strategy names */
export type MergeStrategy =
  | "lww"
  | "counter"
  | "lww-per-key"
  | "set-add"
  | "set-remove";

/** Per-cell sync configuration (normalized from sync: true | {...}) */
export interface SyncConfig {
  merge: Record<string, MergeStrategy>;
  identity: Record<string, string>;
  offline: { retention: string };
  onConflict?: (conflicts: SyncConflict[]) => void;
  onSync?: (stats: SyncStats) => void;
  /** Called when the SERVER rejects one of this client's ops (D11) — show
   *  real feedback; the optimistic view has already rolled back. */
  onRejected?: (info: { opId: string; reason: string }) => void;
}

/** Conflict descriptor passed to onConflict callback */
export interface SyncConflict {
  field: string;
  local: unknown;
  remote: unknown;
  resolution: MergeStrategy;
}

/** Stats passed to onSync callback */
export interface SyncStats {
  merged: number;
  conflicts: number;
  elapsed: number;
}

/** Sync status exposed to UI via useCell() */
export interface SyncStatus {
  status: "online" | "offline" | "syncing" | "blocked";
  pending: number;
  lastSync: number;
}

/** A stamped operation in the op-log */
export interface SyncOp {
  id: string;
  cell: string;
  action: string;
  payload: unknown;
  hlc: HLC;
  confirmed: boolean;
  /** Client-side creation timestamp (ms) for TTL-based eviction during backpressure. */
  _clientTs?: number;
  /** Server-issued monotonic timestamp — stamped on server broadcasts so
   *  peers can advance their sync cursor as they apply the op. */
  serverTs?: number;
}

/**
 * Wire message: client→server or server→client op
 */
export interface OpMessage {
  __op: {
    id: string;
    hlc: HLC;
    cell: string;
    action: string;
    payload: unknown;
    /** Server-issued cursor stamp (see SyncOp.serverTs). */
    serverTs?: number;
  };
}

/**
 * Wire message: server→origin-client op rejection (perfect-aio D11 — every
 * rejected change is explainable). Sent INSTEAD of an ack when the server's
 * re-execution refused the op (validate hook / guard); the client drops the
 * op, rebases (optimistic view snaps back), and surfaces the reason.
 */
export interface OpRejectedMessage {
  __op_rejected: { opId: string; cell: string; reason: string };
}

/**
 * Wire message: server→client ack
 */
export interface AckMessage {
  __ack: { opId: string; serverHlc: HLC };
}

/**
 * Wire message: client→server sync request
 */
export interface SyncRequest {
  __sync: {
    clientId: string;
    cells: Record<string, { lastHlc: HLC | null; lastServerTs?: number }>;
    pendingOps: SyncOp[];
  };
}

/** Wire message: server→client sync response.
 *  lowWater is per-cell map when server tracks multiple cells (see server-handler.ts). */
/**
 * Server reply to a `__sync` catch-up request: ops since the client's cursor.
 */
export interface SyncResponse {
  __sync:
    | {
      mode: "incremental";
      ops: SyncOp[];
      rebase?: SyncOp[];
      lowWater: HLC | Record<string, HLC>;
      /** Per-cell server_ts cursor — reserved under each cell's lock, so ops
       *  the client hasn't seen are strictly above it (no re-delivery). */
      lastServerTs?: Record<string, number>;
    }
    | {
      mode: "snapshot";
      snapshot: Record<string, unknown>;
      ops: SyncOp[];
      lowWater: HLC | Record<string, HLC>;
      /** Per-cell server_ts cursor (see incremental). */
      lastServerTs?: Record<string, number>;
    };
}

/** Default sync config values */
export const SYNC_DEFAULTS = {
  maxDrift: 60_000,
  pendingCap: 500,
  compactOps: 1000,
  compactIntervalMs: 3_600_000,
  syncRetryMs: 10_000,
  defaultRetention: "4h",
} as const;

/**
 * Normalize sync: true | SyncConfig → SyncConfig
 */
export function normalizeSyncConfig(
  raw: true | Partial<SyncConfig>,
): SyncConfig {
  if (raw === true) {
    return {
      merge: {},
      identity: {},
      offline: { retention: SYNC_DEFAULTS.defaultRetention },
    };
  }
  return {
    merge: raw.merge ?? {},
    identity: raw.identity ?? {},
    offline: raw.offline ?? { retention: SYNC_DEFAULTS.defaultRetention },
    onConflict: raw.onConflict,
    onSync: raw.onSync,
    onRejected: raw.onRejected,
  };
}
