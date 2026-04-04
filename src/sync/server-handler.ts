// src/sync/server-handler.ts — Server-side CRDT sync relay
// Receives ops from clients, persists to op-log, broadcasts to other clients, sends acks.

import type { DB } from "../db/types.ts";
import type { HLC, SyncOp } from "./types.ts";
import { createHLC, type HLClock } from "./hlc.ts";
import { compactSyncOps } from "./compact.ts";

/** Dependencies injected into the server-side sync handler. */
export interface SyncHandlerDeps {
  db: DB;
  syncFeatureIds: string[];
  getFeatureState: (feature: string) => Record<string, unknown>;
  /** Send raw message to all connected clients except the given socket.
   *  Mutable ref: set after server creation to break circular dependency. */
  broadcastRaw: { fn: (msg: string, exclude?: WebSocket) => void };
  log: {
    debug: (msg: string, data?: Record<string, unknown>) => void;
    warn: (msg: string, data?: Record<string, unknown>) => void;
    error: (msg: string, data?: Record<string, unknown>) => void;
  };
}

/** Server-side handler that persists ops, sends acks, and broadcasts to peers. */
export interface ServerSyncHandler {
  handleOp: (
    op: unknown,
    meta: { id: string; user?: unknown },
    socket: WebSocket,
  ) => void;
  handleSync: (
    sync: unknown,
    meta: { id: string; user?: unknown },
    socket: WebSocket,
  ) => void;
}

/** Create a server-side sync handler that relays CRDT ops between clients. */
export function createServerSyncHandler(
  deps: SyncHandlerDeps,
): ServerSyncHandler {
  const clock: HLClock = createHLC("server");
  const features = new Set(deps.syncFeatureIds);

  async function persistOp(op: {
    id: string;
    hlc: HLC;
    feature: string;
    action: string;
    payload: unknown;
  }): Promise<void> {
    const [hlcPhys, hlcCnt, hlcNode] = op.hlc;
    await deps.db.execute(
      `INSERT OR IGNORE INTO sync_ops (id, feature, action, payload, hlc_phys, hlc_cnt, hlc_node, server_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        op.id,
        op.feature,
        op.action,
        JSON.stringify(op.payload),
        hlcPhys,
        hlcCnt,
        hlcNode,
        Date.now(),
      ],
    );
  }

  async function loadOpsSince(
    feature: string,
    hlc: HLC | null,
  ): Promise<SyncOp[]> {
    if (!hlc) {
      // No last HLC — return all ops for this feature
      const { rows } = await deps.db.query<{
        id: string;
        feature: string;
        action: string;
        payload: string;
        hlc_phys: number;
        hlc_cnt: number;
        hlc_node: string;
      }>(
        `SELECT id, feature, action, payload, hlc_phys, hlc_cnt, hlc_node
         FROM sync_ops WHERE feature = ? ORDER BY hlc_phys, hlc_cnt`,
        [feature],
      );
      return rows.map((r) => ({
        id: r.id,
        feature: r.feature,
        action: r.action,
        payload: JSON.parse(r.payload),
        hlc: [r.hlc_phys, r.hlc_cnt, r.hlc_node] as HLC,
        confirmed: true,
      }));
    }

    const [phys, cnt] = hlc;
    const { rows } = await deps.db.query<{
      id: string;
      feature: string;
      action: string;
      payload: string;
      hlc_phys: number;
      hlc_cnt: number;
      hlc_node: string;
    }>(
      `SELECT id, feature, action, payload, hlc_phys, hlc_cnt, hlc_node
       FROM sync_ops WHERE feature = ?
       AND (hlc_phys > ? OR (hlc_phys = ? AND hlc_cnt > ?))
       ORDER BY hlc_phys, hlc_cnt`,
      [feature, phys, phys, cnt],
    );
    return rows.map((r) => ({
      id: r.id,
      feature: r.feature,
      action: r.action,
      payload: JSON.parse(r.payload),
      hlc: [r.hlc_phys, r.hlc_cnt, r.hlc_node] as HLC,
      confirmed: true,
    }));
  }

  async function getLowWater(
    feature: string,
  ): Promise<HLC | null> {
    const { rows } = await deps.db.query<{ low_water: string }>(
      "SELECT low_water FROM sync_meta WHERE feature = ?",
      [feature],
    );
    if (!rows[0]) return null;
    try {
      return JSON.parse(rows[0].low_water) as HLC;
    } catch {
      return null;
    }
  }

  async function tryCompact(feature: string): Promise<void> {
    try {
      await compactSyncOps({
        db: deps.db,
        feature,
        getState: () => deps.getFeatureState(feature),
        serverHlc: clock.now(),
        log: deps.log,
      });
    } catch (e) {
      deps.log.error(`[sync:server] compact failed for ${feature}: ${e}`);
    }
  }

  return {
    handleOp(raw, meta, socket) {
      const op = raw as {
        id: string;
        hlc: HLC;
        feature: string;
        action: string;
        payload: unknown;
      };

      if (!features.has(op.feature)) {
        deps.log.warn(
          `[sync:server] op for unknown feature "${op.feature}" — dropping`,
        );
        return;
      }

      // Update server clock
      clock.receive(op.hlc);
      const serverHlc = clock.tick();

      // Persist → ack → broadcast (fire-and-forget with error logging)
      persistOp(op).then(() => {
        // Send ack to originator
        try {
          socket.send(JSON.stringify({
            __ack: { feature: op.feature, opId: op.id, serverHlc },
          }));
        } catch {
          // Client disconnected
        }

        // Broadcast to other clients
        deps.broadcastRaw.fn(
          JSON.stringify({
            __op: {
              id: op.id,
              hlc: op.hlc,
              feature: op.feature,
              action: op.action,
              payload: op.payload,
            },
          }),
          socket,
        );

        // Try compaction in background
        tryCompact(op.feature);
      }).catch((e) => {
        deps.log.error(`[sync:server] failed to persist op ${op.id}: ${e}`);
      });

      deps.log.debug(
        `[sync:server] op ${op.id} from ${meta.id} for ${op.feature}:${op.action}`,
      );
    },

    handleSync(raw, _meta, socket) {
      const sync = raw as {
        clientId: string;
        features: Record<string, { lastHlc: HLC | null }>;
        pendingOps: SyncOp[];
      };

      (async () => {
        // Process pending ops from client first
        for (const op of sync.pendingOps ?? []) {
          if (!features.has(op.feature)) continue;
          clock.receive(op.hlc);
          await persistOp({
            id: op.id,
            hlc: op.hlc,
            feature: op.feature,
            action: op.action,
            payload: op.payload,
          });
        }

        // Build response per feature
        const responseOps: SyncOp[] = [];
        let useSnapshot = false;
        const snapshot: Record<string, Record<string, unknown>> = {};
        let lowWater: HLC = clock.now();

        for (
          const [feature, { lastHlc }] of Object.entries(
            sync.features ?? {},
          )
        ) {
          if (!features.has(feature)) continue;

          const featureLowWater = await getLowWater(feature);
          if (featureLowWater) {
            lowWater = featureLowWater;
          }

          // Check if client's lastHlc is older than low_water (compacted away)
          if (
            featureLowWater && lastHlc &&
            (lastHlc[0] < featureLowWater[0] ||
              (lastHlc[0] === featureLowWater[0] &&
                lastHlc[1] < featureLowWater[1]))
          ) {
            // Client is too far behind — send snapshot
            useSnapshot = true;
            snapshot[feature] = deps.getFeatureState(feature);
          } else {
            // Incremental — send ops since client's lastHlc
            const ops = await loadOpsSince(feature, lastHlc);
            responseOps.push(...ops);
          }
        }

        // Send response
        const response = useSnapshot
          ? {
            __sync: {
              mode: "snapshot" as const,
              snapshot,
              ops: responseOps,
              lowWater,
            },
          }
          : {
            __sync: {
              mode: "incremental" as const,
              ops: responseOps,
              lowWater,
            },
          };

        try {
          socket.send(JSON.stringify(response));
        } catch {
          // Client disconnected
        }

        deps.log.debug(
          `[sync:server] sync response: ${response.__sync.mode}, ${responseOps.length} ops`,
        );
      })().catch((e) => {
        deps.log.error(`[sync:server] handleSync failed: ${e}`);
      });
    },
  };
}
