// Broadcast subsystem — sends state updates to all connected WS clients
// Handles throttling, patch compaction, backpressure, full-state fallback
import { compactPatches } from "../state/patch-compact.ts";
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

  let broadcastQueued = false;
  let broadcastDirty = false;
  let broadcastThrottle: ReturnType<typeof setTimeout> | null = null;
  let _bufferedPatches: PatchEntry[] = [];

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

  /** Coalesced + throttled broadcast — batches synchronous bursts via microtask */
  function broadcast(patches?: PatchEntry[]): void {
    broadcastDirty = true;
    if (patches) _bufferedPatches.push(...patches);

    if (broadcastQueued) return;
    if (syncIntervalMs > 0 && broadcastThrottle) return;

    broadcastQueued = true;
    const patchesToSend = _bufferedPatches;
    _bufferedPatches = [];
    // Audit F-6: reset dirty BEFORE scheduling the microtask so any broadcast()
    // call between now and the throttle callback re-arms it. Resetting inside
    // the microtask (the previous behavior) raced with re-entrant broadcast()
    // calls and dropped patches that arrived in the schedule→run gap; the next
    // throttle callback then saw dirty=false and the buffered patches sat
    // indefinitely until something else triggered a broadcast.
    broadcastDirty = false;

    queueMicrotask(() => {
      broadcastQueued = false;
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

          if (patchesToSend.length > 0) {
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

      if (syncIntervalMs > 0) {
        broadcastThrottle = setTimeout(() => {
          broadcastThrottle = null;
          if (broadcastDirty) broadcast();
        }, syncIntervalMs);
      }
    });
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
    if (broadcastThrottle) {
      clearTimeout(broadcastThrottle);
      broadcastThrottle = null;
    }
  }

  return { broadcast, broadcastTT, broadcastRaw, shutdown };
}
