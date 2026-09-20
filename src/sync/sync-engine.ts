// src/sync/sync-engine.ts — Client-side CRDT sync orchestrator
import { vetWirePayload } from "../state/action-encode.ts";
import { enc } from "../protocol/envelope.ts";
import { peerHello } from "../protocol/protocol-version.ts";
import { createSendPacer, type PacedFrame } from "../protocol/send-pacer.ts";
import { randomUuid } from "../rand.ts";
import type {
  HLC,
  PushPatch,
  SyncConfig,
  SyncOp,
  SyncStatus,
} from "./types.ts";
import { STALE_OP_REASON, SYNC_DEFAULTS } from "./types.ts";
import type { OpBuffer } from "./op-buffer.ts";
import { compareHLC, createHLC, type HLClock } from "./hlc.ts";
import {
  rebase,
  type RebaseResult,
  REDUCER_FAILED,
  type SyncReducer,
  type SyncReducerResult,
} from "./rebase.ts";
import type { SyncConflict } from "./types.ts";
import { mergeField } from "./merge.ts";
import { applyStatePatch, stateDigest } from "./state-patch.ts";
import { log } from "../diagnostics/logger-api.ts";

/**
 * Dependencies injected into the client-side sync engine.

 *  @internal Engine/framework wiring (alpha52 sweep) — not public API.
 */
export interface SyncEngineDeps {
  clientId: string;
  cells: Record<string, SyncConfig>;
  buffer: OpBuffer;
  send: (msg: string) => void;
  reducer: SyncReducer;
  getConfirmedState: () => Record<string, Record<string, unknown>>;
  /** Update confirmed state for a cell — called on remote ops and snapshots */
  setConfirmedState: (cell: string, state: Record<string, unknown>) => void;
  onStateUpdate: (cell: string, optimistic: Record<string, unknown>) => void;
  /** How long to wait for a catch-up response before asking again — the
   *  watchdog in `requestSync`. Optional so only a TEST has to name it; the
   *  default is the one the product runs on, so a test that shortens it is
   *  exercising the same code path with a smaller number. */
  catchupTimeoutMs?: number;
  /** The reducer is PURE — same state and payload in, same state out, with
   *  the input left untouched (browser-sync's is: an Immer `produce` over the
   *  cell's own method). When set, every fold runs it twice and compares, which
   *  is how a method that reads a clock or a random source is caught — see
   *  `reduceChecked`. Off by default because a test reducer that mutates its
   *  input in place would be applied twice. */
  pureReducer?: boolean;
  /** The error the reducer's most recent REDUCER_FAILED stood for, when the
   *  host kept it — so a local call that throws rejects with the method's own
   *  error rather than a generic one. */
  lastReducerError?: () => unknown;
  log?: {
    warn: (msg: string) => void;
    /** Observe-only dedup visibility — a dropped duplicate hints at a cursor
     *  bug upstream and must be visible in dev, never silent. */
    debug?: (msg: string) => void;
  };
}

/**
 * Client-side CRDT sync engine that buffers local ops, rebases on acks, and manages online/offline state.

 *  @internal Engine/framework wiring (alpha52 sweep) — not public API.
 */
export interface SyncEngine {
  handleLocalAction(
    cell: string,
    action: string,
    payload: unknown,
  ): Promise<void>;
  /** `serverTs` (alpha43+) is the op's cursor position — see the snapshot
   *  watermark in `handleAck`. A duplicate re-ack carries it too (the server
   *  reads the position back from the log row or its compaction tombstone);
   *  it is absent only from a server that cannot say. */
  handleAck(
    cell: string,
    opId: string,
    serverHlc: HLC,
    serverTs?: number,
  ): Promise<void>;
  /** D11: the server refused this op — drop it, rebase (optimistic view
   *  snaps back), log loudly, surface via the cell's sync.onRejected. */
  handleRejection(cell: string, opId: string, reason: string): Promise<void>;
  handleRemoteOp(op: SyncOp): Promise<void>;
  handleSyncResponse(response: {
    mode: string;
    /** Which request this answers — see `SyncRequest.reqId`. */
    reqId?: number;
    ops?: SyncOp[];
    rebase?: SyncOp[];
    snapshot?: Record<string, Record<string, unknown>>;
    lowWater: HLC | Record<string, HLC>;
    /** Per-cell server_ts cursor echoed by the server. */
    lastServerTs?: Record<string, number>;
    /** Cells whose cursor the server never issued — adopt the snapshot and
     *  its cursor unconditionally (see `SyncResponse.reset`). */
    reset?: string[];
    /** An unsolicited server-origin snapshot — see `SyncResponse.push`. */
    push?: boolean;
    /** A server-origin write as a patch — see `PushPatch`. */
    patch?: Record<string, PushPatch>;
  }): Promise<void>;
  setOnline(online: boolean): void;
  getStatus(cell: string): SyncStatus;
  requestSync(): Promise<void>;
  isSyncCell(cellName: string): boolean;
  /** Stop everything this engine armed — today, the catch-up watchdog.
   *
   *  `_resetBrowserSync()` dropped the engine REFERENCE and left its timer
   *  running, so an armed watchdog outlived the engine and Deno's test
   *  sanitizer blamed whichever test ran next ("2 timers were started in this
   *  test, but never completed") — nineteen sync tests, none of which had
   *  started a timer. That is the same shape `closeWindow()` exists for, one
   *  layer down: dropping a reference is not shutting something down. */
  dispose(): void;
}

/**
 * Create a client-side sync engine that coordinates op buffering, HLC clocks, and rebase.

 *  @internal Engine/framework wiring (alpha52 sweep) — not public API.
 */
export function createSyncEngine(deps: SyncEngineDeps): SyncEngine {
  let _opCounter = 0;
  // Op identity must be unique for all time, not just for this session.
  // `clientId` is PERSISTED (localStorage — HLC identity has to survive a
  // reload) while `_opCounter` is not, so `clientId-counter` alone re-issued
  // the ids of the previous session after every page load: the server's op-id
  // dedup (`persistOp` INSERT OR IGNORE + the compaction tombstones) saw a
  // known id, skipped the dispatch — and still ACKED, so the client confirmed
  // and dropped it. Every op of a new session was silently swallowed until its
  // counter passed the previous session's high mark. A per-engine nonce makes
  // the id self-contained: no part of it depends on what survived storage.
  const _session = randomUuid().slice(0, 8);
  /** Every op id this engine issues, and nothing else. */
  const _ownPrefix = `${deps.clientId}-${_session}-`;
  /** An op THIS session issued — the only op that can be a live echo of our
   *  own send.
   *
   *  Echo suppression used to ask `op.hlc[2] === clientId`, and the client id
   *  is a localStorage UUID: a cloned browser profile, a copied Electron app
   *  directory or a restored backup yields two LIVE clients carrying the same
   *  one, and each then dropped the other's ops as its own echo — mutually
   *  invisible, forever, with nothing said. The session nonce already in every
   *  op id is the identity that is actually per client instance. */
  const isOwnSessionOp = (opId: string): boolean => opId.startsWith(_ownPrefix);
  const clock: HLClock = createHLC(deps.clientId);
  let online = true;

  // ── outbound op pacing ─────────────────────────────────────────────────
  //
  // One op used to be one frame, sent the instant it was issued. That is right
  // for a click and wrong for a THOUSAND: a demo seed, or a first sync of an
  // existing dataset, fired a frame each into a server whose per-connection
  // budget is 100/sec. The server dropped the excess, counted 50 drops in a
  // row, closed the socket and denylisted the client for a minute — an
  // anti-abuse fuse, built for hostile peers, tripped by aio's own sync
  // engine doing exactly what it was told. The renderer then sat on pre-burst
  // state while the server moved on, and the next dispatch went nowhere.
  //
  // Pacing costs nothing here because the op is ALREADY durable: it is in
  // `deps.buffer` before it is ever sent, and reconnect re-sends from there.
  // So the queue below holds frames, never the only copy of a write.
  //
  // A single op stays instant — the fast path sends inline, so nothing about
  // ordinary use gets slower. Only a burst queues, and it drains at a rate the
  // server told us it can take.
  //
  // The bound is `send-pacer.ts`'s token bucket — the same one every other
  // writer on the socket uses — not a pacer of its own. This engine used to
  // count sends in a fixed one-second window at 60% of the advertised rate,
  // which caps a WINDOW, not a second: ops trickling in at the end of one
  // window and a burst at the start of the next put 2 × 60 = 120 frames into
  // well under a second, past a 100/sec server whose own window straddles the
  // two. A bucket holding `burst` and refilling at `perSec` can never put more
  // than `burst + perSec` (80% of the rate) into ANY second.
  let _pacerSeq = 0;
  const _pacer = createSendPacer<PacedFrame>({
    write: (entry) => {
      // A drain racing `setOnline(false)`: the socket is gone, and the
      // buffer re-sends this op on reconnect — refuse rather than write.
      if (!online) throw new Error("the sync connection is offline");
      deps.send(entry.frame);
    },
    onRefused: (entries, err) => {
      // Nothing is lost — every refused frame is an op already in the durable
      // buffer, and the reconnect flush re-sends it — but a transport that
      // refuses while this engine thinks it is online must not go unsaid.
      if (online) {
        log.warn(
          "sync",
          `the transport refused a paced op frame (${
            err instanceof Error ? err.message : String(err)
          }) — ${entries.length} queued op frame(s) dropped from the pacer; ` +
            `they stay in the offline buffer and re-send on reconnect.`,
        );
      }
    },
    rate: () => peerHello()?.rate,
  });

  /** Send an op frame, immediately when there is room and in order when there
   *  is not. Ordering is preserved: once anything is queued, everything queues
   *  behind it. */
  const sendOpPaced = (msg: string): void => {
    _pacer.push({ frame: msg, seq: _pacerSeq++ });
  };

  /** Drop queued frames and disarm. Called when the connection goes away. */
  const resetPacing = (): void => {
    _pacer.take();
  };
  // ── reconnect flush, in frames the server will take ──────────────────
  //
  // A reconnect re-sends the whole offline queue inside ONE `sync-req`. The
  // server drops any inbound frame over its message limit (1 MB by default)
  // without reading it — so a queue of 400 ops × 4 KB went out as a 1.6 MB
  // frame, was dropped, was re-sent at the next reconnect, dropped again: no
  // op ever acked, the catch-up never answered, and the writes stayed off every
  // other screen for good while this one kept showing them.
  //
  // So the queue goes out in slices. Each `sync-req` carries only what fits the
  // budget; when its response lands the next slice goes, until the queue is
  // drained. A slice at a time also keeps the ORDER the server applies them in
  // equal to the order they were made in, and new ops made meanwhile wait in
  // the buffer behind the older ones (`_flushing`) rather than overtaking them.
  //
  // The budget is a quarter of the server's frame limit — room for the
  // envelope — and never more than a quarter of the 1 MB default. The WS
  // server advertises its limit in the hello (`maxMessageBytes`); before it
  // did, a fixed 250 KB slice was the guess, and an app that lowered
  // `wsLimits.maxMessageBytes` under it had every flush frame dropped unread,
  // at every reconnect. A peer that does not advertise (the UDS/IPC hello)
  // keeps the default quarter. Capped rather than scaled UP for a raised
  // limit: a bigger frame buys nothing a paced second slice does not, and
  // weighs against the server's byte-rate guard. `.length` is the measure the
  // server itself applies.
  const SYNC_REQ_BUDGET = 250_000;
  const syncReqBudget = (): number => {
    const limit = peerHello()?.maxMessageBytes;
    return typeof limit === "number" && limit >= 1
      ? Math.min(SYNC_REQ_BUDGET, Math.floor(limit / 4))
      : SYNC_REQ_BUDGET;
  };
  /** Byte rate the flush allows itself between slices — well under the
   *  server's default 5 MB/s per-connection guard. */
  const FLUSH_BYTES_PER_SEC = 1_000_000;
  let _flushing = false;
  let _flushTimer: ReturnType<typeof setTimeout> | undefined;
  /** Ids of the last slice sent — to notice a slice that made no progress. */
  let _lastSliceIds: string[] = [];
  let _lastSliceBytes = 0;
  function stopFlush(): void {
    _flushing = false;
    _lastSliceIds = [];
    if (_flushTimer !== undefined) {
      clearTimeout(_flushTimer);
      _flushTimer = undefined;
    }
  }

  const statuses = new Map<string, SyncStatus>();

  // Per-cell async mutex — serializes all state mutations (local, ack, remote, sync)
  const _locks = new Map<string, Promise<void>>();

  // ── Op-id dedup (defense-in-depth) ────────────────────────────────────
  // The server_ts cursor is the PRIMARY re-delivery guard; this set catches
  // what the cursor cannot: an op racing in via broadcast while a catch-up
  // response that also contains it is already in flight, a duplicated sync
  // request producing two overlapping responses, or re-ordered responses.
  // BOUND: per-cell FIFO set capped at APPLIED_IDS_CAP ids (≈2048 × ~40 B ≈
  // 80 KB per cell worst case; cells are limited to the app's sync cells).
  // Eviction is safe: an id only needs to outlive the overlap window between
  // a broadcast and the catch-up rounds that could re-deliver it (a few
  // response batches, each ≤ pendingCap ops). Once evicted, cursor
  // correctness governs again — the set never becomes load-bearing.
  // The cursor each installed snapshot reflects, per cell.
  //
  // A snapshot IS the server's live state, so it already contains every op the
  // server had applied when it was taken — including the client's OWN ops
  // whose acks are still in flight. `handleAck` then applied such an op to
  // confirmed state a second time, and the client's confirmed state diverged
  // by one application (found while fixing one app's cursor gap: forcing snapshots
  // made the chaos suite fail with a doubled item). It is the one
  // confirmed-state mutator that cannot dedup by op id — the snapshot never
  // enumerates what it contains — so the server states the watermark instead
  // and the ack carries its own position for comparison.
  const _snapshotTs = new Map<string, number>();

  // The highest server position this cell's CONFIRMED state reflects —
  // whichever way it got there (a snapshot install, or an op/ack folded above
  // one). A snapshot is only ever an improvement while its watermark is at
  // least this high: `reserveServerTs` hands back the log's HIGH WATER, so two
  // catch-ups reserved before the same write both quote the same position, and
  // installing the second one THREW AWAY every op folded above it in between
  // — the op existed on the server and on every peer, and vanished from this
  // client until something happened to re-deliver it. (Found by the two-cell
  // chaos fuzzer, 2026-08-27; it reproduces on the single-cell suite's code.)
  const _confirmedTs = new Map<string, number>();
  function noteConfirmedTs(cell: string, ts: number | undefined): void {
    if (ts === undefined) return;
    const cur = _confirmedTs.get(cell);
    if (cur === undefined || ts > cur) _confirmedTs.set(cell, ts);
  }

  // ── Own ops another TAB confirmed ─────────────────────────────────────
  // Two tabs of one app share the offline queue (one localStorage document
  // per cell, one persisted client id), and each tab's catch-up carries the
  // WHOLE shared queue as its pending ops. So tab B can flush tab A's op, get
  // the ack and mark it confirmed in the shared document before A hears
  // anything. A then finds no pending op for its own ack (nothing is folded),
  // its catch-ups never carry the op back (the server leaves out the
  // requester's own SESSION's ops — they are supposed to come through the
  // ack), and a lost op frame is not even re-sent (the queue says it is
  // done). The user's edit vanished from the tab they made it in, for good,
  // while the server and the other tab kept it. (Found by the r3 sync hunt,
  // 2026-09-19; pinned by tests/sync/twin-tab-own-op.test.ts.)
  //
  // So each engine remembers the ops IT issued until it folds them itself;
  // one that leaves the shared queue any other way is a fact this tab cannot
  // place in its confirmed state, and it asks for the cell (a snapshot holds
  // the op at its real position, or not at all if it was refused).
  const _ownInFlight = new Map<string, Set<string>>();
  function trackOwn(cell: string, id: string): void {
    let set = _ownInFlight.get(cell);
    if (!set) _ownInFlight.set(cell, set = new Set());
    set.add(id);
  }
  function untrackOwn(cell: string, id: string): void {
    const set = _ownInFlight.get(cell);
    if (!set) return;
    set.delete(id);
    if (set.size === 0) _ownInFlight.delete(cell);
  }
  /** Own ops of `cell` that left the queue without this engine folding or
   *  dropping them — forgotten here, and the cell marked for a re-sync. */
  function ownOpsTakenElsewhere(cell: string, unconfirmed: SyncOp[]): boolean {
    const set = _ownInFlight.get(cell);
    if (!set) return false;
    const still = new Set(unconfirmed.map((o) => o.id));
    let gone = false;
    for (const id of [...set]) {
      if (still.has(id)) continue;
      untrackOwn(cell, id);
      gone = true;
    }
    if (gone) {
      deps.log?.debug?.(
        `[sync] ${cell}: an op of this tab was confirmed by another tab ` +
          `sharing its queue — re-syncing the cell to hold it`,
      );
    }
    return gone;
  }

  const APPLIED_IDS_CAP = 2048;
  const _appliedIds = new Map<string, Set<string>>();
  function alreadyApplied(cell: string, id: string): boolean {
    return _appliedIds.get(cell)?.has(id) ?? false;
  }
  function markApplied(cell: string, id: string): void {
    let set = _appliedIds.get(cell);
    if (!set) {
      set = new Set();
      _appliedIds.set(cell, set);
    }
    set.add(id);
    if (set.size > APPLIED_IDS_CAP) {
      // Sets iterate in insertion order — evict the oldest id.
      set.delete(set.values().next().value!);
    }
  }
  // ── Refusals already reported ─────────────────────────────────────────
  // The server's refusal STICKS to the op id (`refuseIfRefusedBefore`): an op
  // it already refused is refused AGAIN, with the same reason, however it
  // comes back — a duplicated frame, a reconnect flush that re-sent the queue
  // before the first refusal landed, a twin tab flushing the shared queue.
  // That is right on the server, and it means this client can be told the same
  // refusal several times for ONE change.
  //
  // Each delivery used to be handled from scratch: `onRejected` fired again,
  // the error log printed again, and the view was rebased again — for an op
  // already dropped and already reported. An app counting rejections ("3
  // changes were refused") counted one change three times, and a
  // toast-per-rejection showed three toasts for one edit. Same rule the drop
  // channel already follows (`cap-drop-reported-once.test.ts`): one abandoned
  // change, one report.
  //
  // Op ids are unique for all time (the session nonce — see `_ownPrefix`), so
  // a second refusal for an id is always a repeat of the first, never a new
  // fact. Bounded FIFO like `_appliedIds`, and eviction is safe: past the cap
  // a third delivery would report a second time, which is the behaviour this
  // replaces, never damage.
  const _reportedRefusals = new Map<string, Set<string>>();
  function refusalAlreadyReported(cell: string, opId: string): boolean {
    return _reportedRefusals.get(cell)?.has(opId) ?? false;
  }
  function noteRefusalReported(cell: string, opId: string): void {
    let set = _reportedRefusals.get(cell);
    if (!set) _reportedRefusals.set(cell, set = new Set());
    set.add(opId);
    if (set.size > APPLIED_IDS_CAP) {
      set.delete(set.values().next().value!);
    }
  }
  // ── Queued ops folded AHEAD of their ack ─────────────────────────────
  // An op of the shared queue that this session did not issue (a twin tab's,
  // or an earlier page load's) is folded at its broadcast or catch-up
  // position, not at an ack — this engine may never get one (see
  // `foldRemoteOp`). Until it leaves the queue it is both IN confirmed state
  // and still queued, so the rebase must not replay it on top of itself, and
  // an ack that does come must confirm it without folding it again. Kept
  // apart from `_appliedIds` because that set is capped and evicts: an id
  // evicted while its op is still queued would be folded a second time.
  // Bounded by the queue itself — an id is dropped the moment its op leaves.
  const _foldedAhead = new Map<string, Set<string>>();
  function noteFoldedAhead(cell: string, id: string): void {
    let set = _foldedAhead.get(cell);
    if (!set) _foldedAhead.set(cell, set = new Set());
    set.add(id);
  }
  /** `ops` (the cell's queue) without the ones confirmed state already holds
   *  — and forget those that are no longer queued. */
  function notYetFolded(cell: string, ops: SyncOp[]): SyncOp[] {
    const ahead = _foldedAhead.get(cell);
    if (ahead === undefined) return ops;
    const queued = new Set(ops.map((o) => o.id));
    for (const id of [...ahead]) if (!queued.has(id)) ahead.delete(id);
    if (ahead.size === 0) {
      _foldedAhead.delete(cell);
      return ops;
    }
    return ops.filter((o) => !ahead.has(o.id));
  }
  // Observe-only (dev/prod-equivalency doctrine): dropping a duplicate is
  // correct in prod AND worth seeing in dev — it means a duplicate got past
  // the cursor. Never silent state damage.
  function logDuplicate(cell: string, id: string, via: string): void {
    deps.log?.debug?.(
      `[sync] ${cell}: duplicate op ${id} dropped (${via}) — already applied`,
    );
  }

  // ── Catch-up ordering gate ────────────────────────────────────────────
  // Confirmed state is REPLAYED, one op at a time, through the cell's reducer.
  // It equals the server's state only if it is folded in the server's apply
  // order — the reducers real apps write (`s.value = x`,
  // `s.items = s.items.filter(...)`) are not commutative, so a different order
  // is a different state, permanently, and nothing on either side can see it.
  //
  // The fold order IS the frame-arrival order, and on a live connection that
  // matches: the server persists, dispatches and emits under one per-cell lock,
  // and TCP keeps the order. A catch-up RESPONSE breaks it — it is a batch of
  // ops the server applied in the PAST, so any confirmed-state frame emitted
  // between the request and the response is ahead of it:
  //   - a peer op broadcast into the gap (applied here, then the response
  //     replays older ops on top of it), and
  //   - the ack for our own op — including the queue `requestSync` just
  //     flushed, which the server persists BEFORE it reads the log, and acks
  //     before it answers. That one is not even a race: every reconnect with a
  //     queued op and a missed peer op folded its own edit first and the older
  //     peer ops over it, silently reverting the user's own change on their own
  //     screen while the server and every peer kept it.
  // So: while a catch-up is outstanding for a cell, HOLD those frames and
  // replay them after the response has been folded — the position the server
  // gave them.
  //
  // Nothing is lost if the response never comes (the connection died): a held
  // ack leaves its op UNCONFIRMED, so it is re-sent and re-acked on reconnect,
  // and a held broadcast sits above a cursor that only a response advances, so
  // the next catch-up re-delivers it. Both are dropped on disconnect for that
  // reason. And the queue is capped: past the cap frames apply immediately —
  // degrading to the previous (possibly misordered) behaviour is acceptable,
  // freezing a cell's updates forever is not.
  const DEFER_CAP = 4096;
  /** How long to wait for a catch-up response before asking again.
   *
   *  Comfortably longer than a healthy round trip (a catch-up is one query
   *  and one frame) and shorter than the 30s call ceiling, so a frozen sync
   *  cell recovers well before an app-level timeout blames the app. */
  const CATCHUP_TIMEOUT_MS = deps.catchupTimeoutMs ?? 15_000;
  type Deferred =
    | { kind: "ack"; opId: string; serverHlc: HLC; serverTs?: number }
    | { kind: "op"; op: SyncOp }
    /** A pushed server-origin write, whole or as a patch (see
     *  `installPushed`). */
    | { kind: "snap"; push: Pushed; ts: number };
  type Pushed =
    | { state: Record<string, unknown> }
    | { patch: PushPatch };
  const _catchup = new Set<string>();
  const _deferred = new Map<string, Deferred[]>();
  // The id of the last catch-up this engine sent. A response says which
  // request it answers (`reqId`), and only the answer to the LATEST one opens
  // the gate: two catch-ups can be outstanding at once (a reconnect while a
  // manual `requestSync` is in flight), and response #1's `dropHeld()` used to
  // open the gate for response #2 as well — every frame arriving in between
  // then applied AHEAD of the older ops #2 was still carrying, which is
  // exactly the misordering the gate exists to prevent. Self-healing: a lost
  // response leaves the gate shut only until the next request is answered.
  let _reqSeq = 0;
  /** When the outstanding catch-up was SENT — `onSync`'s `elapsed`. */
  let _reqSentAt = 0;
  /** Conflicts seen per cell since its last catch-up completed — `onSync`'s
   *  `conflicts`. Reset when the callback fires. */
  const _conflictsSince = new Map<string, number>();
  /** Hold `item` until the outstanding catch-up for `cell` lands; false when
   *  there is none (or the hold is full) and the caller must apply it now. */
  function hold(cell: string, item: Deferred): boolean {
    if (!_catchup.has(cell)) return false;
    // Something is now WAITING on a catch-up, which is the only state the
    // watchdog exists for: until now nothing reopened this gate on its own.
    // Three things could — engine boot, going offline→online, and a `sync-err`
    // frame — and a response LOST on a still-open connection is none of them.
    // Measured: the cell stopped receiving peer changes and stopped confirming
    // its own ops, permanently and silently, with the pending buffer growing
    // toward `pendingCap` and the user's own mutations throwing past it. The
    // comment on `_reqSeq` called this "self-healing: a lost response leaves
    // the gate shut only until the next request is answered"; nothing ever
    // sent a next request.
    //
    // Armed HERE rather than in `requestSync` for two reasons that are the
    // same reason: an idle gate is harmless, and a timer nobody is waiting on
    // is a resource with no owner — which is how the first version of this
    // leaked into three test files that had never started a timer.
    _armCatchupWatchdog();
    const q = _deferred.get(cell);
    if (q === undefined) {
      _deferred.set(cell, [item]);
      return true;
    }
    if (q.length >= DEFER_CAP) return false;
    q.push(item);
    return true;
  }
  /** Value equality for the conflict check. A REFERENCE compare was wrong
   *  here: `rebase` structuredClones the confirmed state, so every object or
   *  array field came back with a fresh identity and "did local change this?"
   *  answered yes for fields nobody had touched. Sync state is JSON-shaped by
   *  contract (it crosses the wire), so a structural compare is both possible
   *  and cheap — and short-circuits on identity for the common case. */
  function _sameValue(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    // NaN is the one value unequal to itself; without this a NaN field read
    // as "changed" on every compare (a conflict nobody made, and a method
    // reported as nondeterministic for storing NaN).
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    if (a === null || b === null) return false;
    if (typeof a !== "object" || typeof b !== "object") return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (!_sameValue(a[i], b[i])) return false;
      }
      return true;
    }
    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.hasOwn(b as Record<string, unknown>, k)) return false;
      if (
        !_sameValue(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
        )
      ) return false;
    }
    return true;
  }

  function dropHeld(): void {
    _catchup.clear();
    _deferred.clear();
    _clearCatchupTimer();
  }

  /** The catch-up watchdog — see `hold`. */
  let _catchupTimer: ReturnType<typeof setTimeout> | undefined;
  function _clearCatchupTimer(): void {
    if (_catchupTimer !== undefined) {
      clearTimeout(_catchupTimer);
      _catchupTimer = undefined;
    }
  }
  /** Ask again if the catch-up this is holding for never lands.
   *
   *  It RE-REQUESTS rather than force-opening the gate: held items can only be
   *  folded against a response (snapshot, ops and rebase, under one lock), so
   *  asking again is the honest recovery — the same thing a `sync-err` does.
   *  Re-arms, so a server that never answers costs one request per interval
   *  instead of a dead cell. */
  function _armCatchupWatchdog(): void {
    if (_catchupTimer !== undefined) return; // already watching this catch-up
    _catchupTimer = setTimeout(() => {
      _catchupTimer = undefined;
      if (_catchup.size === 0) return; // answered while we waited
      deps.log?.warn(
        `[sync] no catch-up response after ${
          Math.round(CATCHUP_TIMEOUT_MS / 1000)
        }s — asking again. Until one lands this client applies no peer ` +
          `changes and confirms none of its own.`,
      );
      void engine.requestSync();
    }, CATCHUP_TIMEOUT_MS);
    // A pending watchdog must never be the reason a process stays alive.
    (_catchupTimer as unknown as { unref?: () => void }).unref?.();
  }

  // A buggy reducer that returns undefined does so for EVERY op of that
  // action — warn once per cell:action instead of flooding on every ack/op.
  const _warnedUndef = new Set<string>();
  function _warnUndefReducer(cell: string, action: string): void {
    const key = `${cell}:${action}`;
    if (_warnedUndef.has(key)) return;
    _warnedUndef.add(key);
    log.warn(
      "sync",
      `reducer returned undefined for action "${action}" in cell "${cell}". Expected state object or null. (logged once)`,
    );
  }

  // ── A fold that FAILED ────────────────────────────────────────────────
  // The reducer could not apply the op (it threw — `REDUCER_FAILED` — or it
  // returned `undefined`, which is a buggy reducer). Two things must NOT
  // happen, and both used to: the op must not be remembered as applied (the
  // mark ran BEFORE the reducer, so an error marked it applied and every
  // re-delivery was then deduped away), and this cell's cursor must not move
  // past it (the cursor is the only thing that can bring it back). The server
  // applied the op; the client did not; nothing else in the system can see the
  // difference — so say it, once per failure, at error level.
  const _foldFailed = new Set<string>();
  function foldFailure(
    cell: string,
    opId: string,
    action: string,
    via: string,
  ): void {
    _foldFailed.add(cell);
    log.error(
      "sync",
      `${cell}: the reducer could not apply op ${opId} ("${action}", via ` +
        `${via}) — the op is NOT applied, NOT marked applied, and this cell's ` +
        `sync cursor stays where it is so the server re-delivers it. Fix ` +
        `${cell}.${action} so it can replay this payload (a sync method must ` +
        `fold its own payload into its own state without throwing).`,
    );
  }

  // ── A method that does not give the same answer twice ────────────────
  // Every replica REPLAYS an op through the cell's method: the origin at its
  // ack, every peer at the broadcast, the server at dispatch, a reloaded client
  // in its catch-up. A method that reads a clock or a random source computes a
  // different value on each — the docs' own Quick Start did,
  // `s.items.push({ id: crypto.randomUUID(), text })` — so the origin, the
  // server and every peer held a different id for the same item, a peer's
  // `remove(id)` then matched nothing on the server, and every screen stayed
  // forked for good with nothing said anywhere.
  //
  // The engine cannot make such a method deterministic (the value would have to
  // travel with the op, which is a wire change — future/v2.md). What it can do
  // is SEE it: a pure reducer run twice on one input must return one answer,
  // so a second run that disagrees is proof. Then it says so, once per method,
  // at error level with the fix, and asks the server for the cell's real state
  // (`SyncRequest.resync`) so this client at least converges on the server's
  // values instead of keeping its own.
  const _nondetWarned = new Set<string>();
  const _resyncWanted = new Set<string>();
  // Cells a re-sync was ASKED for, with the id of the last request that
  // carried the ask — kept until a response to that request (or a later one)
  // lands. The ask used to be consumed when the request was sent, so one that
  // died with its connection (the socket dropped before the server read it,
  // or before its response came back) took it along: the reconnect's
  // catch-up was incremental and the cell kept the state the ask existed to
  // replace — for a late ack or an op another tab confirmed, a state the
  // server never had. Every request re-sends what is still unanswered. (r4
  // sync hunt, 2026-09-19; pinned by tests/sync/resync-survives-reconnect.)
  // Bounded by the number of sync cells.
  const _resyncAsked = new Map<string, number>();
  let _resyncTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleResync(cell: string): void {
    _resyncWanted.add(cell);
    if (_resyncTimer !== undefined) return;
    // After the fold in progress (the caller holds the cell lock, and the
    // server's snapshot must be taken AFTER the op this fold is for), and
    // coalesced: a burst of ops of one bad method costs one round.
    _resyncTimer = setTimeout(() => {
      _resyncTimer = undefined;
      if (_resyncWanted.size > 0) void engine.requestSync();
    }, 0);
  }
  function reportNondeterministic(cell: string, action: string): void {
    const key = `${cell}:${action}`;
    if (_nondetWarned.has(key)) return;
    _nondetWarned.add(key);
    log.error(
      "sync",
      `${cell}.${action} is not deterministic — run twice on the same state ` +
        `with the same arguments it produced two different results. Every ` +
        `replica (this client, the server, each peer) replays a sync method, ` +
        `so each computes its own value and they silently disagree: an id ` +
        `made with crypto.randomUUID() or Math.random(), or a Date.now() ` +
        `timestamp, differs on every screen and an edit that names it misses ` +
        `on the server. Compute the value where the call is made and pass it ` +
        `in: \`${cell}.${action}({ id: crypto.randomUUID(), … })\`. This ` +
        `client re-syncs the cell from the server after each such op. ` +
        `(logged once per method)`,
    );
  }
  /** Fold one op through the reducer — twice when the reducer is declared
   *  pure, to catch a method that answers differently each time. */
  function reduceChecked(
    state: Record<string, unknown>,
    action: string,
    payload: unknown,
    cell: string,
  ): SyncReducerResult | undefined {
    const first = deps.reducer(state, action, payload, cell);
    if (
      !deps.pureReducer || first === null || first === undefined ||
      first === REDUCER_FAILED
    ) return first;
    const second = deps.reducer(state, action, payload, cell);
    if (second !== REDUCER_FAILED && !_sameValue(first, second)) {
      reportNondeterministic(cell, action);
      scheduleResync(cell);
    }
    return first;
  }

  for (const cell of Object.keys(deps.cells)) {
    statuses.set(cell, { status: "online", pending: 0, lastSync: 0 });
  }

  /** `deps.reducer`, except that its `index`-th call — the fold of the op a
   *  local call just queued — runs twice and compares (see `reduceChecked`).
   *
   *  The early warning for a method that cannot be replayed faithfully has to
   *  run on the state the op is ACTUALLY applied to: confirmed state plus
   *  every op still pending before it. It ran on confirmed state alone, so an
   *  edit of an item that itself was still unconfirmed — every offline edit
   *  of something created offline — replayed `rename(i1)` against a state
   *  with no `i1`, the method threw, and the browser reducer printed
   *  "reducer failed … no item i1" on every such edit, for a call that had
   *  succeeded. `rebase` folds the ops in order, one reducer call each, so the
   *  op's own call sees exactly its real input. */
  function checkingReducer(cell: string, index: number): SyncReducer {
    let call = 0;
    return (state, action, payload, c) => {
      const first = deps.reducer(state, action, payload, c);
      if (call++ !== index) return first;
      if (first !== null && first !== undefined && first !== REDUCER_FAILED) {
        const second = deps.reducer(state, action, payload, c);
        if (second !== REDUCER_FAILED && !_sameValue(first, second)) {
          reportNondeterministic(cell, action);
        }
      }
      return first;
    };
  }

  function updateStatus(cell: string, patch: Partial<SyncStatus>) {
    const current = statuses.get(cell);
    if (!current) return;
    statuses.set(cell, { ...current, ...patch });
  }

  /** Serialize async work per cell to prevent interleaved state. */
  function withLock(cell: string, fn: () => Promise<void>): Promise<void> {
    const prev = _locks.get(cell) ?? Promise.resolve();
    const next = prev.then(fn, fn).finally(() => {
      // Clean up completed lock entry to prevent unbounded memory growth.
      // Only remove if this promise is still the current one (no new work queued).
      if (_locks.get(cell) === next) {
        _locks.delete(cell);
      }
    });
    _locks.set(cell, next);
    return next;
  }

  async function rebaseCell(
    cell: string,
    /** An op the caller reports itself — see `handleLocalAction`. It is also
     *  the op whose determinism is checked, when the reducer is pure. */
    quietFor?: string,
  ): Promise<RebaseResult> {
    const confirmedState = deps.getConfirmedState()[cell] ?? {};
    const unconfirmed = await deps.buffer.getUnconfirmed(cell);
    // An op THIS session issued that is no longer queued and that this engine
    // never folded: a twin tab sharing the queue flushed and confirmed it, and
    // neither an ack (it went to that tab's socket) nor a catch-up (the server
    // never replays a requester's own session's ops) brings it back here — see
    // `_ownInFlight`. Asked HERE, where the engine already has the queue in
    // hand, because every ack, local call, broadcast and catch-up fold passes
    // through a rebase. It used to be asked in `requestSync` and nowhere else,
    // and a tab that stays connected never calls that on its own: there is no
    // periodic catch-up and the watchdog arms only behind a held frame. So the
    // cell sat on confirmed state missing the user's OWN change — a state the
    // server never had — through every frame that arrived afterwards, until a
    // reconnect that may be hours away. `scheduleResync` coalesces and runs
    // outside this lock. (A tab that sees NO frames at all still waits for
    // that reconnect; only a cross-tab `storage` listener would cover it.)
    if (ownOpsTakenElsewhere(cell, unconfirmed)) scheduleResync(cell);
    const replay = notYetFolded(cell, unconfirmed);
    const result = rebase(
      confirmedState,
      replay,
      quietFor !== undefined && deps.pureReducer
        ? checkingReducer(cell, replay.findIndex((o) => o.id === quietFor))
        : deps.reducer,
    );
    // The op the client itself is holding could not be replayed. Ack,
    // catch-up and broadcast have always said so; rebase returned the fact in
    // `dropped` and NOTHING read it, so the one path replaying the user's own
    // unsent changes was the only silent one — the change simply left the
    // optimistic view, and `pending` (below) stopped counting it. Same two
    // reporters as the other three paths, so the wording and the once-per-key
    // dedup are shared rather than re-invented.
    for (const { op, why } of result.notApplied) {
      if (op.id === quietFor) continue;
      if (why === "failed") foldFailure(cell, op.id, op.action, "rebase");
      else _warnUndefReducer(cell, op.action);
    }
    deps.onStateUpdate(cell, result.optimistic);
    // `pending` is documented as "ops still waiting for an ack" (SyncStatus),
    // and that is `unconfirmed` — the buffer's own list. It was
    // `surviving.length`, which is a different fact: ops that FOLDED cleanly.
    // The two differ for every op the reducer returned `null` for — the
    // documented no-op contract — so an app that uses no-ops was told 0 ops
    // were awaiting an ack while the buffer held some, and the same
    // under-count hid an op the reducer could not replay.
    updateStatus(cell, { pending: unconfirmed.length });
    return result;
  }

  /** Fold an ack into confirmed state. Caller holds the cell lock. */
  async function foldAck(
    cell: string,
    opId: string,
    serverHlc: HLC,
    serverTs?: number,
  ): Promise<void> {
    clock.receive(serverHlc);
    // Apply the acked op to confirmed state BEFORE marking it confirmed.
    // Otherwise rebaseCell(confirmed, unconfirmed-without-acked) drops the
    // op's effect from optimistic state — UI snaps back to pre-op value.
    const pending = (await deps.buffer.getUnconfirmed(cell)).find(
      (o) => o.id === opId,
    );
    // …unless a snapshot already brought it in. `serverTs <= snapshotTs`
    // means the op was persisted before the snapshot was taken, so the
    // snapshot's state includes it; applying it again would double it.
    // Confirm it, skip the apply. (No serverTs — duplicate re-ack, or an
    // older server — falls through to the original behaviour.)
    const snapTs = _snapshotTs.get(cell);
    const inSnapshot = pending !== undefined && serverTs !== undefined &&
      snapTs !== undefined && serverTs <= snapTs;
    // …or unless it was folded already, at its broadcast or catch-up
    // position: an op of the shared queue this session did not issue (see
    // `foldRemoteOp`). Its ack confirms it; folding it again would double it.
    const folded = pending !== undefined &&
      (_foldedAhead.get(cell)?.has(opId) ?? false);
    // A modern server (it stated a snapshot watermark) that cannot state THIS
    // op's position: the only way that happens is a compaction tombstone
    // written before the `server_ts` column existed (pre-alpha43), re-acking a
    // resend. The fact is gone from the database, so neither answer is safe —
    // applying may double the op, skipping may lose it — and guessing quietly
    // is the one thing that must not happen. We apply (a doubled entry is
    // visible; a lost one is not) and say so, with the way out.
    if (
      pending !== undefined && serverTs === undefined && snapTs !== undefined
    ) {
      log.warn(
        "sync",
        `${cell}: the server acked op ${opId} without its log position while a ` +
          `catch-up snapshot is installed, so it cannot be told whether the ` +
          `snapshot already contains this change. Cause: a compaction ` +
          `tombstone written by an aio older than alpha43 (they expire 24h ` +
          `after the last compaction, so this stops on its own). The change is ` +
          `applied; if this cell shows a duplicated entry, reload the page — ` +
          `that rebuilds the cell from the server.`,
      );
    }
    // An ack BELOW what confirmed state already reflects: the server applied
    // this op before ops this client has already folded, so folding it now
    // puts it after them — for `s.value = x` or `s.items.filter(...)` a state
    // the server never had, kept on this client only. Every path that can
    // deliver an ack sorts it among the ops of its own catch-up; this is the
    // ack that belongs to an EARLIER one. It happens in a sliced reconnect
    // flush: the op was applied on a connection that died before its ack, it
    // did not fit the first slice, and the first slice's response left it out
    // of the log it served (the server never echoes a client's own ops back)
    // while its cursor moved past it — so its re-ack comes a round later, at
    // its old position. Confirmed state cannot insert into its own past, so
    // it asks for the cell (`SyncRequest.resync`): the snapshot holds the op
    // at its real position, and the fold below keeps it on screen until then.
    // (Found by the r3 sync hunt, 2026-09-19; pinned by
    // tests/sync/late-ack-resync.test.ts.)
    const covered = _confirmedTs.get(cell);
    if (
      pending !== undefined && !inSnapshot && !folded &&
      serverTs !== undefined && covered !== undefined && serverTs < covered
    ) {
      deps.log?.debug?.(
        `[sync] ${cell}: ack for ${opId} at position ${serverTs} lands below ` +
          `the ${covered} confirmed state already covers — re-syncing the cell`,
      );
      scheduleResync(cell);
    }
    if (pending && !inSnapshot && !folded) {
      const confirmed = deps.getConfirmedState()[cell] ?? {};
      const next = reduceChecked(
        confirmed,
        pending.action,
        pending.payload,
        cell,
      );
      // Reducer contract: null = no-op, REDUCER_FAILED = could not apply,
      // undefined = a buggy reducer. Only a real state object is committed.
      if (next === REDUCER_FAILED) {
        foldFailure(cell, opId, pending.action, "ack");
      } else if (next === undefined) {
        _warnUndefReducer(cell, pending.action);
      } else if (next !== null) {
        deps.setConfirmedState(cell, next);
      }
    }
    if (pending === undefined && _ownInFlight.get(cell)?.has(opId)) {
      // Ours, and gone from the shared queue: another tab confirmed it (see
      // `_ownInFlight`). Unless a snapshot already holds it, confirmed state
      // here never got it — ask for the cell.
      untrackOwn(cell, opId);
      const held = serverTs !== undefined && snapTs !== undefined &&
        serverTs <= snapTs;
      if (!held) scheduleResync(cell);
    }
    if (pending !== undefined) {
      untrackOwn(cell, opId);
      // This op is now IN confirmed state — folded just above, or carried by
      // the snapshot the watermark points at. Record it in the same applied-id
      // set every other path uses, because a catch-up can hand it back:
      // `handleSync` re-delivers a client's own ops unfiltered whenever that
      // cell's cursor is still 0 (the "rebuilding from nothing" case), and
      // acks deliberately do not advance the cursor — so a live client that
      // acked an op before its first response for that cell landed got the op
      // back and applied it a SECOND time. `foldCatchupOp`'s own-op guard only
      // covers ops still awaiting an ack, which this one no longer is.
      // (Found by the two-cell chaos fuzzer, 2026-08-27; reproduces on the
      // single-cell suite's code too.) After a reload the set is empty and
      // confirmed state is empty with it, so a re-delivery is applied exactly
      // as it should be.
      markApplied(cell, opId);
      noteConfirmedTs(cell, serverTs);
    }
    await deps.buffer.confirm(cell, opId, serverHlc);
    await rebaseCell(cell);
    updateStatus(cell, { lastSync: Date.now() });
  }

  /** Fold one op from a catch-up response into confirmed state. Caller holds
   *  the cell lock. Unlike {@linkcode foldRemoteOp} this does not touch the
   *  HLC watermark or run conflict callbacks — the response advances the
   *  watermark once, from the whole batch. */
  function foldCatchupOp(
    cell: string,
    op: SyncOp,
    pendingIds: Set<string>,
  ): Promise<void> {
    // Self-origin guard — an op of ours that we are still waiting on an ack
    // for enters confirmed state through THAT ack, and folding it here too
    // would double it (see handleRemoteOp).
    //
    // An own op we are NOT waiting on is a different thing entirely: it is our
    // own history, from a session whose confirmed state is gone (a reload),
    // and this response is the only place it can come back from. The server
    // sends those only to a cursorless client — the one rebuilding from
    // nothing (see handleSync).
    //
    // "Awaiting an ack" means one THIS session will get: its own op. An op of
    // the shared queue from another tab (or an earlier page load) may never
    // be acked to this engine, so skipping it here lost it once the other tab
    // confirmed it — it is folded at its position instead, and its ack, if
    // one comes, confirms it without a second fold (see `foldRemoteOp`).
    if (isOwnSessionOp(op.id) && pendingIds.has(op.id)) {
      logDuplicate(cell, op.id, "own-op in catch-up");
      return Promise.resolve();
    }
    // Dedup: the op may already have arrived via broadcast while our sync-req
    // (sent with an older cursor) was in flight — the response then contains
    // it a second time. Skipping the re-apply is the fix for that race; the
    // cursor still advances (the op IS covered).
    if (alreadyApplied(cell, op.id)) {
      logDuplicate(cell, op.id, "catch-up");
      return Promise.resolve();
    }
    // …and the SNAPSHOT watermark, for the ops the id set structurally cannot
    // see. A snapshot is the server's live state at a reserved position, so it
    // contains every op at or below that position — but it never enumerates
    // them, so `_appliedIds` stays empty for all of them.
    //
    // Reachable whenever two catch-ups overlap (a reconnect while a manual
    // `requestSync` is outstanding — the case `reqId` exists for): request #1
    // is answered with a SNAPSHOT at position S, request #2 was sent with the
    // older cursor and is answered INCREMENTALLY with the very ops that
    // snapshot folded in. Both responses are for this client, both are valid,
    // and folding #2's ops on top of #1's snapshot applied each of them a
    // second time — permanently, on the client only.
    //
    // Same rule the held-op and ack paths already use (`serverTs <= snapTs`
    // ⇒ the snapshot has it); this was the third place that needed it and the
    // one that did not have it. An op that cannot state its position
    // (pre-alpha43 server) is folded as before — unknown position, previous
    // behaviour, never a silent guess.
    const snapTs = _snapshotTs.get(cell);
    if (
      snapTs !== undefined && op.serverTs !== undefined && op.serverTs <= snapTs
    ) {
      logDuplicate(cell, op.id, "catch-up under snapshot");
      markApplied(cell, op.id);
      if (pendingIds.has(op.id)) noteFoldedAhead(cell, op.id);
      return Promise.resolve();
    }
    const confirmed = deps.getConfirmedState()[cell] ?? {};
    const next = reduceChecked(confirmed, op.action, op.payload, cell);
    // Same guard the ack and remote-op paths carry: `null` is the contract's
    // no-op, `undefined` is a buggy reducer. Letting it through set confirmed
    // state to undefined, and the next rebase read
    // `getConfirmedState()[cell] ?? {}` — every confirmed field silently gone.
    //
    // The applied-mark comes AFTER the fold, and only for a fold that
    // happened: marking first meant a failed op could never be re-delivered.
    if (next === REDUCER_FAILED) {
      foldFailure(cell, op.id, op.action, "catch-up");
      return Promise.resolve();
    }
    if (next === undefined) {
      _warnUndefReducer(cell, op.action);
      _foldFailed.add(cell); // nothing was applied — keep it re-deliverable
      return Promise.resolve();
    }
    markApplied(cell, op.id);
    if (pendingIds.has(op.id)) noteFoldedAhead(cell, op.id);
    noteConfirmedTs(cell, op.serverTs);
    if (next === null) return Promise.resolve();
    deps.setConfirmedState(cell, next);
    // A catch-up is where concurrent OFFLINE edits meet: the peer ops the
    // client missed fold here, ahead (in server order) of the acks for the
    // client's own queued ops — and this path never looked, so the documented
    // `onConflict` ("a remote op changes a field your unconfirmed local ops
    // also changed") fired only for edits made while both were online. Two
    // peers editing one note offline lost one edit with no callback and no
    // line anywhere. Same check as the live path; the view is left to the
    // batch's own rebase.
    return pendingIds.size > 0
      ? conflictWork(cell, confirmed, next, op.hlc, undefined)
      : Promise.resolve();
  }

  /** Fold a remote op into confirmed state. Caller holds the cell lock. */
  async function foldRemoteOp(op: SyncOp): Promise<void> {
    // An op stamped with OUR client id that this session did not issue is
    // either a clone's (apply it — it is a different client) or one of ours
    // resent from an earlier session after a reload. The pending buffer is the
    // one thing that can tell them apart: an op we are still awaiting an ack
    // for enters confirmed state through THAT ack, never here. Only paid for
    // when the ids actually collide.
    //
    // …except that "awaiting an ack" is not something the shared queue can
    // tell this ENGINE. Two tabs of one app share it (see `_ownInFlight`), so
    // the op may be the other tab's, still unconfirmed because ITS ack has not
    // been handled yet — and this tab, which never sent it, gets no ack for it
    // at all. Dropping it here lost it for good: the other tab confirmed it a
    // moment later, the op left the queue, and this tab's cursor moved past
    // it with the next catch-up (r4 sync hunt, 2026-09-19; pinned by
    // tests/sync/twin-tab-peer-op.test.ts). So an op this session did not
    // issue is folded HERE, at its position in the server's order, and noted
    // as folded ahead (`_foldedAhead`); its ack — if one ever comes to this engine (a reload's resend,
    // or this tab flushing the other's op) — then confirms it without folding
    // it twice (`foldAck`), and the rebase does not replay it on top of
    // itself meanwhile (`notYetFolded`). This session's own ops never reach
    // here: `handleRemoteOp` drops their echo, and their ack is certain.
    const queued = op.hlc[2] === deps.clientId &&
      (await deps.buffer.getUnconfirmed(op.cell)).some((o) => o.id === op.id);
    clock.receive(op.hlc);
    const meta = await deps.buffer.getMeta(op.cell);
    // Op-id dedup: same op delivered twice (duplicated broadcast, or a
    // broadcast racing a catch-up response that also contains it).
    // Deliberately id-based, NOT `serverTs <= cursor` — a cursor
    // advanced by a LATER op does not prove an earlier op was seen, so a
    // cursor guard could drop a never-applied op under reordered
    // delivery. The id set only skips provably-applied ops.
    const isDup = alreadyApplied(op.cell, op.id);
    const confirmed = deps.getConfirmedState()[op.cell] ?? {};
    let next: SyncReducerResult | undefined = null;
    if (isDup) {
      logDuplicate(op.cell, op.id, "broadcast");
    } else {
      next = reduceChecked(confirmed, op.action, op.payload, op.cell);
      // Mark applied only after a fold that actually happened (see
      // `foldFailure`) — and leave without touching the watermark below when
      // it did not, so nothing seals an op this client never applied.
      if (next === REDUCER_FAILED) {
        foldFailure(op.cell, op.id, op.action, "broadcast");
        return;
      }
      if (next === undefined) {
        _warnUndefReducer(op.cell, op.action);
        _foldFailed.add(op.cell);
        return;
      }
      markApplied(op.cell, op.id);
      if (queued) noteFoldedAhead(op.cell, op.id);
      noteConfirmedTs(op.cell, op.serverTs);
      if (next !== null) deps.setConfirmedState(op.cell, next);
    }
    // Advance the compaction watermark (lastHlc, never regressing) — the
    // server uses it only to decide snapshot-vs-incremental. Deliberately
    // do NOT advance lastServerTs from broadcast stamps (chaos-suite
    // finding, 2026-07-21): on a fresh connection broadcasts arrive AHEAD
    // of the client's coverage (ops persisted while it was offline are
    // still undelivered), so a stamp jump seals that gap above the cursor
    // — permanent silent loss if the catch-up response is then dropped.
    // The server_ts cursor advances ONLY via a processed sync-res:
    // its reservation echo is self-contained coverage (everything ≤ it
    // was in that response, in a snapshot, or our own). Broadcasts the
    // next catch-up re-delivers are absorbed by the op-id dedup above.
    const lastHlc = !meta?.lastHlc || compareHLC(op.hlc, meta.lastHlc) > 0
      ? op.hlc
      : meta.lastHlc;
    if (lastHlc !== meta?.lastHlc) {
      await deps.buffer.saveMeta(op.cell, {
        lastHlc,
        lastServerTs: meta?.lastServerTs,
      });
    }
    if (isDup) return;
    const optimistic = (await rebaseCell(op.cell)).optimistic;
    if (next != null) {
      await conflictWork(op.cell, confirmed, next, op.hlc, optimistic);
    }
  }

  /** Merge strategy fields whose merged VIEW was already reported as one the
   *  server will not keep — once per cell:field. */
  const _viewOnlyWarned = new Set<string>();

  /** A remote op just moved confirmed state from `confirmed` to `after` —
   *  report every field it changed that this client's unconfirmed ops also
   *  change. Caller holds the cell lock. `optimistic` is the rebased view the
   *  caller already pushed (live broadcast), or `undefined` for a catch-up
   *  fold, which reports but leaves the view to the batch's own rebase. */
  async function conflictWork(
    cell: string,
    confirmed: Record<string, unknown>,
    after: Record<string, unknown>,
    opHlc: HLC,
    optimistic: Record<string, unknown> | undefined,
  ): Promise<void> {
    // Conflict handling: a field the remote op changed that surviving
    // local (unconfirmed) ops still override. Default semantics are
    // rebase-LWW — local replays on top — so `local` is what the user
    // sees and `remote` is the confirmed value underneath. Fields with a
    // configured merge strategy get a CRDT merge applied to the CLIENT
    // VIEW for the conflict window (the server stays the convergence
    // authority — its next snapshot/ack rebase replaces the view).
    const cfg = deps.cells[cell];
    const mergeCfg = cfg?.merge ?? {};
    const onConflict = cfg?.onConflict;
    const wantsConflictWork = onConflict !== undefined ||
      Object.keys(mergeCfg).length > 0;
    if (wantsConflictWork) {
      const conflicts: SyncConflict[] = [];
      let mergedView: Record<string, unknown> | null = null;
      let viewOfServer: Record<string, unknown> | undefined;
      // Local-side timestamp for merges: the newest surviving local op.
      const unconfirmed = notYetFolded(
        cell,
        await deps.buffer.getUnconfirmed(cell),
      );
      const localHlc = unconfirmed.reduce(
        (m: HLC | null, o) =>
          m === null || compareHLC(o.hlc, m) > 0 ? o.hlc : m,
        null,
      ) ?? clock.now();
      // The view as it was BEFORE this op landed — `rebase` replayed against
      // the OLD confirmed state. Two different wrong answers came out of not
      // having it:
      //
      //  • `optimistic` is POST-rebase, so for an increment-style reducer it
      //    ALREADY contains the remote delta. `mergeCounter` then adds it a
      //    second time: base + localΔ + 2·remoteΔ. Measured with
      //    `merge: { count: "counter" }`, a local +1 and a peer +1 on a base
      //    of 0 produced a view of 3 — and the conflict record said
      //    `local: 2`, which is the correct answer the merge then spoiled.
      //    Declaring the strategy made the view WORSE than the `lww` default.
      //    (An ASSIGNING reducer — `set {n:5}` — is the one shape where the
      //    post-rebase value happened to be right, which is the shape the
      //    existing test pins.) The pre-rebase view is correct for both.
      //
      //  • "did local override this field?" was a REFERENCE compare, and
      //    `rebase` structuredClones the whole confirmed state — so once any
      //    local op was pending, every object/array field had a fresh
      //    reference and could never compare equal. `onConflict` fired for
      //    fields the client had never touched, with `local` deep-equal to
      //    `remote`, and dragged them through `mergeField` as well.
      //
      // Computed once, and only when there is conflict work to do.
      const beforeRebase = rebase(
        confirmed,
        unconfirmed,
        deps.reducer,
      ).optimistic;
      for (const field of Object.keys(after)) {
        const remoteChanged = !_sameValue(confirmed[field], after[field]);
        const localOverrides = !_sameValue(
          confirmed[field],
          beforeRebase[field],
        );
        if (!remoteChanged || !localOverrides) continue;
        const strategy = mergeCfg[field] ?? "lww";
        if (strategy !== "lww") {
          try {
            const m = mergeField(
              strategy,
              beforeRebase[field],
              localHlc,
              after[field],
              opHlc,
              confirmed[field],
              cfg?.identity?.[field] ?? "id",
            );
            // What the SERVER will hold is not this merge. It applies the op
            // through the method, never through a merge strategy, so the
            // field ends up exactly as the rebase computes it — `optimistic`.
            // A merge that differs from it exists on this screen only, until
            // the ack; the peer's (or this user's) part of it is then gone.
            // The docs promised "never a silent loss" for `text`; an
            // assigning method (`setBody(s, text) { s.body = text }`) made it
            // one. Say so, once, with what to change.
            viewOfServer ??= optimistic ??
              rebase(after, unconfirmed, deps.reducer).optimistic;
            if (!_sameValue(m.value, viewOfServer[field])) {
              warnViewOnlyMerge(cell, field, strategy);
            }
            if (optimistic !== undefined) {
              mergedView ??= { ...optimistic };
              mergedView[field] = m.value;
            }
          } catch (e) {
            deps.log?.warn(
              `[sync] ${cell}.${field}: ${strategy} merge failed (${e}) — keeping rebase-LWW view`,
            );
          }
        }
        conflicts.push({
          field,
          // The value the merge was given — the view before this op landed.
          // Reporting the post-rebase one described a different number from
          // the one the resolution was computed from.
          local: beforeRebase[field],
          remote: after[field],
          resolution: strategy,
        });
      }
      if (mergedView) deps.onStateUpdate(cell, mergedView);
      if (conflicts.length > 0) {
        _conflictsSince.set(
          cell,
          (_conflictsSince.get(cell) ?? 0) + conflicts.length,
        );
      }
      if (conflicts.length > 0 && onConflict) {
        try {
          onConflict(conflicts);
        } catch (e) {
          deps.log?.warn(`[sync] onConflict callback threw: ${e}`);
        }
      }
    }
  }

  function warnViewOnlyMerge(
    cell: string,
    field: string,
    strategy: string,
  ): void {
    const key = `${cell}:${field}`;
    if (_viewOnlyWarned.has(key)) return;
    _viewOnlyWarned.add(key);
    log.warn(
      "sync",
      `${cell}.${field}: this client's change and a concurrent one from ` +
        `another client collided, and merge "${strategy}" cannot keep both. ` +
        `The server applies each op through the cell's method, and this ` +
        `method replaces the whole value — so the change the server gets ` +
        `last overwrites the other, there and on every screen (a merged ` +
        `view shown here meanwhile is temporary; onConflict was called with ` +
        `it). A merge ` +
        `strategy holds only for a method that applies the EDIT instead of ` +
        `assigning the result: \`s.n += delta\` for a counter, push/filter ` +
        `for a set, and for text a method that patches the value it finds. ` +
        `(logged once per field)`,
    );
  }

  /** Install a pushed server-origin snapshot as confirmed state. Caller holds
   *  the cell lock and rebases afterwards.
   *
   *  A push is a snapshot like any catch-up snapshot — the server captured it
   *  under the cell's lock right after reserving `ts` — so it takes the same
   *  watermark: an ack or a held op at or below `ts` is already inside it.
   *  Only ever an improvement: a position below what confirmed state already
   *  reflects would roll back ops folded since (unreachable on one ordered
   *  connection, and harmless to skip — the newer state came from the same
   *  server). The cursor is NOT moved; it advances only through a catch-up
   *  response, and the next catch-up is served a snapshot anyway (the write
   *  compacted the cell above every cursor issued before it). */
  function installPushed(cell: string, push: Pushed, ts: number): void {
    const covered = _confirmedTs.get(cell);
    if (covered !== undefined && ts < covered) {
      deps.log?.debug?.(
        `[sync] ${cell}: ignoring a pushed server snapshot at position ${ts} ` +
          `— confirmed state already covers ${covered}`,
      );
      return;
    }
    let state: Record<string, unknown>;
    if ("state" in push) {
      state = push.state;
      _pushMisses.delete(cell);
    } else {
      // A patch is taken against the state the server last pushed, and
      // applied here to the state this client folded — which is that plus
      // the ops since, replayed on a state without the write. Almost always
      // the same thing; provably so only when the result digests to the
      // server's (see state-patch.ts for the two shapes where it does not).
      const patched = applyStatePatch(
        deps.getConfirmedState()[cell] ?? {},
        push.patch.set,
      );
      const sum = patched === null ? null : stateDigest(patched);
      if (patched === null || sum?.digest !== push.patch.digest) {
        // Keep what we have — it is missing the write, not wrong about
        // anything else — and ask for the cell. The server answers this
        // client alone with a snapshot.
        const misses = (_pushMisses.get(cell) ?? 0) + 1;
        _pushMisses.set(cell, misses);
        deps.log?.debug?.(
          `[sync] ${cell}: a pushed server write at position ${ts} does not ` +
            `match this client's state once applied — re-syncing the cell`,
        );
        if (misses === PUSH_MISS_WARN_AT) {
          log.warn(
            "sync",
            `${cell}: ${misses} pushed server writes in a row did not match ` +
              `this client's state, and each costs a full re-sync of the ` +
              `cell. The client folds the same ops the server applied, so a ` +
              `run of these means they give different results here: a sync ` +
              `method that reads a clock or a random source, or cell state ` +
              `that is not plain JSON (a Map, a class instance). (logged once ` +
              `per run)`,
          );
        }
        scheduleResync(cell);
        return;
      }
      _pushMisses.delete(cell);
      state = patched;
    }
    deps.setConfirmedState(cell, state);
    _snapshotTs.set(cell, ts);
    noteConfirmedTs(cell, ts);
  }
  /** Pushed patches in a row that did not match, per cell — a run is a
   *  divergence the re-syncs are papering over, and gets said once. */
  const _pushMisses = new Map<string, number>();
  const PUSH_MISS_WARN_AT = 3;

  async function foldPushed(response: {
    snapshot?: Record<string, Record<string, unknown>>;
    lastServerTs?: Record<string, number>;
    patch?: Record<string, PushPatch>;
  }): Promise<void> {
    // Every lock is TAKEN synchronously, before this returns to the event
    // loop: frames are folded in the order they arrived, and a frame for the
    // same cell handled after this one must queue behind it.
    const work: Promise<void>[] = [];
    const fold = (cell: string, push: Pushed, ts: number): void => {
      // Behind an outstanding catch-up it waits its turn like every other
      // confirmed-state frame, and folds in position (see `hold`).
      if (hold(cell, { kind: "snap", push, ts })) return;
      work.push(withLock(cell, async () => {
        installPushed(cell, push, ts);
        await rebaseCell(cell);
      }));
    };
    for (const [cell, patch] of Object.entries(response.patch ?? {})) {
      if (!(cell in deps.cells)) continue;
      if (
        !patch || typeof patch !== "object" || typeof patch.ts !== "number" ||
        !Number.isFinite(patch.ts) || !Array.isArray(patch.set) ||
        typeof patch.digest !== "string"
      ) {
        deps.log?.warn(
          `[sync] ${cell}: a pushed server write without a position, a patch ` +
            `or a digest was ignored — it cannot be placed among this cell's ` +
            `ops. Re-syncing the cell.`,
        );
        scheduleResync(cell);
        continue;
      }
      fold(cell, { patch }, patch.ts);
    }
    for (const [cell, state] of Object.entries(response.snapshot ?? {})) {
      if (!(cell in deps.cells)) continue;
      const ts = response.lastServerTs?.[cell];
      if (
        typeof ts !== "number" || !Number.isFinite(ts) || !state ||
        typeof state !== "object" || Array.isArray(state)
      ) {
        deps.log?.warn(
          `[sync] ${cell}: a pushed server snapshot without a position (or ` +
            `without a state object) was ignored — it cannot be placed among ` +
            `this cell's ops. The next catch-up brings the change.`,
        );
        continue;
      }
      fold(cell, { state }, ts);
    }
    await Promise.all(work);
  }

  const engine: SyncEngine = {
    handleLocalAction(cell, action, payload) {
      return withLock(cell, async () => {
        // VET BEFORE THE OP EXISTS. An op JSON cannot carry poisons everything
        // downstream of here: `saveOp` fails its localStorage write with a
        // quota-shaped message that blames the browser, `enc` throws on the
        // send, and the buffered op is retried on every reconnect forever.
        // Refusing here rejects the caller's promise, which
        // `handleSyncLocalAction` already turns into a warning plus an ack
        // rejection — the channel this failure should have used all along.
        vetWirePayload(`${cell}:${action}`, payload);
        const hlc = clock.tick();
        const id = `${deps.clientId}-${_session}-${
          (++_opCounter).toString(36)
        }`;
        const op: SyncOp = {
          id,
          cell,
          action,
          payload,
          hlc,
          confirmed: false,
          _clientTs: Date.now(),
        };

        // ONE `add`. The buffer makes room itself before it refuses (prunes
        // confirmed ops, evicts stale ones — op-buffer.ts) and fires
        // `onDrop(op, "prune-failed")` when it does refuse. A second
        // prune-and-add here could not find room the first had not, and
        // reported the same lost op twice: two console errors and two
        // `sync-op-dropped` events per change (r3 chaos: 40 drop reports for
        // 20 ops). Pinned by tests/sync/cap-drop-reported-once.test.ts.
        const accepted = await deps.buffer.add(op);
        if (!accepted) {
          updateStatus(cell, { status: "blocked" });
          // THROW, do not return. `return` resolved the caller's promise, and
          // `handleSyncLocalAction` turns a resolve into `_resolveAck(cid)` —
          // so `await todos.add(item)` reported SUCCESS for a mutation that
          // had just been discarded. The console said so and `onDrop` fired,
          // but the awaited promise is what app code branches on, and it lied.
          //
          // The framework already decided this the other way on the twin
          // queue: `offline-queue.ts` rejects a dropped action's pending ack
          // "so the caller hears 'dropped' NOW". Two offline queues, one
          // fact, two answers — and the quiet one was the one that loses
          // data. Rejecting is also what the `vetWirePayload` refusal above
          // does, for the same reason and through the same channel.
          throw new Error(
            `[sync] ${cell}:${action} was DROPPED — the offline queue is ` +
              `full (pending cap reached), so this change never reached the ` +
              `server and is gone. Reconnect, or reduce the mutation rate.`,
          );
        }

        trackOwn(cell, id);
        // `add` may have EVICTED older unconfirmed ops of this queue to make
        // room (op-buffer's backpressure path). They are gone for good and the
        // app has already been told (`onDrop`) — so forget them HERE, while
        // the cause is known. Left tracked, the next `requestSync` reads their
        // absence from the queue as a twin tab having confirmed them, logs
        // exactly that about a change the app was just told was dropped, and
        // spends a snapshot re-sync on it. A diagnostic that names a cause
        // that did not happen is the worse half of that; the re-sync is the
        // bill. (Only `add` evicts, and only this engine calls `add`, so the
        // attribution is exact.)
        for (const gone of deps.buffer.takeEvicted?.() ?? []) {
          untrackOwn(gone.cell, gone.id);
        }
        const { notApplied } = await rebaseCell(cell, id);

        // The method THREW for this call. On a plain cell the caller's promise
        // rejects with the method's error and nothing is applied; here the op
        // was queued, sent, the server's own dispatch threw too, and the
        // caller was told SUCCESS — `await notes.add(x)` resolved for a change
        // that was never going to exist (the rebase above already knew, and
        // only logged it as a replay failure). A local call is decided on the
        // local view, exactly like a plain cell's is on the server's: take the
        // op back out before anything else sees it, and reject.
        const failed = notApplied.find((n) => n.op.id === id);
        if (failed?.why === "failed") {
          untrackOwn(cell, id);
          await deps.buffer.pruneStale(cell, id);
          await rebaseCell(cell);
          // The method's OWN error when the host kept it — the same rejection
          // the plain cell gives, so app code handles one error, not two.
          const cause = deps.lastReducerError?.();
          if (cause instanceof Error) throw cause;
          throw new Error(
            `[sync] ${cell}.${action} threw${
              cause === undefined ? "" : `: ${String(cause)}`
            } — the change was not applied and not queued.`,
          );
        }
        // The early warning for a method that cannot be replayed faithfully
        // ran inside the rebase above, on the op's real input (see
        // `checkingReducer`). The resync itself waits for the ack (see
        // `reduceChecked`).

        // While a chunked reconnect flush is still sending OLDER queued ops
        // (see `requestSync`), a new op must queue behind them: sent now, it
        // would reach the server — and be applied — ahead of changes the user
        // made before it. It is in the buffer, so the flush carries it.
        if (online && !_flushing) {
          sendOpPaced(enc("op", { id, hlc, cell, action, payload }));
        }
      });
    },

    handleAck(cell, opId, serverHlc, serverTs) {
      // Held while a catch-up is outstanding — the op it confirms was applied
      // by the server AFTER the log that response carries (see `hold`). The op
      // stays unconfirmed meanwhile, so the optimistic view is unchanged and a
      // lost response costs nothing but a re-send.
      if (hold(cell, { kind: "ack", opId, serverHlc, serverTs })) {
        return Promise.resolve();
      }
      return withLock(cell, () => foldAck(cell, opId, serverHlc, serverTs));
    },

    handleRejection(cell, opId, reason) {
      return withLock(cell, async () => {
        // Said once. A repeat is the server re-refusing an op this client
        // already dropped (see `_reportedRefusals`) — nothing left to prune,
        // nothing changed to rebase, and the app was told.
        if (refusalAlreadyReported(cell, opId)) {
          deps.log?.debug?.(
            `[sync] ${cell}: the server refused op ${opId} again (${reason}) ` +
              `— already dropped and already reported`,
          );
          return;
        }
        untrackOwn(cell, opId);
        // Drop the rejected op — it will never be confirmed. A refusal for
        // staleness is the one rejection that is ALSO an abandoned local
        // change (the server could not tell a resend from a new op — see
        // STALE_OP_REASON), so it leaves through `onDrop` under that name,
        // the channel every other abandoned change leaves through; every
        // other reason keeps the silent prune, since `onRejected` below is
        // already the app's word on it.
        if (reason.startsWith(STALE_OP_REASON) && deps.buffer.dropStale) {
          await deps.buffer.dropStale(cell, opId);
        } else {
          await deps.buffer.pruneStale(cell, opId);
        }
        await rebaseCell(cell);
        // Marked once the op is OUT of the queue — everything below is
        // reporting. Marking at the door instead would make a prune that threw
        // (a storage error) permanent AND silent: the op stays queued, is
        // re-sent on every reconnect, is re-refused every time, and each
        // re-refusal is now skipped as "already handled". A step that did not
        // happen is not a step to dedup.
        noteRefusalReported(cell, opId);
        // D11: silent rejection is a blank-screen-class bug — always loud.
        log.error(
          "sync",
          `${cell}: change rejected by the server — ${reason} ` +
            `(op ${opId}; optimistic view rolled back)`,
        );
        deps.cells[cell]?.onRejected?.({ opId, reason });
        updateStatus(cell, { lastSync: Date.now() });
      });
    },

    handleRemoteOp(op) {
      if (!this.isSyncCell(op.cell)) return Promise.resolve();
      // Self-origin guard (chaos-suite finding, 2026-07-21): a reconnect race
      // can echo our OWN op back as a "remote" broadcast — the server excludes
      // the socket the op arrived on, but after a reconnect we hold a NEW
      // socket, so the exclusion misses. Applying the echo would double the
      // op's effect: once here, once via the sync-ack path (the op is still
      // pending locally). Own ops only ever enter confirmed state through
      // handleAck.
      //
      // Keyed on the op ID, not the HLC node: the node is the shared,
      // persisted client id, and two clones of one profile carry the same one
      // (see `isOwnSessionOp`). An op of the shared queue this session did
      // NOT issue — an earlier page load's, or a twin tab's — is folded here
      // like any other and its ack, if one comes, only confirms it (see
      // `foldRemoteOp`).
      if (isOwnSessionOp(op.id)) {
        logDuplicate(op.cell, op.id, "own-op echo");
        return Promise.resolve();
      }
      // Held while a catch-up is outstanding: this op is AHEAD of the response
      // in flight, and applying it first would make the response's older ops
      // replay on top of it (see `hold`).
      if (hold(op.cell, { kind: "op", op })) return Promise.resolve();
      return withLock(op.cell, () => foldRemoteOp(op));
    },

    async handleSyncResponse(response) {
      // Not an answer to anything this client asked — a server-side write
      // being pushed. It must not drain the held queue, open the gate, move a
      // cursor or fire `onSync`, all of which belong to a real catch-up.
      if (response.push === true) return foldPushed(response);
      // Receive HLCs into global clock (safe outside per-cell lock)
      if (response.ops) {
        for (const op of response.ops) clock.receive(op.hlc);
      }

      // Collect snapshot work per cell
      const snapshots = new Map<string, Record<string, unknown>>();
      if (response.mode === "snapshot" && response.snapshot) {
        for (const [f, s] of Object.entries(response.snapshot)) {
          snapshots.set(f, s);
        }
      }

      // Group ops by cell
      const opsByCell = new Map<string, SyncOp[]>();
      if (response.ops) {
        for (const op of response.ops) {
          const list = opsByCell.get(op.cell) ?? [];
          list.push(op);
          opsByCell.set(op.cell, list);
        }
      }

      // Resolve per-cell lowWater (supports both single HLC and per-cell map)
      const lw = response.lowWater;
      const isPerCell = lw && !Array.isArray(lw) && typeof lw === "object";
      // `null`, never a fabricated one. The miss used to fall back to
      // `clock.now()` — the CLIENT's own freshly-ticked HLC stored as "the
      // server's low water", and a map miss mutating the HLC as a side effect.
      // A watermark is the server's statement about its log; when the server
      // did not make one, the honest answer is to keep the cursor we have.
      const getLW = (f: string): HLC | null =>
        isPerCell
          ? (lw as Record<string, HLC>)[f] ?? null
          : (lw as HLC) ?? null;

      // The catch-up has landed: take everything it held and fold it WITH the
      // response, in one ordered batch per cell (see `hold` and the batch
      // below). One sync-req covers every cell and produces exactly this one
      // response, so the whole queue drains here — ALWAYS, even for a response
      // that is not the latest. Holding a queue ACROSS a response while
      // folding that response's ops inverts exactly the pairs the gate exists
      // to protect: a held broadcast can sit BELOW an op the response carries.
      //
      // What the request id decides is whether the gate RE-OPENS. Two
      // catch-ups can be outstanding at once (a reconnect while a manual
      // `requestSync` is in flight), and response #1's `dropHeld()` used to
      // open the gate for response #2 as well — so every frame arriving in
      // between applied immediately and #2's older ops replayed on top, the
      // very misordering the gate exists to prevent. The gate now opens only
      // for the answer to the LATEST request. A lost response costs one more
      // round of holding, never a stall: the next request's answer opens it.
      // A server that does not echo `reqId` (an older build) puts us back on
      // "any response opens the gate", which is what it always did.
      const rid = response.reqId;
      const answersLatest = rid === undefined || rid >= _reqSeq;
      // A re-sync asked in this request (or an earlier one) is answered.
      for (const [c, asked] of [..._resyncAsked]) {
        if (rid === undefined || rid >= asked) _resyncAsked.delete(c);
      }
      // Cells the server says we hold a FOREIGN cursor for: it never issued
      // that position, so this client synced with a different history (the
      // server restarted on a restored backup, a wiped data dir, or another
      // app answers on this port). Every "never regress" rule below exists
      // for out-of-order responses within ONE history and would pin the
      // stale cursor forever — the server's snapshot and cursor replace ours.
      // Unconfirmed ops are untouched: they were re-sent as pendingOps and
      // are acked (or rejected) by the server we are actually talking to.
      const resetCells = new Set(response.reset ?? []);
      for (const cell of resetCells) {
        _confirmedTs.delete(cell);
        _snapshotTs.delete(cell);
        // The app's channel (browser-sync wires console.warn here), same as
        // every other engine-level warning the app is meant to see.
        deps.log?.warn(
          `[sync] ${cell}: the server never issued this client's sync ` +
            `cursor — it synced with a different history (restored backup, ` +
            `wiped data dir, or another app on this address). Adopting the ` +
            `server's snapshot; unsent changes are kept and re-sent.`,
        );
      }
      const held = new Map(_deferred);
      _deferred.clear();
      if (answersLatest) {
        _catchup.clear();
        _clearCatchupTimer();
      }

      // Process each affected cell: snapshot → ops → rebase (all under one lock)
      //
      // EVERY declared cell, not just the ones this response carried
      // something for. `requestSync` sets all of them to "syncing" before the
      // send, and only `foldCell` puts a cell back — so a cell with nothing to
      // catch up (the ordinary first launch of a new sync app: an empty
      // response for every cell) stayed "syncing" forever. `foldCell` is a
      // no-op for a cell with no snapshot, no ops and nothing held; what it
      // still does is answer the question the status is for.
      const affected = new Set([
        ...Object.keys(deps.cells),
        ...snapshots.keys(),
        ...opsByCell.keys(),
        ...held.keys(),
      ]);
      const cursorSaved = new Set<string>();
      function foldCell(cell: string): Promise<void> {
        // A previous response's failure for this cell is re-decided by THIS
        // batch: it either folds cleanly (cursor moves) or fails again.
        _foldFailed.delete(cell);
        return withLock(cell, async () => {
          const snapAny = snapshots.get(cell);
          const snapTs = snapAny === undefined
            ? undefined
            : response.lastServerTs?.[cell] ?? _snapshotTs.get(cell);
          // A snapshot that does not reach as far as this cell's confirmed
          // state already does is not an update — it is a rollback (see
          // `_confirmedTs`). Keep what we have; the response's own ops still
          // fold below, deduped by id.
          const covered = _confirmedTs.get(cell);
          const stale = snapAny !== undefined && snapTs !== undefined &&
            covered !== undefined && snapTs < covered;
          if (stale) {
            deps.log?.debug?.(
              `[sync] ${cell}: ignoring a catch-up snapshot at position ` +
                `${snapTs} — confirmed state already covers ${covered}`,
            );
          }
          const snap = stale ? undefined : snapAny;
          if (snap) {
            deps.setConfirmedState(cell, snap);
            // The cursor this snapshot reflects — every op at or below it is
            // already in `snap`, which is what keeps a late ack from applying
            // one of them twice (see `_snapshotTs`).
            if (typeof snapTs === "number") {
              _snapshotTs.set(cell, snapTs);
              noteConfirmedTs(cell, snapTs);
            }
            // NOT written to the buffer: confirmed state is re-seeded from the
            // cell's initial state on every boot and no code path ever loaded
            // a stored snapshot back, so `buffer.saveSnapshot` here was a copy
            // of the whole cell state into localStorage on every catch-up —
            // paid against the same quota the offline queue needs and never
            // read (audit a5, 2026-09-02).
          }
          let newLastHlc: HLC | null = null;
          if (snap) newLastHlc = getLW(cell);
          const ops = opsByCell.get(cell) ?? [];
          const heldItems = held.get(cell) ?? [];
          // ── the fold, in the SERVER's apply order ───────────────────────
          // A catch-up answers two things at once: peer ops the client missed
          // AND the acks for the ops it just flushed — and it does not answer
          // them in one order. Its own ops are stamped when the server persists
          // them, which for a resent (already-known) op is where they sat in
          // the log ROUNDS ago, while the acks come back in resend order. Both
          // sides are replayed through the reducer, so folding them in arrival
          // order builds a state the server never had: for `s.value = x` or
          // `s.items.filter(...)` a different order is a different answer,
          // kept forever, on the client only.
          // Every item knows its position (`serverTs`), so sort by it — that
          // IS the server's order. If anything cannot say (a pre-alpha43
          // server), keep the previous arrival order rather than guess.
          // Ops of ours still awaiting an ack — read once, before the batch
          // folds anything (an ack in the batch confirms as it runs).
          const pendingIds = new Set(
            (await deps.buffer.getUnconfirmed(cell)).map((o) => o.id),
          );
          const batch: { ts?: number; run: () => Promise<void> }[] = [];
          for (const op of ops) {
            batch.push({
              ts: op.serverTs,
              run: () => foldCatchupOp(cell, op, pendingIds),
            });
          }
          for (const h of heldItems) {
            if (h.kind === "op") {
              // Held under a snapshot: it may already be IN the snapshot —
              // a snapshot cannot enumerate what it holds, so the id dedup
              // cannot see it and replaying it would apply it twice.
              //
              // "May", not "is". The op's own position decides, exactly as it
              // does for a held ack below: `serverTs <= snapTs` means it was
              // persisted before the snapshot was captured (in it — skip);
              // ABOVE the watermark means it was persisted AFTER, and it is
              // precisely the op the snapshot does NOT contain.
              //
              // That gap is reachable with two or more sync cells: the
              // response is built cell by cell, each under its own lock, so
              // cell A is snapshotted at ts N, A's lock is released, the
              // server awaits cell B — and a peer op for A persisted in that
              // window is broadcast, arrives first on the FIFO connection, and
              // is held. Dropping it was silent divergence that healed only at
              // the next reconnect. An op that cannot state its position
              // (pre-alpha43 server) is still dropped: unknown means unsafe,
              // and the next catch-up re-delivers it (only a response advances
              // the cursor).
              if (
                snapTs !== undefined &&
                (h.op.serverTs === undefined || h.op.serverTs <= snapTs)
              ) {
                logDuplicate(cell, h.op.id, "held under snapshot");
                continue;
              }
              batch.push({ ts: h.op.serverTs, run: () => foldRemoteOp(h.op) });
            } else if (h.kind === "snap") {
              // A pushed snapshot the response's own snapshot already covers
              // is older news; above it, it is the newer state and folds in
              // its position.
              if (snapTs !== undefined && h.ts <= snapTs) continue;
              const { push, ts } = h;
              batch.push({
                ts,
                run: () => Promise.resolve(installPushed(cell, push, ts)),
              });
            } else {
              // Same argument for a held ack, except it must still RUN: the op
              // has to be confirmed and the buffer drained. Carrying the
              // snapshot's watermark tells `foldAck` the fold is already done.
              //
              // ONLY when the ack has no serverTs of its own. This used to
              // `Math.min` a KNOWN serverTs down to the watermark, and a known
              // serverTs ABOVE the watermark means the op was persisted AFTER
              // the snapshot — it is precisely the op the snapshot does not
              // contain. Clamping it made `foldAck` compute
              // `serverTs <= snapTs` → "already folded" → skip the apply, and
              // the user's own change vanished from confirmed state. Reachable
              // whenever the server serialises a `sync-req` before an op whose
              // ack arrives while the catch-up gate is closed.
              const ts = h.serverTs ?? snapTs;
              batch.push({
                ts,
                run: () => foldAck(cell, h.opId, h.serverHlc, ts),
              });
            }
          }
          if (batch.every((b) => typeof b.ts === "number")) {
            batch.sort((a, b) => a.ts! - b.ts!);
          }
          for (const item of batch) await item.run();
          if (ops.length > 0) {
            const firstHlc = ops[0]?.hlc;
            if (firstHlc) {
              const highest = ops.reduce(
                (m: HLC, o) => compareHLC(o.hlc, m) > 0 ? o.hlc : m,
                firstHlc,
              );
              if (!newLastHlc || compareHLC(highest, newLastHlc) > 0) {
                newLastHlc = highest;
              }
            }
          }
          const respTs = response.lastServerTs?.[cell];
          // A response can advance the server_ts cursor without carrying an
          // HLC watermark (a snapshot for a never-compacted cell) — that is
          // still a cursor worth saving, and gating the whole meta write on
          // the HLC would drop it.
          if ((newLastHlc || respTs != null) && !_foldFailed.has(cell)) {
            // Per-cell cursor from the server; preserve the stored one when
            // the response doesn't cover this cell — overwriting with
            // undefined would regress to the ambiguous HLC cursor and cause
            // re-delivery (double-apply through the reducer). NEVER regress
            // either cursor: two in-flight sync responses delivered out of
            // order would otherwise rewind lastServerTs and re-deliver every
            // op between the two cursors on the next catch-up.
            const prev = await deps.buffer.getMeta(cell);
            const lastHlc = !newLastHlc
              ? prev?.lastHlc ?? null
              : prev?.lastHlc && compareHLC(prev.lastHlc, newLastHlc) > 0
              ? prev.lastHlc
              : newLastHlc;
            const lastServerTs = respTs != null &&
                (resetCells.has(cell) || respTs > (prev?.lastServerTs ?? 0))
              ? respTs
              : prev?.lastServerTs;
            await deps.buffer.saveMeta(cell, { lastHlc, lastServerTs });
            cursorSaved.add(cell);
          }
          // Rebase FIRST, then decide about status. Confirmed state was just
          // advanced (snapshot above, or the ops loop), and `rebaseCell`
          // recomputes optimistic = confirmed + unconfirmed and pushes it to
          // the UI. Returning early on "blocked" skipped that, so a blocked
          // cell kept showing a view built on the PRE-snapshot confirmed state
          // — stale precisely while its buffer is full and it most needs the
          // server's latest.
          await rebaseCell(cell);
          const s = statuses.get(cell);
          if (s?.status === "blocked") return;
          updateStatus(cell, { status: "syncing" });
          updateStatus(cell, {
            status: online ? "online" : "offline",
            lastSync: Date.now(),
          });
          // The catch-up for this cell is DONE — tell the app, which is what
          // `sync.onSync` is documented (with a code example) to be for. It
          // was declared in `SyncConfig`, normalized by `normalizeSyncConfig`,
          // written into the docs' own example… and called from nowhere: a
          // documented callback that never fired. Error-guarded like every
          // other app hook — an app's throw must not take the fold down.
          const onSync = deps.cells[cell]?.onSync;
          if (onSync) {
            const conflicts = _conflictsSince.get(cell) ?? 0;
            _conflictsSince.delete(cell);
            try {
              onSync({
                merged: ops.length + heldItems.length + (snap ? 1 : 0),
                conflicts,
                elapsed: _reqSentAt ? Date.now() - _reqSentAt : 0,
                status: statuses.get(cell)?.status ?? "online",
                pending: statuses.get(cell)?.pending ?? 0,
              });
            } catch (e) {
              deps.log?.warn(`[sync] onSync callback threw: ${e}`);
            }
          }
        });
      }

      for (const cell of affected) {
        // ONE cell's failure is ONE cell's failure. A throw while applying
        // cell A's ops used to escape `handleSyncResponse` entirely: every
        // later cell in `affected` was skipped, and so was the trailing
        // cursor-advance loop — one bad reducer took the whole catch-up down,
        // for every cell, with the response already consumed and unrepeatable.
        try {
          await foldCell(cell);
        } catch (e) {
          // The cell is NOT covered by this response — hold its cursor so the
          // next catch-up re-delivers what it missed.
          _foldFailed.add(cell);
          log.error(
            "sync",
            `${cell}: applying the catch-up response threw (${e}) — this ` +
              `cell's cursor is held so the server re-delivers these ops; ` +
              `other cells in the response were unaffected. Fix the ${cell} ` +
              `reducer/storage error above.`,
          );
        }
      }

      // Cells the server echoed a cursor for but delivered nothing (e.g. the
      // only above-cursor ops were our own, filtered from the echo): advance
      // the stored cursor anyway — otherwise it stalls and the server
      // re-loads + re-filters those ops every round. Never regress.
      for (const [cell, ts] of Object.entries(response.lastServerTs ?? {})) {
        if (cursorSaved.has(cell)) continue;
        // …but NEVER for a cell whose fold failed: the echoed cursor covers
        // ops this client did not apply, and sealing them above the cursor is
        // exactly the permanent, silent divergence the hold exists to prevent.
        if (_foldFailed.has(cell)) continue;
        try {
          await withLock(cell, async () => {
            const prev = await deps.buffer.getMeta(cell);
            if (resetCells.has(cell) || ts > (prev?.lastServerTs ?? 0)) {
              await deps.buffer.saveMeta(cell, {
                lastHlc: prev?.lastHlc ?? null,
                lastServerTs: ts,
              });
            }
          });
        } catch (e) {
          log.error(
            "sync",
            `${cell}: could not save the echoed sync cursor (${e}) — the ` +
              `cell will re-request these ops on the next catch-up. Check the ` +
              `offline queue's storage (localStorage quota/permissions).`,
          );
        }
      }

      // The next slice of a reconnect flush, paced by what the last one
      // weighed (see SYNC_REQ_BUDGET).
      if (answersLatest && _flushing && _flushTimer === undefined && online) {
        // A slice whose every op is STILL unconfirmed now that its response
        // has landed got nowhere (the server cannot persist them, or refuses
        // them without a word): sending it again would loop forever. Stop, say
        // so, and leave the queue — and the ops made meanwhile — to the next
        // reconnect.
        const still = new Set<string>();
        for (const cell of Object.keys(deps.cells)) {
          for (const o of await deps.buffer.getUnconfirmed(cell)) {
            still.add(o.id);
          }
        }
        if (
          _lastSliceIds.length > 0 && _lastSliceIds.every((id) => still.has(id))
        ) {
          log.error(
            "sync",
            `the offline queue flush made no progress — none of the ` +
              `${_lastSliceIds.length} change(s) in the last slice was ` +
              `acknowledged or refused. ${still.size} change(s) stay queued ` +
              `and are re-sent on the next reconnect; the server log says why ` +
              `it did not take them.`,
          );
          stopFlush();
          return;
        }
        const delay = Math.ceil(_lastSliceBytes * 1000 / FLUSH_BYTES_PER_SEC);
        _flushTimer = setTimeout(() => {
          _flushTimer = undefined;
          if (_flushing) void engine.requestSync();
        }, delay);
      }
    },

    setOnline(v) {
      const wasOffline = !online;
      online = v;
      // Frames queued for a socket that is gone are duplicates of what the
      // durable buffer will re-send; drop them with the connection.
      if (!v) resetPacing();
      // …and so does a flush in progress: the reconnect starts it over from
      // the buffer.
      if (!v) stopFlush();
      // The connection died with a catch-up outstanding: whatever it was
      // holding is safe to drop (a held ack left its op unconfirmed → re-sent;
      // a held broadcast sits above a cursor only a response advances →
      // re-delivered). Keeping the gate closed would stall the cell instead.
      if (!v) dropHeld();
      for (const cell of Object.keys(deps.cells)) {
        if (!v) {
          updateStatus(cell, { status: "offline" });
        } else {
          const s = statuses.get(cell);
          if (s?.status === "offline") {
            updateStatus(cell, { status: "online" });
          }
        }
      }
      // Flush queued ops on offline→online transition
      if (v && wasOffline) {
        this.requestSync().catch(() => {
          // Revert to offline if sync request fails
          for (const cell of Object.keys(deps.cells)) {
            const s = statuses.get(cell);
            if (s?.status === "syncing") {
              updateStatus(cell, { status: "offline" });
            }
          }
        });
      }
    },

    getStatus(cell) {
      return statuses.get(cell) ??
        { status: "online", pending: 0, lastSync: 0 };
    },

    async requestSync() {
      if (!online) return; // don't send while offline
      const cells: Record<
        string,
        { lastHlc: HLC | null; lastServerTs?: number }
      > = {};
      const allPending: SyncOp[] = [];

      for (const cell of Object.keys(deps.cells)) {
        const meta = await deps.buffer.getMeta(cell);
        cells[cell] = {
          lastHlc: meta?.lastHlc ?? null,
          lastServerTs: meta?.lastServerTs,
        };
        const unconfirmed = await deps.buffer.getUnconfirmed(cell);
        if (ownOpsTakenElsewhere(cell, unconfirmed)) _resyncWanted.add(cell);
        allPending.push(...unconfirmed.slice(0, SYNC_DEFAULTS.pendingCap));
        updateStatus(cell, { status: "syncing" });
      }

      // The slice this request carries (see SYNC_REQ_BUDGET). Always at least
      // one op, so an op bigger than the budget still travels — alone.
      const slice: SyncOp[] = [];
      let sliceBytes = 0;
      const budget = syncReqBudget();
      for (const op of allPending) {
        const n = JSON.stringify(op).length + 1;
        if (slice.length > 0 && sliceBytes + n > budget) break;
        slice.push(op);
        sliceBytes += n;
      }
      const more = allPending.length > slice.length;
      _flushing = more;
      _lastSliceIds = more ? slice.map((o) => o.id) : [];
      _lastSliceBytes = sliceBytes;
      const resync = [...new Set([..._resyncWanted, ..._resyncAsked.keys()])];
      _resyncWanted.clear();

      // From here until the response lands, anything that would mutate
      // confirmed state is AHEAD of that response — hold it (see `hold`).
      // Armed BEFORE the send: a transport that answers synchronously would
      // otherwise open the gate before it was closed and leave it shut with no
      // response left to open it.
      for (const cell of Object.keys(deps.cells)) _catchup.add(cell);
      // The watchdog is armed by `hold()`, not here: a gate with NOTHING held
      // is delaying nothing, so there is nothing to recover. See `_armCatchupWatchdog`.
      _clearCatchupTimer();
      const reqId = ++_reqSeq;
      _reqSentAt = Date.now();
      try {
        deps.send(enc("sync-req", {
          clientId: deps.clientId,
          reqId,
          // The per-session nonce, so the server can filter OUR ops out of the
          // catch-up without filtering out a clone that shares our client id
          // (see `isOwnSessionOp`). A server that predates the field falls
          // back to the client-id filter, exactly as before.
          session: _session,
          cells,
          pendingOps: slice,
          ...(resync.length > 0 ? { resync } : {}),
          // A server write may be pushed to this engine as a patch.
          pushPatch: true,
        }));
        for (const c of resync) _resyncAsked.set(c, reqId);
        // A slice is waiting on this response to send the next one, and a
        // response lost on an open connection would otherwise strand every
        // op queued behind it (new ops wait for the flush). The watchdog asks
        // again — which also re-sends this slice.
        if (more) _armCatchupWatchdog();
      } catch {
        for (const c of resync) _resyncWanted.add(c);
        stopFlush();
        dropHeld(); // no request went out — nothing will open the gate
        // Revert status on send failure
        for (const cell of Object.keys(deps.cells)) {
          const s = statuses.get(cell);
          if (s?.status === "syncing") {
            updateStatus(cell, { status: online ? "online" : "offline" });
          }
        }
      }
    },

    isSyncCell(cellName) {
      return cellName in deps.cells;
    },
    dispose() {
      _clearCatchupTimer();
      stopFlush();
      resetPacing();
      if (_resyncTimer !== undefined) {
        clearTimeout(_resyncTimer);
        _resyncTimer = undefined;
      }
    },
  };
  return engine;
}
