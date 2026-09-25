// Broadcast subsystem — sends state updates to all connected WS clients
// Handles throttling, patch compaction, backpressure, full-state fallback
import { enc, encRaw } from "../protocol/envelope.ts";
import { userMemoKey } from "./aio-run-helpers.ts";
import { compactPatches } from "../state/patch-compact.ts";
import { createCoalescer } from "./broadcast-coalescer.ts";
import { createDebtRetry } from "./debt-retry.ts";

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
import { budgetsFor, cellSizeFix } from "../state/budgets.ts";
import { rawStateControlAllowed } from "./server-auth.ts";
import { overUtf8, utf8Size } from "../protocol/utf8-size.ts";
import { decidePatchOrFull } from "./patch-or-full.ts";

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
  /** A raw frame to every UI client (WS + UDS); how many received it. */
  broadcastUi: (raw: string) => number;
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
      getUIState, // this app's latch, not the process's
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

  /** A per-PASS full-state builder: ONE serialization per distinct VIEW. A
   *  view is the pair (user, subscriptions): two clients with the same pair
   *  receive the same bytes, and used to pay for them twice — 100 clients on
   *  a 213 KB state cost 20 ms a round, and each `meta.lastFullJson` held its
   *  own copy (217 MB for 100 clients on 2.2 MB). Sharing the string shares
   *  the memory too. Used by the round AND by the idle debt retry, which pays
   *  every owed client at once (a thrown round owes all of them) — built per
   *  client there, the retry repeated exactly that cost (pinned by
   *  tests/ws-debt-retry-one-view-per-pass.test.ts). Outcomes land on
   *  `verdict`; the caller settles it once per pass. */
  function _viewSnapshotter(
    verdict: SnapshotVerdict,
  ): (meta: ClientMeta) => string | undefined {
    const fullByView = new Map<string, string | undefined>();
    return (meta) => {
      const subs = meta.subscriptions
        ? [...meta.subscriptions].sort().join(",")
        : "*";
      // `userMemoKey`, not a bare `JSON.stringify(meta.user)`.
      //
      // This key is built for EVERY client on EVERY round, inside the
      // round-wide try — so one user record `JSON.stringify` refuses took
      // the whole round down, for every client, on every round after it.
      // Measured: a `resolveUser` handing back an ORM row with a BigInt
      // `orgId` (what `node:sqlite` returns past `Number` range, and what
      // every postgres driver returns for `int8`) froze every connected UI
      // permanently. Health went degraded after five rounds, so it was loud
      // on the server and invisible in the browser.
      //
      // `userMemoKey` is the sibling reader of the same field, hardened for
      // exactly this and carrying the argument in its own comment: "a cache
      // miss costs time; a wrong cache hit costs someone else's data". It
      // answers null for a user it cannot serialize, and then there is no
      // cache — never a shared bucket.
      const userKey = userMemoKey(meta.user);
      if (userKey === null) return _getFilteredFullJson(meta, verdict);
      const key = `${userKey}|${subs}`;
      if (fullByView.has(key)) return fullByView.get(key);
      const json = _getFilteredFullJson(meta, verdict);
      fullByView.set(key, json);
      return json;
    };
  }

  /** Account ONE state frame handed to a client — per-client payload stats,
   *  the process-lifetime counters and the payload budget. Every state send
   *  goes through here: the round's, and the debt payer's (idle retry and
   *  freeze recovery), which used to set only its own bookkeeping, so a
   *  client paid a multi-MB state over and over showed on no meter at all
   *  (tests/ws-debt-metered.test.ts). Bytes on the SOCKET are metered by
   *  server-ws.ts's `send` wrapper; this is the per-frame vitals view.
   *
   *  Gated on a vitals system. It used to run UNCONDITIONALLY while its
   *  cleanup (server-ws `_cleanupVitals`) deleted the entry only when a vitals
   *  system existed — so with `diagnostics: false` or `prod: { vitals: false }`
   *  every connection left one `payloadStats` entry behind forever, and
   *  `meta.id` is per CONNECTION, so a browser reloading grew the map without
   *  bound. The measuring cost was the same shape: a full TextEncoder pass
   *  over every payload, per client, per broadcast, for a diagnostic nobody
   *  was reading. */
  function _meterSent(meta: ClientMeta, msg: string): void {
    if (!vitalsSystem) return;
    vitalsSystem.serverTransport.onClientStateSent(meta.id);
    const _bytes = _encoder.encode(msg).byteLength;
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
    // `payloadStats` is deleted when a client disconnects, so the Prometheus
    // counters summed from it reset to zero — and the whole series vanished —
    // on every browser reload. `rate()`/`increase()` over a resetting counter
    // is garbage: a counter you cannot sum over time is not a counter.
    _lifetime.bytes += _bytes;
    _lifetime.count++;
    vitalsSystem.pressureMonitor?.onBroadcast(meta.id, _bytes);
  }

  /** `am cost` for a debt payment: the whole slice went, outside any round. */
  function _attributeDebtPaid(): void {
    if (!costMeter) return;
    attributeRound(costMeter, {
      anyPatchSend: false,
      anyFullSend: true,
      force: false,
      patchesToSend: [],
      getUIState: getUIState as () => Record<string, unknown> | undefined,
    });
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
      // ONE serialization per distinct VIEW per round (`_viewSnapshotter`).
      const snapshot: SnapshotVerdict = {
        attempted: false,
        failed: false,
        err: undefined,
      };
      const fullFor = _viewSnapshotter(snapshot);
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
            // Serialize the full state ONLY when the decision needs it — the
            // shared decider (patch-or-full.ts, also the UDS transport's). The
            // comparison used to stringify the ENTIRE state per client on
            // EVERY patch round — with a 10MB cell, a 50-byte patch cost a
            // 10MB serialization each broadcast. The last computed full-json
            // length stands in as the estimate. Send full state when the
            // patch payload exceeds the configured fraction of the full-state
            // size (default 0.5 → patch > 50%); this used to compare against
            // 100%, so the user-set `fullStateThreshold` had no effect.
            const decision = decidePatchOrFull(
              patchJson.length,
              meta.lastFullJson?.length,
              fullStateThreshold,
              () => fullFor(meta),
            );
            fullJsonForTracking = decision.fullJson;
            if (decision.sendFull && fullJsonForTracking) {
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
          } else {
            // Nothing in this round is in this client's view (`subs`
            // filtered every patch out; compaction never empties a non-empty
            // op list), and it owes no debt — so its view did not change and
            // there is nothing to send. Falling through sent a FULL state
            // whenever the memo was stale, i.e. after every patch round: a
            // client subscribed to one cell paid its whole view each time an
            // unrelated cell changed. Pinned by
            // tests/broadcast-unmatched-subs-sends-nothing.test.ts.
            continue;
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
          // Vitals bookkeeping (gated on a vitals system) — see `_meterSent`.
          _meterSent(meta, msgToSend);
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
              } of unread state held on the server). State rounds to them ` +
              `are skipped until they do, and the first round after owes ` +
              `them full state; a peer that would miss a sync op or other ` +
              `raw frame is closed instead, so it reconnects and catches up.`,
          ),
        );
      } else if (connections.size > 0) {
        wsWriteBacklog.ok();
      }
      // …and the snapshot verdict, same rule, same reason.
      _settleSnapshotVerdict(snapshot);
      // A client this round skipped is OWED a whole state — arrange to pay it
      // even if no round ever follows (see `_payDebts`).
      for (const m of connections.values()) {
        if (m.needsFull) {
          _armDebtRetry(true);
          break;
        }
      }

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
      // A round that COMPLETED ends the episode. `degraded()`'s contract is
      // "call ok() on every success, not only the first", and this tracker
      // only ever failed — so one transient throw (a BigInt in a patch, say)
      // five times over the life of a process left the app reporting degraded
      // forever, however many rounds succeeded after. The UDS twin has always
      // done this (`if (failed.length === 0) _broadcastRound.ok()` in
      // uds.ts); this is the transport that did not, and the asymmetry
      // between the two is exactly what `uds.ts`'s header warns about.
      _broadcastRound.ok();
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
        _armDebtRetry(true);
      }
      _broadcastRound.fail(e);
    }
  };

  const coalescer = createCoalescer<PatchEntry>(syncIntervalMs, flushBroadcast);

  /** A client the freeze watchdog skipped is heard from again — pay what the
   *  skipped rounds owe it NOW.
   *
   *  The frozen skip above marks `needsFull`, and only a later state-change
   *  round honoured it. An idle app has no later round, so a recovered client
   *  sat on stale state for as long as nothing changed: the r3 chaos hunt
   *  measured a client on v=4 for 8 s+ after its heartbeat resumed while the
   *  server held v=6, in dev and prod alike (a background tab, a laptop lid,
   *  a GC pause over 2 s). Pinned by tests/frozen-client-recovery-resync.test.ts. */
  function resyncRecovered(clientId: string): void {
    let socket: WebSocket | undefined;
    let meta: ClientMeta | undefined;
    for (const [ws, m] of connections) {
      if (m.id === clientId) {
        socket = ws;
        meta = m;
        break;
      }
    }
    if (!socket || !meta?.needsFull) return; // nothing was skipped for it
    // Buffered patches FIRST, exactly as a connecting socket's snapshot does
    // (server-ws `drainBeforeSnapshot`). A round in the buffer pays the debt
    // itself (needsFull → whole state), and a snapshot sent AHEAD of those
    // patches would have them applied on top of a state that already holds
    // them.
    coalescer.flushUrgent();
    const verdict: SnapshotVerdict = {
      attempted: false,
      failed: false,
      err: undefined,
    };
    const paid = { n: 0 };
    _payDebt(
      socket,
      meta,
      "recovered from a freeze",
      _viewSnapshotter(verdict),
      paid,
    );
    if (paid.n > 0) _attributeDebtPaid();
    // A failure is recorded like any round's; a success is not an `ok()` for
    // the whole broadcaster — one view building says nothing of the others.
    if (verdict.failed) _stateSerialization.fail(verdict.err);
  }

  /** Send `meta` the whole state it is owed (`needsFull`), if it can take it
   *  now. Answers whether the debt is settled — false means it is still owed
   *  (not draining, or its view could not be built) and a later retry must
   *  try again. The caller has already flushed the coalescer, and settles
   *  the snapshot verdict behind `fullFor` once for its whole pass, and
   *  attributes the pass to `am cost` once when `paid.n` moved. */
  function _payDebt(
    socket: WebSocket,
    meta: ClientMeta,
    why: string,
    fullFor: (meta: ClientMeta) => string | undefined,
    paid: { n: number },
  ): boolean {
    if (!meta.needsFull) return true;
    if (socket.readyState !== WebSocket.OPEN) return true; // dies with it
    // Not draining either: the backlog skip keeps the debt for the next round
    // rather than piling a whole state onto a socket that cannot take it.
    if (socket.bufferedAmount > WS_BUFFER_HIGH_WATER) return false;
    const json = fullFor(meta);
    if (json === undefined) return false; // still owed — retried later
    if (!meta.lastFullJsonStale && json === meta.lastFullJson) {
      meta.needsFull = false; // it already holds exactly this text
      return true;
    }
    _warnBigFullState(json, meta);
    const frame = encRaw("state", json);
    try {
      socket.send(frame);
    } catch {
      return true; // client disconnecting — the debt dies with the socket
    }
    meta.lastFullJson = json;
    meta.lastFullJsonStale = false;
    meta.needsFull = false;
    meta.bpLastSentAt = Date.now();
    // Metered like a round's frame — it IS one, sent outside a round.
    _meterSent(meta, frame);
    paid.n++;
    debug?.(
      `broadcast: sending full state (${json.length}B) — client ${
        meta.id.slice(0, 8)
      } ${why} and its skipped rounds were lost`,
    );
    return true;
  }
  const _unsubscribeRecovered = vitalsSystem?.onClientRecovered?.(
    resyncRecovered,
  );

  // ── Owed rounds are PAID, not merely remembered ─────────────────────────
  //
  // A round skipped for a client (its socket not draining, its backpressure
  // window, a view that could not be built) marks it `needsFull` — and only a
  // LATER round honoured that. An app that goes idle after the skip has no
  // later round, so the client sat on the state from before the skip for as
  // long as nothing changed: measured with four real sockets on a 1.7 MB cell,
  // the last push and append of a burst never reached any of them, server
  // idle, no error anywhere. The freeze watchdog's recovery hook pays its own
  // clients (`resyncRecovered`); this is the same payment for every other
  // skip, retried until the peer can take it. Backs off to a slow poll for a
  // peer that never drains (a `bufferedAmount` read per retry, nothing more).
  // Pinned by tests/ws-backlog-debt-paid-when-idle.test.ts.
  // The timing rule (retry soon, back off, never hold the process open) is
  // `createDebtRetry` — shared with the UDS transport, so the two cannot
  // drift; what paying MEANS stays here.
  const _debtRetry = createDebtRetry({
    minMs: syncIntervalMs,
    pay: _payDebts,
    onError: (e) => _broadcastRound.fail(e),
  });
  function _armDebtRetry(fresh: boolean): void {
    _debtRetry.arm(fresh);
  }
  /** One payment pass over every owed client. Answers whether anything is
   *  still owed (the scheduler then retries with a longer delay). */
  function _payDebts(): boolean {
    let owed = false;
    // ONE verdict and one view memo for the whole pass — a thrown round owes
    // every client at once, and a round builds one snapshot per view and
    // counts one failure, not one per client (see `_viewSnapshotter`).
    const verdict: SnapshotVerdict = {
      attempted: false,
      failed: false,
      err: undefined,
    };
    const fullFor = _viewSnapshotter(verdict);
    const paid = { n: 0 };
    try {
      let any = false;
      for (const [ws, meta] of connections) {
        if (meta.needsFull && ws.readyState === WebSocket.OPEN) any = true;
      }
      if (!any) return false;
      // A buffered round pays the debt itself, in order (see resyncRecovered).
      coalescer.flushUrgent();
      for (const [ws, meta] of connections) {
        if (!meta.needsFull || ws.readyState !== WebSocket.OPEN) continue;
        // A frozen client is paid by the watchdog's recovery hook, the moment
        // it is heard from — polling it here would only repeat that.
        if (vitalsSystem?.serverTransport.isFrozen(meta.id)) continue;
        if (
          meta.bpMultiplier > 1 &&
          Date.now() - meta.bpLastSentAt < syncIntervalMs * meta.bpMultiplier
        ) {
          owed = true;
          continue;
        }
        if (
          !_payDebt(
            ws,
            meta,
            "was skipped while it could not keep up",
            fullFor,
            paid,
          )
        ) {
          owed = true;
        }
      }
    } catch (e) {
      owed = true;
      _broadcastRound.fail(e);
    } finally {
      // Failures only: a pass covers the owed clients, not every view, so its
      // successes are no `ok()` for the broadcaster (same rule as a recovery).
      if (verdict.failed) _stateSerialization.fail(verdict.err);
      // ONE attribution per pass, as a round attributes once however many
      // clients it reached.
      if (paid.n > 0) _attributeDebtPaid();
    }
    return owed;
  }
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
        // The history is every user's action types and recorded error text.
        // Under per-user auth it is operator telemetry, so admins only — the
        // bar `tt-cmd` and the dev `diag` frame already answer to. It went to
        // every socket, so bob's frames listed alice's actions.
        if (meta.perUserAuth && !rawStateControlAllowed(meta.user)) continue;
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

  /** Send raw string message to all connected WS clients, optionally excluding one.
   *
   *  The same high-water check as the state loop and `flushTT` — this path
   *  made none. It carries every sync `op` frame and every server-write push,
   *  so a peer that upgraded and never read had each of them held for it on
   *  the server's heap: the r3 chaos hunt measured a 111.9 MB backlog (28×
   *  the mark) and RSS 501 → 643 MB on one `sync: true` cell, while health
   *  said broadcasts to that peer were being skipped.
   *
   *  But a raw frame cannot merely be skipped the way a state round is. A
   *  state round has its repair in-band (`needsFull`: the next round is whole
   *  state). An op stream has none: a peer that misses op N and then gets
   *  op N+1 moves its cursor past N and never asks for it again — silent,
   *  permanent divergence. The repair a raw stream does have is the
   *  reconnect (the handshake sends whole state; sync catch-up resumes from
   *  the peer's own cursor), so the peer is CLOSED rather than fed a gap.
   *  Pinned by tests/ws-raw-broadcast-backlog.test.ts. */
  function broadcastRaw(msg: string, exclude?: WebSocket): void {
    for (const [ws, meta] of connections) {
      if (ws === exclude) continue;
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (ws.bufferedAmount > WS_BUFFER_HIGH_WATER) {
        _closeNotDraining(ws, meta);
        continue;
      }
      try {
        ws.send(msg);
      } catch { /* ignore send errors */ }
    }
  }

  /** Close a peer a raw frame could not be delivered to — see `broadcastRaw`.
   *  1013 is "try again later": every aio client reconnects on any close
   *  that is not its own, and the reason says why for anyone else's. Once
   *  per socket by construction — it is no longer OPEN afterwards. */
  /** Clients already told they missed a toast — see `broadcastUi`. */
  const _toastDropWarned = new WeakSet<ClientMeta>();

  function _closeNotDraining(ws: WebSocket, meta: ClientMeta): void {
    const held = ws.bufferedAmount;
    log.warn(
      "ws",
      `closing WebSocket client #${meta.index}: it is not draining its ` +
        `socket (${
          bytes(held)
        } of unread frames held on the server). A sync op or other raw ` +
        `frame cannot be skipped without leaving a gap, so it is closed ` +
        `instead — it reconnects and catches up from where it was.`,
    );
    try {
      ws.close(1013, "not draining: reconnect and resync");
    } catch {
      /* aio-ok: already closing — the send loop skips it either way */
    }
  }

  /** A raw frame to EVERY UI client — the WS connections and, through the
   *  late-bound ref, the UDS/Electron ones. Returns how many received it, so
   *  the caller can say "nobody was there" instead of assuming. Distinct
   *  from `broadcastRaw`, which is the sync path and WS-only on purpose. */
  function broadcastUi(raw: string): number {
    let n = 0;
    let dropped: ClientMeta[] | undefined;
    for (const [ws, meta] of connections) {
      try {
        if (ws.readyState !== WebSocket.OPEN) continue;
        // The high-water check every other send loop here makes. This one
        // made none, so a notification storm kept feeding a peer that had
        // stopped reading. Unlike `broadcastRaw`, the frame is SKIPPED, not
        // the peer closed: the only frame on this path is a `notify` toast —
        // fire-and-forget UI with no state behind it, nothing later assumes it
        // arrived, so missing it leaves no gap to repair. Closing a user's
        // connection over a toast would be the disproportionate answer. Not
        // silent: named below, and left out of the count the caller reports.
        if (ws.bufferedAmount > WS_BUFFER_HIGH_WATER) {
          (dropped ??= []).push(meta);
          continue;
        }
        ws.send(raw);
        n++;
      } catch {
        // aio-ok: a socket mid-close; the count is what actually reached one
      }
    }
    if (dropped) {
      // Once per socket: a stuck peer during a burst would otherwise print a
      // line per toast, burying the one that explains it.
      const fresh = dropped.filter((m) => !_toastDropWarned.has(m));
      for (const m of fresh) _toastDropWarned.add(m);
      if (fresh.length > 0) {
        log.warn(
          "ws",
          `notify: not shown on ${
            fresh.map((m) => `client #${m.index}`).join(", ")
          } — ${
            fresh.length === 1 ? "it is" : "they are"
          } not draining the socket (over ${
            bytes(WS_BUFFER_HIGH_WATER)
          } of unread frames held). A notification is dropped for such a ` +
            `client rather than queued; its state catches up on its own. ` +
            `(said once per client)`,
        );
      }
    }
    const uds = deps.udsClientCount?.() ?? 0;
    if (uds > 0 && deps.udsBroadcastRef?.fn) {
      deps.udsBroadcastRef.fn(raw);
      n += uds;
    }
    return n;
  }

  function shutdown(): void {
    _debtRetry.dispose();
    _unsubscribeRecovered?.();
    coalescer.dispose();
    ttCoalescer.dispose();
  }

  return {
    broadcast,
    broadcastTT,
    broadcastRaw,
    broadcastUi,
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
 *  Once per cell per APP: the size is a fact about the app's shape, not about
 *  this frame, and a line per broadcast is a line nobody reads. It was once per
 *  cell per PROCESS, and a process can host several apps (library mode,
 *  `testApps`): app A's warning about its `items` silenced app B's about a
 *  different `items`, and A's 5 MB frame marked every smaller frame "already
 *  analyzed" — B's 2 MB cell, over B's own budget, was never named at all.
 *  `owner` is the app's identity (the WS broadcaster passes its app's
 *  `getUIState`); a caller that passes none shares the process latch. */
type BigStateLatch = {
  warned: Set<string>;
  /** The largest frame analyzed, in UTF-8 bytes (what the budget is in). */
  analyzedLen: number;
  /** …and in code units — the cheap gate that keeps this off the hot path. */
  analyzedChars: number;
  /** Sends the cheap gate has skipped since the last real measurement. */
  skipped: number;
};

/** How many sends the code-unit gate may skip before the frame is measured in
 *  BYTES again. Bounds what a length can hide (a frame that shrank in
 *  characters while growing in bytes) to that many rounds, at one scan per
 *  256 sends. */
const LATCH_RECHECK_EVERY = 256;

const _processLatch: BigStateLatch = {
  warned: new Set(),
  analyzedLen: 0,
  analyzedChars: 0,
  skipped: 0,
};
const _latches = new WeakMap<object, BigStateLatch>();

function _latchFor(owner: object | undefined): BigStateLatch {
  if (owner === undefined) return _processLatch;
  let l = _latches.get(owner);
  if (!l) {
    _latches.set(
      owner,
      l = { warned: new Set(), analyzedLen: 0, analyzedChars: 0, skipped: 0 },
    );
  }
  return l;
}

export function warnBigFullState(
  json: string,
  view: () => unknown,
  owner?: object,
): void {
  const latch = _latchFor(owner);
  // The owner's OWN budgets — a second app's `cellState` is not this app's limit.
  // No race: every src caller passes a `getUIState` bound synchronously to its app's ledger (aio-server.ts).
  const budgets = budgetsFor(owner);
  // `aio.run({ budgets: { cellState } })` replaces aio's own number. The
  // hard-coded 1 MiB is a guess that has to serve every app, and a field
  // report said plainly that an app declaring its own is strictly better
  // (report 2 §9.3) — a 4 MB table pushed once a minute is not the same problem
  // as 4 MB pushed per keystroke, and only the app knows which it is.
  const limit = budgets.declared().cellState ?? BROADCAST_FULL_WARN_BYTES;
  // THE LATCH FIRST, on the cheap measure. Everything below walks the frame
  // and then every cell, and this runs on EVERY full-state send: a frame no
  // larger in code units than one already measured can only repeat that
  // measurement, so it is dropped here without touching the string.
  //
  // What a length can hide is a frame that SHRANK in characters while growing
  // in bytes — the same text turned CJK. That is why the gate reopens every
  // `LATCH_RECHECK_EVERY` skipped sends: the miss costs at most that many
  // rounds instead of lasting for the life of the process, and one scan per
  // 256 sends is ~3 µs a round. (`/health`'s own `measureCellStates` measures
  // in bytes independently, so a declared budget records the breach either
  // way; this is the one-time log line.)
  if (json.length <= latch.analyzedChars) {
    if (++latch.skipped < LATCH_RECHECK_EVERY) return;
  }
  latch.skipped = 0;
  // BYTES, the unit the limit is declared in — `json.length` is UTF-16 code
  // units, and the two agree only for ASCII. A CJK state is ~3× its `length`
  // on the wire, so an app pushing 2.7 MB per frame was reported at 900 KB and
  // its declared budget never recorded a breach. `overUtf8` settles the common
  // case on the length alone; nothing is counted for a frame under a third of
  // the limit, which is every ordinary frame.
  if (!overUtf8(json, limit)) {
    // MEASURED, and under the limit — latched like any other measurement.
    // `overUtf8` settles a frame on its length alone only below a THIRD of
    // the limit, so an app with 900 KB of ASCII state, inside its 1 MiB
    // budget and warned about nothing, counted the whole string on EVERY
    // full-state send (0.7 ms, measured) — the exact rescan the gate above
    // exists to stop, reached by the one path that never wrote to it.
    latch.analyzedChars = Math.max(latch.analyzedChars, json.length);
    return;
  }
  const size = utf8Size(json);
  if (size <= latch.analyzedLen) {
    latch.analyzedChars = json.length; // analyzed at this size already
    return;
  }
  try {
    latch.analyzedChars = json.length;
    latch.analyzedLen = size;
    const ui = view();
    if (ui === null || typeof ui !== "object") return;
    const sizes = Object.entries(ui as Record<string, unknown>).map(
      ([cellName, v]) => {
        let n = 0;
        try {
          n = utf8Size(JSON.stringify(v) ?? "");
        } catch { /* unserializable — 0 */ }
        return [cellName, n] as const;
      },
    );
    const over = sizes.filter(([, n]) => n > limit);
    // Recorded, not only logged: a budget the app DECLARED has to be
    // assertable, and a log line cannot fail a CI step. No-op when nothing
    // was declared — aio's own default is a hint, not a commitment.
    for (const [cellName, n] of over) {
      budgets.record("cellState", n, `cell "${cellName}"`);
    }
    // No single cell over the line but the sum is → name the biggest one.
    const biggest = sizes.sort((a, b) => b[1] - a[1])[0];
    const offenders = over.length > 0 ? over : biggest ? [biggest] : [];
    const fresh = offenders.filter(([cellName]) => !latch.warned.has(cellName));
    if (fresh.length === 0) return;
    for (const [cellName] of fresh) latch.warned.add(cellName);
    const declared = budgets.declared().cellState !== undefined;
    log.warn(
      "broadcast",
      `a full-state frame is ${bytes(size)} — over ` +
        `the ${bytes(limit)} budget${
          declared ? " you declared (aio.run({ budgets: { cellState } }))" : ""
        }. Largest cell(s): ${
          fresh.map(([c, n]) => `"${c}" (${bytes(n)})`).join(", ")
        }. Cell state is pushed to every client on change (a whole-state ` +
        `frame on connect, and again whenever a patch would be larger). ` +
        // Sized off the FRAME: this line compares the whole frame with the
        // budget, so only a declaration at least that big quiets it.
        cellSizeFix(size, declared, "frame"),
    );
  } catch { /* observe-only */ }
}

/** @internal tests — clears the shared latch (per-app latches die with their
 *  app's `getUIState`). */
// aio-ok: test seam — tests/big-state-warning-uds.test.ts clears the latch between cases
export function _resetBigStateWarnings(): void {
  _processLatch.warned.clear();
  _processLatch.analyzedLen = 0;
  _processLatch.analyzedChars = 0;
  _processLatch.skipped = 0;
}
