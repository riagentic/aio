// Broadcast subsystem — sends state updates to all connected WS clients
// Handles throttling, patch compaction, backpressure, full-state fallback
import { enc, encRaw } from "../protocol/envelope.ts";
import { compactPatches } from "../state/patch-compact.ts";
import { createCoalescer } from "./broadcast-coalescer.ts";

/** How often time-travel metadata may go out. Deliberately slower than the
 *  state stream: it feeds a debug panel, and no user action waits on it. */
const TT_THROTTLE_MS = 250;
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
  /** Cost meter (`am cost`) — records the EXACT bytes handed to each socket and,
   *  once per round, which cell/key those bytes came from. Attribution lives
   *  here because this is the only place that knows both. */
  costMeter?: {
    recordAttribution(cell: string, key: string, bytes: number): void;
    setClientCount(n: number): void;
  };
}

/** Public API returned by createBroadcaster */
export interface Broadcaster {
  broadcast: (patches?: PatchEntry[]) => void;
  broadcastTT: () => void;
  broadcastRaw: (msg: string, exclude?: WebSocket) => void;
  /** Interactive priority: drain the coalescer NOW (client-action latency —
   *  see Coalescer.flushUrgent). */
  flushUrgent: () => void;
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
    costMeter,
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
      // Attribution, ONCE per round rather than per client: which cell and which
      // key produced the bytes about to go out. This is the half an app cannot
      // compute for itself — outside the broadcast path nothing knows that
      // `hw.cpuHistory` is 19 KB of the 24 KB/s being pushed. Counting the
      // serialized value per op is work proportional to the patch, which is
      // small by construction; a full resend is attributed as "*" because "the
      // whole slice went" is the finding a reader needs.
      if (costMeter && connections.size > 0) {
        costMeter.setClientCount(connections.size);
      }
      // Did any client receive a whole slice rather than a diff? Attribution has
      // to describe what was SENT: reporting 5 bytes of changed keys while the
      // wire carried an 8 KB full state would be a plausible number that is
      // wrong, and people act on those. Decided per client (subscriptions
      // differ), so it is observed in the loop and attributed once after it.
      let anyFullSend = false;
      let anyPatchSend = false;
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
        // Recorded for `am cost`: a full resend is itself a finding, so the kind
        // is tracked where it is DECIDED rather than sniffed off the wire later.
        let sentKind: "patch" | "full" = "full";

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
            const patchJson = JSON.stringify(allOps);
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
                msgToSend = encRaw("state", fullJsonForTracking);
                sentKind = "full";
              }
            } else {
              msgToSend = encRaw("patches", patchJson);
              sentKind = "patch";
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
          // Anything that decides to send a whole state says WHY. The
          // threshold path above already did; this fallback did not, so the
          // expensive case was the invisible one — 438 KB frames, 28 of them
          // in 20s, and nothing in the log to point at them (risoto,
          // 2026-07-27). Naming the reason is what turns "my app is slow"
          // into a one-line fix.
          debug?.(
            `broadcast: sending full state (${fullJsonForTracking.length}B) — ${
              force
                ? 'a "full"-strategy cell changed (not expressible as a patch)'
                : patchesToSend.length === 0
                ? "the round produced no patches"
                : "no patch matched this client's subscriptions"
            }`,
          );
          msgToSend = encRaw("state", fullJsonForTracking);
        }

        if (!msgToSend) continue;
        try {
          ws.send(msgToSend);
          // NOTE: bytes are NOT recorded here. The socket itself is metered
          // (server-ws.ts wraps `send`), because frames also reach a client from
          // the handshake, per-action acks and diagnostics — counting in both
          // places double-counts, which is exactly what the wire-accuracy test
          // caught. Here we only record WHICH KIND went out, for attribution.
          if (sentKind === "full") anyFullSend = true;
          else anyPatchSend = true;
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

      // ── Attribution, once per round: where did those bytes come from ──
      //
      // The half no app can compute for itself. A patch attributes each changed
      // key's serialized value; a full send attributes the whole slice as "*"
      // with its real size, because "everything went" is the finding — and the
      // number has to match what left the socket, not what merely changed.
      if (costMeter && (anyPatchSend || anyFullSend)) {
        const cells = patchesToSend.length > 0
          ? patchesToSend.map((p) => p.cell)
          : [];
        if (anyFullSend) {
          const ui = getUIState() as Record<string, unknown> | undefined;
          const named = cells.length > 0 ? cells : Object.keys(ui ?? {});
          for (const cell of named) {
            let bytes = 0;
            try {
              bytes = JSON.stringify(ui?.[cell] ?? null)?.length ?? 0;
            } catch {
              /* unserializable — 0 rather than a throw in a hot path */
            }
            costMeter.recordAttribution(cell, "*", bytes);
          }
        }
        if (anyPatchSend && !force) {
          for (const entry of patchesToSend) {
            for (const op of entry.ops) {
              const key = (op.path?.[0] as string | undefined) ?? "*";
              let bytes = 0;
              try {
                bytes = JSON.stringify(op.value ?? null)?.length ?? 0;
              } catch { /* as above */ }
              costMeter.recordAttribution(entry.cell, String(key), bytes);
            }
          }
        }
      }
    } catch (e) {
      debug(`broadcast error: ${e}`);
    }
  };

  const coalescer = createCoalescer<PatchEntry>(syncIntervalMs, flushBroadcast);
  // Same primitive as the patch stream, so TT can never grow a second throttle
  // with different semantics (the asymmetry broadcast-coalescer.ts exists to
  // prevent). Diagnostics pace slower than state: nobody is waiting on it.
  const ttCoalescer = createCoalescer<never>(TT_THROTTLE_MS, flushTT);

  /** Coalesced + throttled broadcast — batches synchronous bursts and buffers
   *  across the throttle window (never drops a patch). No args = full state. */
  function broadcast(patches?: PatchEntry[]): void {
    coalescer.add(patches);
  }

  /** Sends TT metadata to all connected clients.
   *
   *  COALESCED, because this is called once per dispatch and the payload is
   *  the WHOLE action log (capped at 200 entries, ~15 KB) rather than a delta.
   *  A burst of dispatches used to put one full copy on the wire each — on a
   *  quiet wallet that was 99% of everything sent, dwarfing the state patches
   *  the socket exists for. The panel only ever renders the LATEST snapshot,
   *  so every frame but the last was waste. One flush per window instead. */
  let ttPending = false;
  function broadcastTT(): void {
    if (!getTTBroadcast || connections.size === 0) return;
    if (ttPending) return;
    ttPending = true;
    ttCoalescer.add();
  }

  function flushTT(): void {
    ttPending = false;
    if (!getTTBroadcast || connections.size === 0) return;
    try {
      const ttData = enc("tt-state", getTTBroadcast());
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
    ttCoalescer.dispose();
  }

  return {
    broadcast,
    broadcastTT,
    broadcastRaw,
    flushUrgent: () => coalescer.flushUrgent(),
    shutdown,
  };
}
