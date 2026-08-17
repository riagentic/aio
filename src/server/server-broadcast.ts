// Broadcast subsystem — sends state updates to all connected WS clients
// Handles throttling, patch compaction, backpressure, full-state fallback
import { enc, encRaw } from "../protocol/envelope.ts";
import { compactPatches } from "../state/patch-compact.ts";
import { createCoalescer } from "./broadcast-coalescer.ts";

/** How often time-travel metadata may go out. Deliberately slower than the
 *  state stream: it feeds a debug panel, and no user action waits on it. */
const TT_THROTTLE_MS = 250;

/** Full-state frames larger than this get a ONE-TIME warning naming the
 *  offending cell(s) and the right tier — the broadcast-seam mirror of
 *  `PERSIST_CELL_WARN_BYTES` (persistence.ts). Matches the default 1MB WS
 *  frame budget (`wsLimits`): a full state that cannot ride in one frame is
 *  state in the wrong tier. Config knob lands in alpha53 with the persist
 *  thresholds. */
export const BROADCAST_FULL_WARN_BYTES = 1024 * 1024; // 1 MiB
import {
  filterPatchesBySubs,
  filterStateBySubs,
  type PatchEntry,
} from "../protocol/broadcast-utils.ts";
import { degraded } from "../diagnostics/degraded.ts";
import type { ClientMeta } from "./server-ws.ts";
import type { VitalsSystem } from "../vitals/mod.ts";
import type { AioUser } from "./aio.ts";
import { log } from "../diagnostics/logger-api.ts";

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
  /** Late-bound UDS raw-broadcast (electron transport) — tt-state frames used
   *  to reach WS clients only, so the Electron window's time-travel panel
   *  (Ctrl+.) never received a frame and never even bound its shortcut. Set by
   *  aio-server after the UDS listener exists (syncBroadcastRef pattern). */
  udsBroadcastRef?: { fn: ((raw: string) => void) | null };
  /** Cost meter (`am cost`) — records the EXACT bytes handed to each socket and,
   *  once per round, which cell/key those bytes came from. Attribution lives
   *  here because this is the only place that knows both. */
  costMeter?: {
    beginRound(): number;
    recordAttribution(
      cell: string,
      key: string,
      bytes: number,
      round: number,
    ): void;
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
  // One encoder for the byte-stats below — a fresh TextEncoder per send was
  // pure allocation churn on the hottest path in the file.
  const _encoder = new TextEncoder();

  // Big-frame guardrail bookkeeping: one warning per offending cell, and the
  // per-cell breakdown (an extra serialization pass) only runs when the frame
  // has GROWN past everything already analyzed — a chronic offender is
  // analyzed once, not on every round.
  const _warnedBigCells = new Set<string>();
  let _analyzedFrameLen = 0;

  /** One-time warning when a full-state frame exceeds the 1MB budget, naming
   *  the cell(s) responsible and the right tier. Observe-only, identical in
   *  dev and prod — it must never break a send. */
  function _warnBigFullState(json: string, meta: ClientMeta): void {
    if (json.length <= BROADCAST_FULL_WARN_BYTES) return;
    if (json.length <= _analyzedFrameLen) return; // already analyzed this size
    try {
      _analyzedFrameLen = json.length;
      const ui = filterStateBySubs(getUIState(meta.user), meta.subscriptions);
      if (ui === null || typeof ui !== "object") return;
      const sizes = Object.entries(ui as Record<string, unknown>).map(
        ([cellName, v]) => {
          let n = 0;
          try {
            n = JSON.stringify(v)?.length ?? 0;
          } catch { /* unserializable — 0 */ }
          return [cellName, n] as const;
        },
      );
      const over = sizes.filter(([, n]) => n > BROADCAST_FULL_WARN_BYTES);
      // No single cell over the line but the sum is → name the biggest one.
      const biggest = sizes.sort((a, b) => b[1] - a[1])[0];
      const offenders = over.length > 0 ? over : biggest ? [biggest] : [];
      const fresh = offenders.filter(([cellName]) =>
        !_warnedBigCells.has(cellName)
      );
      if (fresh.length === 0) return;
      for (const [cellName] of fresh) _warnedBigCells.add(cellName);
      const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)}MB`;
      log.warn(
        `[aio] broadcast: a full-state frame is ${mb(json.length)} — over ` +
          `the ${mb(BROADCAST_FULL_WARN_BYTES)} WS frame budget. Largest ` +
          `cell(s): ${
            fresh.map(([c, n]) => `"${c}" (${mb(n)})`).join(", ")
          }. Cell state is broadcast to every client on change — bulk rows ` +
          `belong in db: tables, binaries in files — see ` +
          `docs/persistence/big-data.md.`,
      );
    } catch { /* observe-only */ }
  }

  /** getUIState/serialize failures per broadcast round. Escalates to
   *  `/__aio/health` (status: "degraded") once it stops being a blip. */
  const _stateSerialization = degraded("broadcast:state");
  /** Whole-round failures — a throw anywhere in the flush loop. */
  const _broadcastRound = degraded("broadcast:round");

  /** Get filtered full-state JSON for a client (respects subscriptions) */
  function _getFilteredFullJson(meta: ClientMeta): string | undefined {
    try {
      const uiState = filterStateBySubs(
        getUIState(meta.user),
        meta.subscriptions,
      );
      return JSON.stringify(uiState);
    } catch (e) {
      // NOT `debug`: the caller's response to `undefined` is `continue`, i.e.
      // this client silently stops receiving state — permanently, and with
      // `/__aio/health` still answering "healthy". A frozen UI whose server
      // believes it is fine is the exact unnoticeable failure `degraded()`
      // exists for, and this path was the one place that never used it.
      _stateSerialization.fail(e);
      return undefined;
    }
  }

  // Both the WS and UDS broadcasters coalesce through the SAME primitive
  // (createCoalescer) so their throttle + never-drop buffer can never diverge —
  // the class of bug behind a field report (UDS dropped patches while WS
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
      // One ROUND regardless of client count — the per-client sends below feed
      // payload/bandwidth, but the broadcasts/sec rate diagnoses dispatch
      // frequency and must not scale with how many sockets are connected.
      // (Zero connections → zero wire → no round to rate.)
      if (connections.size > 0) {
        vitalsSystem?.pressureMonitor?.onBroadcastRound();
      }
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
            // Serialize the full state ONLY when the decision needs it. The
            // patch-vs-full comparison used to stringify the ENTIRE state per
            // client on EVERY patch round — with a 10MB cell, a 50-byte patch
            // cost a 10MB serialization each broadcast. The last computed
            // full-json length (refreshed on every round that does compute
            // one, and on every full send) stands in as the estimate: when
            // the patch is clearly below the threshold against it, send the
            // patch without measuring. The estimate can be stale, but only
            // ever in the SAFE direction — a patch is always a correct frame;
            // the worst case is a patch larger than an ideal full resend,
            // never a wrong state. Any patch near the threshold recomputes
            // (and thereby refreshes) the real number.
            const knownLen = meta.lastFullJson?.length;
            if (
              knownLen === undefined ||
              patchJson.length > knownLen * fullStateThreshold
            ) {
              fullJsonForTracking = _getFilteredFullJson(meta);
            }
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
              // `lastFullJson` proves what the client holds ONLY while it is
              // fresh. It is refreshed just when a full state is serialized,
              // so every patch round leaves it describing an older state than
              // the client actually has — and then a state that serializes
              // back to that older text was read as "already delivered" and
              // silently dropped, along with the rest of the round. The
              // client sat on the intermediate value forever (a spinner that
              // never resolves), server idle, health green, nothing logged.
              if (
                meta.lastFullJsonStale ||
                fullJsonForTracking !== meta.lastFullJson
              ) {
                _warnBigFullState(fullJsonForTracking, meta);
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
          // Same freshness rule as the threshold path above: a stale memo is
          // not proof the client has this state.
          if (
            !meta.lastFullJsonStale && fullJsonForTracking === meta.lastFullJson
          ) continue;
          // Anything that decides to send a whole state says WHY. The
          // threshold path above already did; this fallback did not, so the
          // expensive case was the invisible one — 438 KB frames, 28 of them
          // in 20s, and nothing in the log to point at them. Naming the reason is what turns "my app is slow"
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
          _warnBigFullState(fullJsonForTracking, meta);
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
          // A patch moved the client past whatever `lastFullJson` describes;
          // a full send makes it exact again. The string is kept either way —
          // as a size estimate for the patch-vs-full decision it stays useful.
          meta.lastFullJsonStale = sentKind === "patch";
          meta.bpLastSentAt = Date.now();
          vitalsSystem?.serverTransport.onClientStateSent(meta.id);
          const _bytes = _encoder.encode(msgToSend).byteLength;
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
        // ONE round id for everything attributed below, so `am cost` counts
        // pushes by round. Timestamps used to stand in for the round and two
        // rounds inside one millisecond became one.
        const round = costMeter.beginRound();
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
            costMeter.recordAttribution(cell, "*", bytes, round);
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
              costMeter.recordAttribution(
                entry.cell,
                String(key),
                bytes,
                round,
              );
            }
          }
        }
      }
    } catch (e) {
      // This catch wraps the ENTIRE flush loop — patch compaction, per-client
      // subscription filtering, cost metering, vitals. A throw anywhere in
      // there kills the round for every client, and at `debug` it reached no
      // sink at all under the default log level: the app just stopped updating,
      // silently, with health still green.
      _broadcastRound.fail(e);
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
    // An electron-only app has ZERO WS connections — the UDS path must count,
    // or its panel silently starves.
    if (!getTTBroadcast) return;
    if (connections.size === 0 && !deps.udsBroadcastRef?.fn) return;
    if (ttPending) return;
    ttPending = true;
    ttCoalescer.add();
  }

  function flushTT(): void {
    ttPending = false;
    if (!getTTBroadcast) return;
    if (connections.size === 0 && !deps.udsBroadcastRef?.fn) return;
    try {
      const ttData = enc("tt-state", getTTBroadcast());
      for (const [ws] of connections) {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(ttData);
          } catch { /* client disconnecting */ }
        }
      }
      try {
        deps.udsBroadcastRef?.fn?.(ttData);
      } catch { /* uds clients disconnecting */ }
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
