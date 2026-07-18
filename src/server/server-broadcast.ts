// Broadcast subsystem — sends state updates to all connected WS clients
// Handles throttling, patch compaction, backpressure, full-state fallback
import { compactPatches } from "../state/patch-compact.ts";
import { createCoalescer } from "./broadcast-coalescer.ts";
import {
  filterPatchesBySubs,
  filterStateBySubs,
  type PatchEntry,
} from "../protocol/broadcast-utils.ts";
import type { ClientMeta } from "./server-ws.ts";
import type { VitalsSystem } from "../vitals/mod.ts";
import type { AioUser } from "./aio.ts";

/** Payload stats per client — tracked for vitals/trojan introspection */
export type PayloadStats = Map<
  string,
  { lastPayloadBytes: number; totalBytes: number; count: number }
>;

/** Dependencies injected from server.ts closure */
export interface BroadcastDeps {
  connections: Map<WebSocket, ClientMeta>;
  payloadStats: PayloadStats;
  getUIState: (user?: AioUser) => unknown;
  debug: (msg: string) => void;
  syncIntervalMs: number;
  /** 0–1: send full state when the patch payload exceeds this fraction of the
   *  full-state payload size. Default 0.5 (patch > 50% of full → send full). */
  fullStateThreshold?: number;
  vitalsSystem?: VitalsSystem;
  getTTBroadcast?: () => unknown;
}

/** Public API returned by createBroadcaster */
export interface Broadcaster {
  broadcast: (patches?: PatchEntry[]) => void;
  broadcastTT: () => void;
  broadcastRaw: (msg: string, exclude?: WebSocket) => void;
  shutdown: () => void;
}

/** Factory — creates an isolated broadcast subsystem with its own throttle state */
export function createBroadcaster(deps: BroadcastDeps): Broadcaster {
  const {
    connections,
    payloadStats,
    getUIState,
    debug,
    syncIntervalMs,
    vitalsSystem,
    getTTBroadcast,
  } = deps;
  const fullStateThreshold = deps.fullStateThreshold ?? 0.5;

  /** Get filtered full-state JSON for a client (respects subscriptions) */
  function _getFilteredFullJson(meta: ClientMeta): string | undefined {
    try {
      const uiState = filterStateBySubs(
        getUIState(meta.user),
        meta.subscriptions,
      );
      return JSON.stringify(uiState);
    } catch (e) {
      debug(`broadcast: getUIState error — ${e}`);
      return undefined;
    }
  }

  // Both the WS and UDS broadcasters coalesce through the SAME primitive
  // (createCoalescer) so their throttle + never-drop buffer can never diverge —
  // the class of bug behind risoto 2026-07-19 (UDS dropped patches while WS
  // buffered them). The coalescer owns timing + buffering; this flush owns the
  // WS-specific per-client send. `force` (a full-strategy cell changed → only
  // expressible as full state) skips the patch path so its change is never lost.
  const flushBroadcast = (
    patchesToSend: PatchEntry[],
    force: boolean,
  ): void => {
    try {
      for (const [ws, meta] of connections) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        if (vitalsSystem?.serverTransport.isFrozen(meta.id)) continue;
        if (meta.bpMultiplier > 1) {
          const elapsed = Date.now() - meta.bpLastSentAt;
          if (elapsed < syncIntervalMs * meta.bpMultiplier) {
            meta.lastFullJson = undefined;
            continue;
          }
        }

        let msgToSend: string | undefined;
        let fullJsonForTracking: string | undefined;

        if (!force && patchesToSend.length > 0) {
          const clientPatches = filterPatchesBySubs(
            patchesToSend,
            meta.subscriptions,
          );
          const allOps = compactPatches(
            clientPatches.flatMap((p) =>
              p.ops.map((op) => ({
                ...op,
                path: [p.cell, ...op.path],
              }))
            ),
          );
          if (allOps.length > 0) {
            const patchJson = JSON.stringify({ $patches: allOps });
            fullJsonForTracking = _getFilteredFullJson(meta);
            // Send full state when the patch payload exceeds the configured
            // fraction of the full-state size (default 0.5 → patch > 50%).
            // Previously this compared against 100% of full state, so the
            // user-set `fullStateThreshold` had no effect.
            if (
              fullJsonForTracking &&
              patchJson.length >
                fullJsonForTracking.length * fullStateThreshold
            ) {
              debug?.(
                `broadcast: patch payload (${patchJson.length}B) > ${
                  fullStateThreshold * 100
                }% of full state (${fullJsonForTracking.length}B) — sending full state`,
              );
              if (fullJsonForTracking !== meta.lastFullJson) {
                msgToSend = fullJsonForTracking;
              }
            } else {
              msgToSend = patchJson;
            }
          }
        }

        if (!msgToSend) {
          // Reuse the full-json computed above when available instead of
          // re-serializing per-client (N clients → N full serializations
          // per broadcast otherwise).
          fullJsonForTracking ??= _getFilteredFullJson(meta);
          if (!fullJsonForTracking) continue;
          if (fullJsonForTracking === meta.lastFullJson) continue;
          msgToSend = fullJsonForTracking;
        }

        if (!msgToSend) continue;
        try {
          ws.send(msgToSend);
          if (fullJsonForTracking) meta.lastFullJson = fullJsonForTracking;
          meta.bpLastSentAt = Date.now();
          vitalsSystem?.serverTransport.onClientStateSent(
            meta.id,
            Date.now(),
          );
          const _bytes = new TextEncoder().encode(msgToSend).byteLength;
          const _ps = payloadStats.get(meta.id);
          if (_ps) {
            _ps.lastPayloadBytes = _bytes;
            _ps.totalBytes += _bytes;
            _ps.count++;
          } else {
            payloadStats.set(meta.id, {
              lastPayloadBytes: _bytes,
              totalBytes: _bytes,
              count: 1,
            });
          }
          vitalsSystem?.pressureMonitor?.onBroadcast(meta.id, _bytes);
        } catch { /* client disconnecting */ }
      }
    } catch (e) {
      debug(`broadcast error: ${e}`);
    }
  };

  const coalescer = createCoalescer<PatchEntry>(syncIntervalMs, flushBroadcast);

  /** Coalesced + throttled broadcast — batches synchronous bursts and buffers
   *  across the throttle window (never drops a patch). No args = full state. */
  function broadcast(patches?: PatchEntry[]): void {
    coalescer.add(patches);
  }

  /** Sends TT metadata to all connected clients */
  function broadcastTT(): void {
    if (!getTTBroadcast) return;
    try {
      const ttData = "__tt:" + JSON.stringify(getTTBroadcast());
      for (const [ws] of connections) {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(ttData);
          } catch { /* client disconnecting */ }
        }
      }
    } catch (e) {
      debug(`broadcastTT error: ${e}`);
    }
  }

  /** Send raw string message to all connected WS clients, optionally excluding one */
  function broadcastRaw(msg: string, exclude?: WebSocket): void {
    for (const [ws] of connections) {
      if (ws === exclude) continue;
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
      } catch { /* ignore send errors */ }
    }
  }

  function shutdown(): void {
    coalescer.dispose();
  }

  return { broadcast, broadcastTT, broadcastRaw, shutdown };
}
