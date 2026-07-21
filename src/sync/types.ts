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
 * "op" frame payload: client→server or server→client op (v2: the envelope
 * kind is the discriminator — no wrapper key).
 */
export interface OpMessage {
  id: string;
  hlc: HLC;
  cell: string;
  action: string;
  payload: unknown;
  /** Server-issued cursor stamp (see SyncOp.serverTs). */
  serverTs?: number;
}

/**
 * "op-rejected" frame payload: server→origin-client op rejection (perfect-aio
 * D11 — every rejected change is explainable). Sent INSTEAD of an ack when
 * the server's re-execution refused the op (validate hook / guard); the
 * client drops the op, rebases (optimistic view snaps back), and surfaces
 * the reason.
 */
export interface OpRejectedMessage {
  opId: string;
  cell: string;
  reason: string;
}

/**
 * "sync-ack" frame payload: server→client per-op CRDT ack.
 */
export interface AckMessage {
  cell: string;
  opId: string;
  serverHlc: HLC;
}

/**
 * "sync-req" frame payload: client→server sync request.
 */
export interface SyncRequest {
  clientId: string;
  cells: Record<string, { lastHlc: HLC | null; lastServerTs?: number }>;
  pendingOps: SyncOp[];
}

/**
 * "sync-res" frame payload: ops since the client's cursor. lowWater is a
 * per-cell map when the server tracks multiple cells (see server-handler.ts).
 */
export type SyncResponse =
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
