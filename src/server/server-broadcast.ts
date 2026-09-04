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
import { WS_BUFFER_HIGH_WATER, wsWriteBacklog } from "./write-backlog.ts";
import type { ClientMeta } from "./server-ws.ts";
import type { VitalsSystem } from "../vitals/mod.ts";
import type { AioUser } from "./aio.ts";
import { log } from "../diagnostics/logger-api.ts";
import { bytes } from "../diagnostics/fmt.ts";

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
  /** How many clients are on the UDS socket. A desktop app's clients are ALL
   *  here and none in `connections` — see the count in `flush`. */
  udsClientCount?: () => number;
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
  /** Broadcast bytes/messages since this process started — monotonic, which
   *  is what a Prometheus counter has to be (`server-metrics.ts`). */
  lifetimeBroadcast: () => { bytes: number; count: number };
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

  /** The WS transport's view of `warnBigFullState` (module scope, shared with
   *  UDS). The bookkeeping moved there with it — a chronic offender is analyzed
   *  once per PROCESS, not once per transport. */
  function _warnBigFullState(json: string, meta: ClientMeta): void {
    warnBigFullState(
      json,
      () => filterStateBySubs(getUIState(meta.user), meta.subscriptions),
    );
  }

  /** getUIState/serialize failures per broadcast round. Escalates to
   *  `/__aio/health` (status: "degraded") once it stops being a blip. */
  const _stateSerialization = degraded("broadcast:state");
  /** Whole-round failures — a throw anywhere in the flush loop. */
  /** Monotonic for the life of the PROCESS — what a Prometheus counter has to
   *  be. The per-connection map beside it stays: it answers "who is connected
   *  right now", which is a different question and a different endpoint. */
  const _lifetime = { bytes: 0, count: 0 };
  const _broadcastRound = degraded("broadcast:round");

  /** The snapshot verdict of ONE round — settled after the client loop, not
   *  inside it. `degraded()` counts CONSECUTIVE failures and `ok()` ends the
   *  episode, so a per-client verdict went fail, ok, fail, ok… whenever one
   *  view failed and another did not: a `forUser` view that throws for one
   *  user (their record missing) starved that user forever with
   *  `/__aio/health` green, for as long as anyone else was connected. The
   *  write-backlog check beside it already counted per round for exactly this
   *  reason. Pinned by tests/broadcast-degraded-per-round.test.ts. */
  type SnapshotVerdict = { attempted: boolean; failed: boolean; err: unknown };

  /** Get filtered full-state JSON for a client (respects subscriptions).
   *  Records the outcome on `verdict`; the caller settles it once per round. */
  function _getFilteredFullJson(
    meta: ClientMeta,
    verdict: SnapshotVerdict,
  ): string | undefined {
    verdict.attempted = true;
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
      verdict.failed = true;
      verdict.err = e;
      return undefined;
    }
  }

  /** One verdict per ROUND (see `SnapshotVerdict`). A round that built at
   *  least one snapshot and lost none ends the episode: `degraded()` reports
   *  recovery from `ok()`, and with only `fail()` wired five failures spread
   *  across a process lifetime counted as consecutive and the app reported
   *  itself degraded forever — a false alarm that outlives its cause is how a
   *  real one stops being believed. */
  function _settleSnapshotVerdict(v: SnapshotVerdict): void {
    if (v.failed) _stateSerialization.fail(v.err);
    else if (v.attempted) _stateSerialization.ok();
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
      // BOTH transports. A local desktop app opens no TCP ports, so its
      // clients are all on the socket and `connections` is empty — which is
      // literally the number a field report saw: "am cost reports
      // connections: 0 on UDS". `bytesPerSecPerClient` divides by this, so a
      // zero made the whole per-client column meaningless on that target.
      if (costMeter) {
        const total = connections.size + (deps.udsClientCount?.() ?? 0);
        if (total > 0) costMeter.setClientCount(total);
      }
      // Did any client receive a whole slice rather than a diff? Attribution has
      // to describe what was SENT: reporting 5 bytes of changed keys while the
      // wire carried an 8 KB full state would be a plausible number that is
      // wrong, and people act on those. Decided per client (subscriptions
      // differ), so it is observed in the loop and attributed once after it.
      let anyFullSend = false;
      // ONE serialization per distinct VIEW per round. A view is the pair
      // (user, subscriptions): two clients with the same pair receive the
      // same bytes, and used to pay for them twice — 100 clients on a 213 KB
      // state cost 20 ms a round, and each `meta.lastFullJson` held its own
      // copy (217 MB for 100 clients on 2.2 MB). Sharing the string shares
      // the memory too.
      const fullByView = new Map<string, string | undefined>();
      const snapshot: SnapshotVerdict = {
        attempted: false,
        failed: false,
        err: undefined,
      };
      const fullFor = (meta: ClientMeta): string | undefined => {
        const subs = meta.subscriptions
          ? [...meta.subscriptions].sort().join(",")
          : "*";
        const key = `${JSON.stringify(meta.user ?? null)}|${subs}`;
        if (fullByView.has(key)) return fullByView.get(key);
        const json = _getFilteredFullJson(meta, snapshot);
        fullByView.set(key, json);
        return json;
      };
      let anyPatchSend = false;
      // One ROUND regardless of client count — the per-client sends below feed
      // payload/bandwidth, but the broadcasts/sec rate diagnoses dispatch
      // frequency and must not scale with how many sockets are connected.
      // (Zero WS connections → this flush put nothing on a wire → no round to
      // rate. The UDS broadcaster counts ITS rounds itself, in
      // `createUdsBroadcastController`, because it sends on its own schedule —
      // counting them here would rate a broadcast that never happened.)
      if (connections.size > 0) {
        vitalsSystem?.pressureMonitor?.onBroadcastRound();
      }
      /** Peers skipped THIS round because their socket buffer is not
       *  draining — escalated once after the loop (see below). */
      let backlogged = 0;
      let worstBacklog = 0;
      for (const [ws, meta] of connections) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        // A skipped round is a LOST round for this client: the patches in it
        // are not queued anywhere. Remember that, so the next eligible round
        // sends the whole state instead of a patch that assumes the skipped
        // ones landed. (Clearing `lastFullJson` alone did not do that — the
        // next round still took the patch branch first.)
        if (vitalsSystem?.serverTransport.isFrozen(meta.id)) {
          if (patchesToSend.length > 0 || force) meta.needsFull = true;
          continue;
        }
        // …and the peer the freeze watchdog cannot see. `isFrozen` answers
        // about liveness — how long since this client last spoke — and it is
        // the only thing that ever stopped a broadcast. A peer that upgrades
        // and simply never reads its socket is perfectly live by that measure
        // (it never had to say anything), so every round was written to it and
        // held, in the runtime's outgoing buffer, on the SERVER's heap, until
        // the socket closed: +23 MB per 1000 × 30 KB commits, linear, with
        // `/__aio/health` green (audit a2/W2). `bufferedAmount` is the direct
        // answer to "is this peer draining", so ask it — one policy for both
        // transports, see write-backlog.ts.
        if (ws.bufferedAmount > WS_BUFFER_HIGH_WATER) {
          // Counted for the round, escalated after it: `degraded` measures
          // CONSECUTIVE failures, so a fail() here and an ok() for the next
          // healthy client in the same loop would cancel each other out and
          // nothing would ever escalate.
          backlogged++;
          worstBacklog = Math.max(worstBacklog, ws.bufferedAmount);
          if (patchesToSend.length > 0 || force) meta.needsFull = true;
          continue;
        }
        if (meta.bpMultiplier > 1) {
          const elapsed = Date.now() - meta.bpLastSentAt;
          if (elapsed < syncIntervalMs * meta.bpMultiplier) {
            meta.lastFullJson = undefined;
            if (patchesToSend.length > 0 || force) meta.needsFull = true;
            continue;
          }
        }

        let msgToSend: string | undefined;
        let fullJsonForTracking: string | undefined;
        // Recorded for `am cost`: a full resend is itself a finding, so the kind
        // is tracked where it is DECIDED rather than sniffed off the wire later.
        let sentKind: "patch" | "full" = "full";

        if (!force && !meta.needsFull && patchesToSend.length > 0) {
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
              fullJsonForTracking = fullFor(meta);
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
          fullJsonForTracking ??= fullFor(meta);
          if (!fullJsonForTracking) {
            // A snapshot that could not be built is a LOST round for this
            // client, exactly like a skipped or a thrown one — and a force
            // round's change (a "full"-strategy cell) exists in no patch. So
            // the debt is recorded here too, or a transient failure (a view
            // that threw once, a BigInt that was removed next tick) left the
            // client applying later patches on top of a state that never saw
            // this round, diverged with health green until the next unrelated
            // force round. Pinned by
            // tests/broadcast-failed-snapshot-owes-full.test.ts.
            if (patchesToSend.length > 0 || force) meta.needsFull = true;
            continue;
          }
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
                : meta.needsFull
                ? "a round was skipped for this client (backpressure), so its patches were lost"
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
          if (sentKind === "full") meta.needsFull = false;
          meta.bpLastSentAt = Date.now();
          // Everything below is vitals bookkeeping, and it is gated as such.
          // It used to run UNCONDITIONALLY while its cleanup (server-ws
          // `_cleanupVitals`) deleted the entry only when a vitals system
          // existed — so with `diagnostics: false` or `prod: { vitals: false }`
          // every connection left one `payloadStats` entry behind forever, and
          // `meta.id` is per CONNECTION, so a browser reloading grew the map
          // without bound. The measuring cost was the same shape: a full
          // TextEncoder pass over every payload, per client, per broadcast,
          // for a diagnostic nobody was reading.
          if (vitalsSystem) {
            vitalsSystem.serverTransport.onClientStateSent(meta.id);
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
            // …and the PROCESS-LIFETIME totals, beside the per-connection map.
            // `payloadStats` is deleted when a client disconnects, so the
            // Prometheus counters summed from it reset to zero — and the whole
            // series vanished — on every browser reload. `rate()`/`increase()`
            // over a resetting counter is garbage, which is exactly what the
            // comment above these lines argues ("a counter you cannot sum over
            // time is not a counter"): the `kind=<uuid>` label was removed,
            // the monotonicity was not fixed.
            _lifetime.bytes += _bytes;
            _lifetime.count++;
            vitalsSystem.pressureMonitor?.onBroadcast(meta.id, _bytes);
          }
        } catch { /* client disconnecting */ }
      }

      // One verdict per ROUND, so the consecutive-failure counter measures
      // rounds rather than clients: a peer that stops draining escalates to
      // `/__aio/health` after a handful of rounds, and the first round in
      // which every peer is keeping up clears it.
      if (backlogged > 0) {
        wsWriteBacklog.fail(
          new Error(
            `${backlogged} WebSocket client(s) are not draining their socket ` +
              `(worst: ${
                bytes(worstBacklog)
              } of unread state held on the server). Broadcasts to them are ` +
              `skipped until they do; each gets full state when it resumes.`,
          ),
        );
      } else if (connections.size > 0) {
        wsWriteBacklog.ok();
      }
      // …and the snapshot verdict, same rule, same reason.
      _settleSnapshotVerdict(snapshot);

      // ── Attribution, once per round: where did those bytes come from ──
      //
      // The half no app can compute for itself — see `attributeRound`, which
      // both transports call so neither can drift into its own answer.
      if (costMeter && (anyPatchSend || anyFullSend)) {
        attributeRound(costMeter, {
          anyPatchSend,
          anyFullSend,
          force,
          patchesToSend,
          getUIState: getUIState as () => Record<string, unknown> | undefined,
        });
      }
    } catch (e) {
      // This catch wraps the ENTIRE flush loop — patch compaction, per-client
      // subscription filtering, cost metering, vitals. A throw anywhere in
      // there kills the round for every client, and at `debug` it reached no
      // sink at all under the default log level: the app just stopped updating,
      // silently, with health still green.
      //
      // A THROWN round is a LOST round, exactly like a skipped one — the
      // coalescer emptied its buffer before calling us, so those patches exist
      // nowhere else. The skip paths above already know this and set
      // `needsFull`; this path did not, so every client kept applying later
      // patches on top of state that is missing the lost round's writes. And
      // nothing downstream catches it: Immer's out-of-range array `add`
      // SPLICES rather than throwing, so the client's own resync safety net
      // never fires and the list is merely wrong, forever. (Measured: one
      // method doing `s.items.push(v); s.big = 1n;` — the BigInt takes
      // `JSON.stringify` down and the whole round with it — left two clients
      // holding ["one","three"] against a server holding
      // ["one","two","three"], permanently, with `degraded()` needing 5
      // CONSECUTIVE failures to say a word and the wire-loss warning
      // dev-gated, i.e. silent in production.)
      if (patchesToSend.length > 0 || force) {
        for (const [, meta] of connections) {
          meta.needsFull = true;
          meta.lastFullJsonStale = true;
        }
      }
      _broadcastRound.fail(e);
    }
  };

  const coalescer = createCoalescer<PatchEntry>(syncIntervalMs, flushBroadcast);
  // Same primitive as the patch stream, so TT can never grow a second throttle
  // with different semantics (the asymmetry broadcast-coalescer.ts exists to
  // prevent). Diagnostics pace slower than state: nobody is waiting on it.
  // …and deliberately NOT in the interactive-priority registry: nothing
  // user-facing waits on the debug panel (this file's own comment says so),
  // and joining it meant `flushAllUrgent()` — which runs after every client
  // action — drained TT on every single dispatch, so the throttle above never
  // engaged once. See createCoalescer's `urgent` option.
  const ttCoalescer = createCoalescer<never>(TT_THROTTLE_MS, flushTT, {
    urgent: false,
  });

  /** Coalesced + throttled broadcast — batches synchronous bursts and buffers
   *  across the throttle window (never drops a patch). No args = full state. */
  function broadcast(patches?: PatchEntry[]): void {
    coalescer.add(patches);
  }

  /** Sends TT metadata to all connected clients.
   *
   *  COALESCED, because this is called once per dispatch and the payload is
   *  the WHOLE action log — every entry, capped at `MAX_ENTRIES` (2 000, see
   *  diagnostics/time-travel.ts), so ~140 KB on a full history — rather than a
   *  delta. (The comment here used to say "200 entries, ~15 KB"; the cap was
   *  raised and this was not, which is how the channel's real cost stayed
   *  invisible.)
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
      for (const [ws, meta] of connections) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        // The same two skips the STATE loop makes. This loop made neither, so
        // the one channel that carries the whole history each time was the one
        // channel that kept feeding a client that could not read it — a frozen
        // peer got no state and every debug frame.
        if (vitalsSystem?.serverTransport.isFrozen(meta.id)) continue;
        if (ws.bufferedAmount > WS_BUFFER_HIGH_WATER) continue;
        try {
          ws.send(ttData);
        } catch { /* client disconnecting */ }
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
    /** Broadcast bytes/messages since this process started — see `_lifetime`. */
    lifetimeBroadcast: () => ({ ..._lifetime }),
    shutdown,
  };
}

/** Attribute ONE broadcast round to the cells (and keys) that produced it.
 *
 *  Shared by BOTH transports, which is the whole point. This logic used to sit
 *  inside the WS send loop, so a local desktop app — zero TCP ports by design,
 *  every client on the UDS socket — pushed state that `am cost` attributed to
 *  nothing at all. A field report hit exactly that: "am cost reports
 *  connections: 0 on UDS, so push volume isn't visible there." The file had
 *  already learned the lesson one function away, for the time-travel channel
 *  ("An electron-only app has ZERO WS connections — the UDS path must count,
 *  or its panel silently starves"), and the meter never got it.
 *
 *  A patch attributes each changed key's serialized value; a full send
 *  attributes the whole slice as `"*"` with its real size, because "everything
 *  went" is the finding a reader needs — and the number has to match what left
 *  the socket, not what merely changed. */
export function attributeRound(
  costMeter: {
    beginRound(): number;
    recordAttribution(
      cell: string,
      key: string,
      bytes: number,
      round: number,
    ): void;
  },
  what: {
    anyPatchSend: boolean;
    anyFullSend: boolean;
    force: boolean;
    patchesToSend: readonly PatchEntry[];
    getUIState: () => Record<string, unknown> | undefined;
  },
): void {
  const { anyPatchSend, anyFullSend, force, patchesToSend } = what;
  if (!anyPatchSend && !anyFullSend) return;
  // ONE round id for everything attributed below, so `am cost` counts pushes
  // by round. Timestamps used to stand in for the round and two rounds inside
  // one millisecond became one.
  const round = costMeter.beginRound();
  const cells = patchesToSend.length > 0
    ? patchesToSend.map((p) => p.cell)
    : [];
  if (anyFullSend) {
    const ui = what.getUIState();
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
        costMeter.recordAttribution(entry.cell, String(key), bytes, round);
      }
    }
  }
}

/** One cell's state is too big to be pushed on every change — say which cell,
 *  and which of them is the largest.
 *
 *  MODULE SCOPE, and shared by both transports. It used to live inside the WS
 *  broadcaster, so an Electron app — which opens no TCP ports and keeps every
 *  client on the socket — never saw it. A field report put 83,000 rows in a
 *  cell, reached a 17 GB heap and 200 ms render stalls, and wrote: "it is a bug
 *  aio makes easy and gives no feedback about." The feedback existed. It was
 *  blind on their transport, which is the same lens that hid `am cost`,
 *  `am status`, the pressure alarm and `aio_clients_connected`.
 *
 *  Once per cell per process: the size is a fact about the app's shape, not
 *  about this frame, and a line per broadcast is a line nobody reads. */
const _warnedBigCells = new Set<string>();
let _analyzedFrameLen = 0;

export function warnBigFullState(json: string, view: () => unknown): void {
  if (json.length <= BROADCAST_FULL_WARN_BYTES) return;
  if (json.length <= _analyzedFrameLen) return; // already analyzed this size
  try {
    _analyzedFrameLen = json.length;
    const ui = view();
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
    log.warn(
      `[aio] broadcast: a full-state frame is ${bytes(json.length)} — over ` +
        `the ${bytes(BROADCAST_FULL_WARN_BYTES)} budget. Largest cell(s): ${
          fresh.map(([c, n]) => `"${c}" (${bytes(n)})`).join(", ")
        }. Cell state is pushed to every client on change — bulk rows belong ` +
        `in db: tables, binaries in files — see docs/persistence/big-data.md.`,
    );
  } catch { /* observe-only */ }
}

/** @internal tests — the once-per-cell latch is process-global. */
// aio-ok: test seam — tests/big-state-warning-uds.test.ts clears the latch between cases
export function _resetBigStateWarnings(): void {
  _warnedBigCells.clear();
  _analyzedFrameLen = 0;
}
