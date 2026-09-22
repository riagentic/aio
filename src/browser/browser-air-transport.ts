// deno-lint-ignore-file
// browser-air-transport: WS/IPC transport layer for AIR renderer.
// Minimal WS transport — WS/IPC <-> state-core bridge, plus the client vitals
// heartbeat on WS (browser-vitals.ts: render meter + `vitals-ping`).

import { diagEmit } from "../diagnostics/diagnostic-bus.ts";
import { _registerSfnTransport, handleSfnResult } from "./server-fns-client.ts";
import { loadDevChunk } from "../air/dev-hooks.ts";
import { isDevMode } from "../state/dev-flag.ts";
import { bindShellTray } from "./tray-actions.ts";
import { installProfileGlobal } from "../air/component-profile.ts";
import { installConsoleIntercept } from "./console-intercept.ts";
import { _coreGetConnectedSignal } from "./browser-protocol.ts";
import { routeCommand } from "./browser-air-commands.ts";
import {
  peerHello,
  PROTOCOL_MISMATCH_CLOSE_CODE,
  protoHello,
  stampedVersion,
} from "../protocol/protocol-version.ts";
import {
  createSendPacer,
  type PacedFrame,
  type SendPacer,
} from "../protocol/send-pacer.ts";
import {
  _checkStateIntegrity,
  _coreGetState,
  _coreHandleMessage,
  _coreHasState,
  _coreResendSubs,
  _coreSetConnected,
  _coreSetTransport,
  type _HandleResult,
  _incStateVersion,
  _resolveStateReady,
  _setClientSend,
  _setConnectFn,
  _setSubscribeTriggers,
  _setTeardownFn,
} from "./browser-protocol.ts";
import {
  _coreOfflineQueueFullness,
  _registerSyncTransport,
} from "./browser-protocol.ts";
import {
  type AioIPCBridge,
  buildWsUrl,
  detectIPC,
  handleControlFrame,
  hasHttpOrigin,
  NO_TRANSPORT_MSG,
} from "./browser-shared.ts";
import {
  dec,
  enc,
  isIgnorableKind,
  v1PeerReason,
} from "../protocol/envelope.ts";
import {
  _armAckTimer,
  _isAckWritten,
  _rejectAck,
  _rejectAllPending,
  _rejectInFlight,
  _unwriteAck,
  ARMS_ACK_TIMER,
} from "./browser-ack.ts";
import { backoffDelay } from "../protocol/transport-shared.ts";
import { _showStatus } from "../protocol/protocol-status.ts";
import { _setDegradedRelay, degradedReport } from "../diagnostics/degraded.ts";
import {
  _nextSeq,
  offlineQueue,
  type QueuedAction,
  type QueuedEntry,
} from "../state/offline-queue.ts";
import { encodeAction } from "../state/action-encode.ts";
import { resetTT } from "../air/time-travel-panel.ts";
import {
  _noteClientPatch,
  _pauseClientVitals,
  _startClientVitals,
  _stopClientVitals,
} from "./browser-vitals.ts";
import { _takeOfflineQueue as _coreTakeOfflineQueue } from "../state/state-transport.ts";
import { count } from "../diagnostics/fmt.ts";

let _ws: WebSocket | null = null;
let _closed = false;
let _connecting = false;
let _wasConnected = false;
let _retry = 0;
const QUEUE_MAX = 1000;
// The ONE queue implementation + drop policy, shared with the isomorphic
// core's send() queue (state/state-transport.ts): at cap the OLDEST action is
// dropped — its pending ack rejects immediately inside the factory (its
// caller would otherwise wait out the full 15s ceiling for a frame that was
// thrown away locally, instantly, and knowably) — and this instance's
// diagnostic fires.
const _queue = offlineQueue(QUEUE_MAX, () => {
  diagEmit({
    type: "browser-air-transport:queue-drop",
    severity: "warning",
    source: "browser-air-transport",
    message: "Queued action dropped (queue full)",
    detail: { max: QUEUE_MAX },
    hint: "Check network connectivity or reduce mutation rate",
  });
});
let _connectionDegraded = false;

/** Actions this page already ACCEPTED for sending — handed to a socket's
 *  pacer (or its flush), then taken back unsent — waiting for the next
 *  connection, in arrival order. Kept OUT of `_queue` on purpose: its cap
 *  bounds calls made while offline, and drops the oldest to do it, so a burst
 *  larger than the cap that met a blip had its EARLIEST calls rejected
 *  "offline queue full" while later ones applied. The pacer holds any number
 *  of accepted calls while online; a blip must not be what decides which of
 *  them fail. `_takePending` and `_dropQueue` merge it with the queues. */
const _carry: QueuedEntry[] = [];
function _carryPush(action: QueuedAction, seq: number): void {
  let i = _carry.length;
  while (i > 0 && _carry[i - 1]!.seq > seq) i--;
  _carry.splice(i, 0, { action, seq });
}

// ── one paced writer per WebSocket ───────────────────────────────────────────
//
// EVERY frame this page writes to its socket goes through `_pacer`: cell
// methods, the offline flush, `useCell().send`, subscriptions, sync ops,
// serverFn calls, forwarded console lines. The server counts all of them
// against one per-connection budget and advertises it in its hello (`rate`),
// so one writer honouring it is the only shape that CAN honour it — a pacer
// per call path would each stay under the budget and add up over it.
//
// MEASURED before this: `Promise.all` over 150 `counter.inc()` calls against
// the default 100/sec. The server dropped 50, closed the socket at the 50th
// with 1008 and blocked the address for a minute; of 150 callers, 146 were
// rejected with "connection lost" — including ~96 whose writes HAD committed.
// A burst now leaves at the advertised pace and resolves late, not never.
//
// IPC is not paced: the UDS relay has no per-connection budget to honour.

/** A frame waiting on the pacer. `action` is set for an action frame, so a
 *  frame still waiting when its socket dies goes back to the offline queue
 *  instead of being lost; `tries` counts server refusals it was re-sent after. */
type OutFrame = PacedFrame & { action?: QueuedAction; tries?: number };

let _pacer: SendPacer<OutFrame> | null = null;
/** The socket `_pacer` writes to. */
let _pacerWs: WebSocket | null = null;

/** The pacer for the CURRENT socket, when it is open — made on first use, so
 *  a socket that reports OPEN is paced whether or not its `onopen` has run
 *  yet. Null when there is no open socket: the caller's no-transport path. */
function _openPacer(): SendPacer<OutFrame> | null {
  const ws = _ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return null;
  if (!_pacer || _pacerWs !== ws) {
    _pacer = _pacerFor(ws);
    _pacerWs = ws;
  }
  return _pacer;
}

/** Detach the pacer and hand back what it still holds (never written). */
function _takePacer(): OutFrame[] {
  const left = _pacer?.take() ?? [];
  _pacer = null;
  _pacerWs = null;
  return left;
}

/** How many times one call is re-sent after the server answers "dropped,
 *  retry after N ms" before its caller gets that refusal. A paced client
 *  should need none; this bounds a server that keeps its window shut (the
 *  global fuse, tripped by OTHER clients) so a call cannot wait forever. */
const MAX_BUDGET_RETRIES = 8;

/** Action frames written and not yet acked — kept so a frame the server drops
 *  with a retry hint can be sent again. Cleared on ack, on close, on teardown. */
const _written = new Map<string, OutFrame>();

function _noteWritten(entry: OutFrame): void {
  const cid = entry.action?.cid;
  if (!cid) return;
  _armAckTimer(cid);
  _written.set(cid, entry);
  // A call whose ack never came (timed out, or settled some other way) leaves
  // its entry behind; sweep those rather than grow with a long-lived page.
  if (_written.size > 2048) {
    for (const k of _written.keys()) if (!_isAckWritten(k)) _written.delete(k);
  }
}

/** The pacer for `ws`: writes, arms each call's clock at the moment its frame
 *  actually leaves, and hands refused frames back to the offline queue. */
function _pacerFor(ws: WebSocket): SendPacer<OutFrame> {
  return createSendPacer<OutFrame>({
    write: (entry) => {
      // A browser socket that is CLOSING takes `send()` without a throw and
      // discards the frame — so a drain in the gap before `onclose` would
      // "write" into nothing and arm clocks for calls that never left. Refuse
      // instead; the frame goes back to the offline queue.
      if (ws.readyState !== WebSocket.OPEN) {
        throw new Error("the socket is no longer open");
      }
      ws.send(entry.frame);
      _noteWritten(entry);
    },
    onRefused: (entries, err) => _takeBackRefused(entries, err),
    rate: () => peerHello()?.rate,
  });
}

/** Frames never written (still paced, or refused by the socket): actions back
 *  into the offline queue at their place in line, everything else dropped.
 *  None of them was written, so no caller is in flight and none is rejected
 *  here — whoever empties the queue next answers for them. */
function _requeuePaced(
  entries: OutFrame[],
): { requeued: number; dropped: number } {
  let requeued = 0;
  let dropped = 0;
  for (const e of entries) {
    const action = e.action ?? _coreAction(e.frame);
    if (action) {
      _carryPush(action, e.seq);
      requeued++;
    } else dropped++;
  }
  return { requeued, dropped };
}

/** …and the same for a live connection, which owes the offline notice. */
function _takeBackRefused(entries: OutFrame[], err?: unknown): void {
  const { requeued, dropped } = _requeuePaced(entries);
  if (requeued > 0) {
    _updateDegraded();
    _noteQueued();
  }
  if (err !== undefined && (requeued > 0 || dropped > 0)) {
    console.warn(
      `[aio:air] the WebSocket refused a paced write (${
        err instanceof Error ? err.message : String(err)
      }) — ${count(requeued, "action")} back in the offline queue, in order; ` +
        `${count(dropped, "unqueued frame")} (sync ops resend from their ` +
        `buffer, serverFn calls reject on the disconnect, log lines are lost).`,
    );
  }
}

/** An action frame written by the CORE transport (`useCell().send`, the core
 *  queue's flush) carries no action object here — recover it from the frame
 *  so it can be re-queued too. Anything else is not an action. */
function _coreAction(frame: string): QueuedAction | null {
  const f = dec(frame);
  if (f?.t !== "action") return null;
  const a = f.d as QueuedAction | null;
  return a && typeof a.type === "string" ? a : null;
}

/** The server dropped a call's frame before running it and said when a re-send
 *  will be taken (`AckPayload.retryAfterMs`). Hold the call and send it again,
 *  instead of failing a write that was never attempted. Returns true when the
 *  ack was consumed that way; false lets it settle the caller as usual. */
let _retryNoted = false;
function _retryRefusedCall(d: unknown): boolean {
  const { cid, ok, retryAfterMs, error } = (d ?? {}) as {
    cid?: unknown;
    ok?: unknown;
    retryAfterMs?: unknown;
    error?: unknown;
  };
  if (typeof cid !== "string") return false;
  const entry = _written.get(cid);
  _written.delete(cid);
  if (
    ok === true || !entry?.action || typeof retryAfterMs !== "number" ||
    !Number.isFinite(retryAfterMs) || retryAfterMs < 0 ||
    // Still awaited: a call that already timed out was told it failed, and
    // re-sending it would land a write its caller gave up on. The CLI client
    // had this check and this transport did not — a refusal read late by a
    // stalled server re-sent a call whose `await` had already rejected.
    !_isAckWritten(cid)
  ) return false;
  if ((entry.tries ?? 0) >= MAX_BUDGET_RETRIES) return false;
  // Not in flight any more — the server said so. A close from here on must
  // re-queue this call, not reject it.
  _unwriteAck(cid);
  const again: OutFrame = { ...entry, tries: (entry.tries ?? 0) + 1 };
  if (!_retryNoted) {
    _retryNoted = true;
    console.warn(
      // The server's own reason, not a guess at it: a budget drop is per
      // message, per byte or the server-wide fuse, and naming the wrong knob
      // sends the reader to raise a limit that was never hit.
      `[aio:air] the server dropped a call and asked for a re-send in ${
        Math.round(retryAfterMs)
      }ms (${
        typeof error === "string" ? error : "over a per-second budget"
      }) — held and re-sent, not failed. If this repeats, raise the budget ` +
        `it names in aio.run({ wsLimits: { messagesPerSec, bytesPerSec } }) ` +
        `or batch the calls. Further re-sends are not repeated here.`,
    );
    diagEmit({
      type: "browser-air-transport:budget-retry",
      severity: "warning",
      source: "browser-air-transport",
      message: "Server dropped a call over its budget — re-sending",
      detail: { retryAfterMs, tries: again.tries },
      hint: "Pacing to the advertised rate normally prevents this; a server " +
        "that stalls, or other clients tripping the global fuse, can still " +
        "cause it",
    });
  }
  const pacer = _openPacer();
  if (pacer) {
    // Nothing this socket sends can be taken before the window reopens.
    pacer.hold(Math.min(retryAfterMs, 10_000));
    pacer.push(again);
  } else {
    _carryPush(again.action!, again.seq);
    _updateDegraded();
    _noteQueued();
  }
  return true;
}

/** The one fraction that means "this connection is in trouble". Both offline
 *  queues are measured against it; writing 0.8 in each place would be two
 *  deciders for one threshold, and they would drift the first time anyone
 *  tuned it. */
const DEGRADED_AT = 0.8;

function _updateDegraded(): void {
  const degraded = _queue.fullness() > DEGRADED_AT;
  if (_connectionDegraded !== degraded) _connectionDegraded = degraded;
}

/** True when EITHER offline queue is past 80% full.
 *
 *  There are two queues for a structural reason (see `_offlineQueueFullness`):
 *  cell-method dispatch queues here, while `useCell().send` / `useAio().send`
 *  queue in the isomorphic core, which cannot import this module. But "is this
 *  connection degraded" is ONE fact, and this used to answer for this queue
 *  alone — so the indicator the docs tell you to render stayed `false` however
 *  backed up a `send()` caller became. */
function _anyQueueDegraded(): boolean {
  if (_connectionDegraded) return true;
  try {
    return _coreOfflineQueueFullness() > DEGRADED_AT;
  } catch {
    // The core transport module is always present in a browser build; if a
    // host ever lacks it, the local queue's answer still stands.
    return false;
  }
}

/** Returns true when the offline action queue is >80% full — UI can use this
 *  to show a "reconnecting / slow connection" indicator. */
export function isConnectionDegraded(): boolean {
  return _anyQueueDegraded();
}
let _onSyncMessage: ((t: string, d: unknown) => void) | null = null;

/** Register a handler for sync frames (op / sync-ack / sync-res / …). */
export function setSyncMessageHandler(
  handler: ((t: string, d: unknown) => void) | null,
): void {
  _onSyncMessage = handler;
}

const _bootId: { current: string | null } = { current: null };
const _ipc: AioIPCBridge | null = detectIPC();
// The tray (ui.tray) relays a clicked item through the SHELL bridge, which
// both Electron shells expose whatever the transport — so it is bound here,
// once, beside the transport choice, not inside one of them.
bindShellTray();
let _ipcConnected = false;
/** The IPC bridge's onOpen/onMessage/onClose are registered once per page —
 *  the bridge has no unbind, so re-registering on reconnect duplicates frames. */
let _ipcBound = false;
let _ipcPingTimer: ReturnType<typeof setInterval> | null = null;

/** Connection status: console trace + the on-page indicator.
 *
 *  The widget is what `ui: { showStatus: false }` turns off (the shell writes
 *  `window.__aioShowStatus`, which `_showStatus` reads). Only the orphaned
 *  transport ever called it, so the config flag toggled nothing at all and a
 *  reconnecting app looked identical to a working one. */
function _status(text: string, color = "#e25", autohide?: number) {
  console.debug("[aio:air]", text);
  if (typeof document !== "undefined") _showStatus(text, color, autohide);
}

function _handleState(data: Record<string, unknown>) {
  const r: _HandleResult = _coreHandleMessage(data);
  if (r === "dropped" || r === "noop") return;
  // Applied, not yet painted — the render meter's staleness clock starts.
  _noteClientPatch();
  _checkStateIntegrity(_coreGetState(), { full: !("$patches" in data) });
  _incStateVersion();
  if (_coreHasState()) _resolveStateReady();
}

// Register with the sync-engine seam: raw sends for op/sync-req envelopes,
// and the wiring setter that plugs the engine into message + online events.
_registerSyncTransport(
  (raw) => _sendRaw(raw),
  (onMsg, onOnline) => {
    setSyncMessageHandler(onMsg);
    _syncOnline = onOnline;
  },
);
// serverFn client (B3): raw sends for sfn calls.
_registerSfnTransport((raw) => _sendRaw(raw));
let _syncOnline: ((v: boolean) => void) | null = null;

/** Raw frame out, no queue and no ack — sync ops, serverFn calls, log frames,
 *  `client-state` replies. Returns whether it actually left.
 *
 *  NO TRANSPORT is a normal, expected state (the page has not connected yet, or
 *  it is offline) and stays silent here: every caller answers for it in its own
 *  terms — the sync engine holds the op in its buffer, `serverFn` rejects the
 *  call by name, `console` still prints locally.
 *
 *  A transport that REFUSES THE WRITE is not. The socket says OPEN and throws
 *  anyway, so no `onclose` follows and no reconnect is scheduled: the frame is
 *  gone and nothing else in this process will ever learn it. It used to be
 *  swallowed by a bare catch labelled "buffer full" — the same silent drop the
 *  action path two functions below carries a paragraph about NOT doing. */
let _rawDropWarned = false;
function _sendRaw(msg: string): boolean {
  const pacer = _openPacer();
  if (pacer) {
    try {
      // `true` for a frame the pacer holds, too: it leaves on this socket at
      // the advertised pace, and if the socket dies first each caller already
      // answers for that (sync ops resend from the buffer, serverFn rejects
      // on the disconnect).
      pacer.push({ frame: msg, seq: _nextSeq() });
      return true;
    } catch (e) {
      if (!_rawDropWarned) {
        _rawDropWarned = true;
        console.error(
          `[aio:air] the WebSocket refused a write while reporting OPEN (${
            e instanceof Error ? e.message : String(e)
          }) — that frame was DROPPED. Unqueued frames go this way: sync ops, ` +
            `serverFn calls, forwarded console lines. Further drops are not ` +
            `repeated.`,
        );
        diagEmit({
          type: "browser-air-transport:raw-send-failed",
          severity: "error",
          source: "browser-air-transport",
          message:
            "Transport refused a write on an OPEN socket — frame dropped",
          detail: { kind: msg.slice(0, 40) },
          hint: "The send buffer is full or the socket is closing. Unqueued " +
            "frames (sync ops, serverFn, log) are lost, not retried.",
        });
      }
      return false;
    }
  }
  if (_ipc && _ipcConnected) {
    _ipc.send(msg);
    return true;
  }
  return false;
}

/** One demux for both AIR transports (WS + IPC): decode once, route. */
function _route(line: string): void {
  const f = dec(line);
  if (!f) {
    // The one v1 shim: a v1 server's hello/refusal is still readable.
    const v1 = v1PeerReason(line);
    if (v1) {
      // TERMINAL, exactly like the v2 `proto-err` path — the two sides cannot
      // read each other's frames, so retrying cannot fix it. This branch only
      // logged: it did not stop the reconnect loop, drop the queue, or reject
      // the pending calls. It looked harmless only because `negotiateProtocol`
      // is symmetric, so the client usually reached the same verdict from the
      // server's own hello — two deciders for "terminally refused", one of
      // them inert.
      console.error(`[aio:air] protocol version mismatch: ${v1}`);
      _protoMismatch(v1);
    } else console.warn("[aio:air] undecodable frame — dropped");
    return;
  }
  if (handleControlFrame(f, _bootId, _protoMismatch)) return;
  if (f.t === "ack" && _retryRefusedCall(f.d)) return;
  if (routeCommand(f, _sendRaw)) return;
  switch (f.t) {
    case "sfnr":
      handleSfnResult(f.d);
      return;
    case "op":
    case "op-rejected":
    case "sync-ack":
    case "sync-res":
    case "sync-err":
      if (typeof _onSyncMessage === "function") {
        _onSyncMessage(f.t, f.d);
      } else {
        console.warn(
          `[aio:air] sync frame "${f.t}" but no handler — discarding`,
        );
      }
      return;
    case "get-state":
      // `am client <idx>` asks a CLIENT for its view of state. The orphaned
      // WS and IPC transports answer it; this one had no case, so the frame
      // fell through to "unexpected … dropped" and the tooling just waited —
      // a silent failure of the inspect path against any AIR client.
      try {
        _sendRaw(enc("client-state", _coreGetState()));
      } catch (err) {
        _sendRaw(enc("client-state", { error: String(err) }));
      }
      return;
    case "state":
      _handleState(f.d as Record<string, unknown>);
      return;
    case "patches":
      _handleState({ $patches: f.d });
      return;
    default:
      // Reserved-ignorable kinds ("x" extension frames) skip silently BY
      // CONTRACT — see IGNORABLE in envelope.ts.
      if (isIgnorableKind(f.t)) return;
      console.warn(`[aio:air] unexpected "${f.t}" frame — dropped`);
      return;
  }
}

/** A version gap is terminal: the two sides cannot read each other's frames,
 *  so stop rather than keep trading garbage, and stop RETRYING — reconnecting
 *  cannot close a version gap (mirrors the WS transport). */
function _protoMismatch(reason: string) {
  _status("Protocol mismatch — reload/update the app");
  _closed = true; // stop the reconnect loop
  _terminal = true; // …and keep it stopped: see `_tryConnect`
  // Terminal: nothing will ever flush this queue, so the queued frames are
  // gone — say so, and reject their callers TOO (rejectAll, not
  // rejectInFlight). A rejection is only honest when the frame is really dead.
  _dropQueue("the connection is terminally closed (protocol mismatch)");
  _rejectAllPending(new Error(`protocol version mismatch: ${reason}`));
  try {
    _ws?.close(PROTOCOL_MISMATCH_CLOSE_CODE, "protocol mismatch");
  } catch { /* already closing */ }
  _ws = null;
  _ipcConnected = false;
  _connecting = false;
}

/** Throw the offline queue away — the ONLY place that may — and reject the
 *  callers whose frames it holds. The queue is in memory: it survives a
 *  disconnect (and flushes on reconnect) but nothing else, so every path that
 *  discards it owes those callers an error instead of silence. */
function _dropQueue(why: string): void {
  // BOTH queues. Two exist for a structural reason — cell-method dispatch
  // here, `useCell().send` in the core, which cannot import this module — and
  // `_takePending` above already knows that. This did not: it drained its own
  // and left the core one holding actions, while announcing "N queued
  // action(s) discarded". Measured: a teardown reported one action discarded
  // and a second survived it, then replayed onto a LATER connection — a write
  // the app was told was thrown away, landing minutes afterwards. The same
  // applied to a protocol mismatch, which calls this and then rejects every
  // pending caller.
  // …and the paced frames not yet written, which are the same thing a moment
  // earlier. Back into the queue first, so the one drain below covers them.
  _requeuePaced(_takePacer());
  _written.clear();
  const q = [
    ..._carry.splice(0),
    ...(_queue.drainEntries() as QueuedEntry[]),
    ..._coreTakeOfflineQueue(),
  ];
  _connectionDegraded = false;
  _offlineWarned = false;
  if (q.length === 0) return;
  console.warn(
    `[aio:air] ${q.length} queued action(s) discarded — ${why}. They were ` +
      `never sent; their callers reject.`,
  );
  for (const { action } of q) {
    const cid = (action as { cid?: unknown }).cid;
    if (typeof cid === "string") {
      _rejectAck(cid, new Error(`action was never sent — ${why}`));
    }
  }
}

/** One-time-per-offline-period notice that the queue is RAM-only. */
let _offlineWarned = false;
function _noteQueued(): void {
  if (_offlineWarned) return;
  _offlineWarned = true;
  console.warn(
    `[aio:air] offline — actions are queued IN MEMORY and replay on ` +
      `reconnect, but a page reload discards them (they are not persisted).`,
  );
  diagEmit({
    type: "browser-air-transport:offline-queue",
    severity: "warning",
    source: "browser-air-transport",
    message: "Actions queued in memory while offline",
    detail: { max: QUEUE_MAX },
    hint: "The queue is not persisted — a reload before reconnect loses it",
  });
}

/** Empty BOTH offline queues and return everything waiting, in the order the
 *  user acted.
 *
 *  Called BEFORE the transport is installed, on purpose: installing it is what
 *  makes the isomorphic core flush its own queue (state-core's setTransport →
 *  flushOfflineQueue), and that is exactly the replay whose order we are
 *  fixing. Two queues exist for a structural reason (cell-method dispatch here,
 *  `useCell().send` in the core, which cannot import this module) — but "what
 *  did the user do, and in what order" is ONE fact, and replaying one whole
 *  queue after the other silently reordered it. */
function _takePending(): QueuedEntry[] {
  const carried = _carry.splice(0);
  const mine = _queue.drainEntries();
  const core = _coreTakeOfflineQueue();
  _connectionDegraded = false;
  _offlineWarned = false;
  const parts = [carried, mine, core].filter((p) => p.length > 0);
  if (parts.length <= 1) return parts[0] ?? [];
  return parts.flat().sort((a, b) => a.seq - b.seq);
}

/** Replay `pending` through `send`.
 *
 *  A send that throws stops the replay and hands the REMAINDER back to the
 *  queue at the place in line it already had. It used to drain first and send
 *  second, so a throw mid-flush lost every action after it AND left their
 *  callers pending forever — both lost and unanswered, the one outcome the
 *  queue contract forbids. The socket that refuses a write is offline in every
 *  way that matters to these actions, which is precisely what the queue is
 *  for: they wait for the next open. */
function _flushPending(
  pending: QueuedEntry[],
  send: (e: QueuedEntry) => void,
) {
  for (let i = 0; i < pending.length; i++) {
    try {
      send(pending[i]!);
    } catch (err) {
      const rest = pending.slice(i);
      // Accepted already — back where they were, never through the cap.
      for (const e of rest) _carryPush(e.action, e.seq);
      _updateDegraded();
      console.warn(
        `[aio:air] offline flush stopped after ${
          count(i, "action")
        } — the transport ` +
          `refused the write (${
            err instanceof Error ? err.message : String(err)
          }). The remaining ${
            count(rest.length, "action")
          } are back in the queue, in ` +
          `order, and replay on the next connection; none of them were lost ` +
          `and none of their callers were left waiting on a frame that is not ` +
          `coming.`,
      );
      diagEmit({
        type: "browser-air-transport:flush-failed",
        severity: "warning",
        source: "browser-air-transport",
        message: "Offline flush failed part-way — remainder re-queued",
        detail: { sent: i, requeued: rest.length },
        hint: "The connection dropped again mid-replay; the queue is intact",
      });
      _noteQueued();
      return;
    }
  }
}

function _scheduleReconnect() {
  // The shared authority, not a private copy of it: `backoffDelay` adds ±20%
  // jitter precisely so that when one server restarts, its clients do not all
  // reconnect on the same millisecond. This inlined its own formula with no
  // jitter (and a 30s ceiling against the shared 8s), so every AIR client
  // retried in lockstep — the thundering herd the shared helper exists to
  // prevent.
  const delay = backoffDelay(_retry);
  _retry++;
  // Tracked, so a teardown can cancel it. Untracked, a client torn down
  // between a close and its retry still reconnected — to a server it had
  // just been told to leave — and the timer was the one thing keeping a
  // finished page (or a test) alive for the whole backoff.
  if (_reconnectTimer !== null) clearTimeout(_reconnectTimer);
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    _connect();
  }, delay);
}
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// If the Electron bridge answers neither onOpen nor onClose, the flags set
// below stay true forever: `_tryConnect` sees a live attempt, never retries,
// and the client sits there with no connection, no retry and no error.
// `_ipcConnected` doubles as the re-entry guard that keeps the bridge from
// being bound twice, so it cannot simply be deferred to onOpen — a watchdog
// releases it instead.
const IPC_CONNECT_TIMEOUT_MS = 10_000;
let _ipcWatchdog: ReturnType<typeof setTimeout> | null = null;
function _clearIpcWatchdog() {
  if (_ipcWatchdog !== null) {
    clearTimeout(_ipcWatchdog);
    _ipcWatchdog = null;
  }
}

function _connectIPC() {
  if (!_ipc || _ipcConnected) {
    _connecting = false;
    return;
  }
  _ipcConnected = true;
  _clearIpcWatchdog();
  _ipcWatchdog = setTimeout(() => {
    _ipcWatchdog = null;
    if (_closed || _wasConnected) return; // opened (or torn down) meanwhile
    console.warn(
      `[aio:air] IPC bridge did not open within ${IPC_CONNECT_TIMEOUT_MS}ms — retrying`,
    );
    _ipcConnected = false;
    _connecting = false;
    _scheduleReconnect();
  }, IPC_CONNECT_TIMEOUT_MS);
  // Bind the bridge callbacks EXACTLY once. The preload bridge registers with
  // `ipcRenderer.on` (additive, and it exposes no `off`), while _connectIPC
  // runs again on every reconnect — so each server restart added another
  // handler and every later frame was routed N+1 times. Patch frames are not
  // idempotent (an Immer array `add` applied twice inserts twice), so a single
  // reconnect was enough to duplicate items in the UI. Reconnection only needs
  // to flip the flag and re-arm the bridge.
  if (_ipcBound) {
    _ipc.ready();
    return;
  }
  _ipcBound = true;
  _ipc.onOpen(() => {
    _clearIpcWatchdog();
    _connecting = false;
    _retry = 0;
    if (_wasConnected) _status("Connected", "#2a2", 2000);
    _wasConnected = true;
    // Before _coreSetTransport — installing it flushes the core's queue.
    const pending = _takePending();
    _coreSetTransport({ send: (d: string) => _ipc!.send(d), close: () => {} });
    _coreSetConnected(true);
    _syncOnline?.(true);
    _coreResendSubs();
    _flushPending(pending, (e) => {
      _ipc!.send(enc("action", e.action));
      // The frame is out now — this is when a queued call's ack clock starts.
      if (e.action.cid) _armAckTimer(e.action.cid);
    });
    _wireDegradedRelay();
    if (!_ipcPingTimer) {
      _ipcPingTimer = setInterval(() => {
        if (_ipc && _ipcConnected) _ipc.send(enc("ping"));
      }, 60_000);
    }
  });
  _ipc.onMessage(_route);
  _ipc.onClose(() => {
    _clearIpcWatchdog();
    _ipcConnected = false;
    _connecting = false;
    // The connection is known gone: fail the calls waiting on it NOW instead
    // of letting each one sit out its full 15s ack ceiling and report a
    // timeout.
    //
    // IN-FLIGHT ONLY. `_queue` survives this close and flushes on the next
    // open, so rejecting a still-queued call told its caller the action had
    // failed and then sent it anyway — one user intent, one rejection AND one
    // application. A queued call has not been written; nothing can have
    // applied it; its promise waits for the flush.
    _rejectInFlight(new Error("connection lost"));
    _setDegradedRelay(null);
    _coreSetTransport(null);
    _coreSetConnected(false);
    _syncOnline?.(false);
    if (_ipcPingTimer) {
      clearInterval(_ipcPingTimer);
      _ipcPingTimer = null;
    }
    if (_closed) return;
    if (_wasConnected) _status("Reconnecting\u2026");
    _scheduleReconnect();
  });
  _ipc.ready();
}

/** Health visibility: this runtime's `degraded()` escalations travel to the
 *  server as `cdiag` frames so /__aio/health can see a dead browser subsystem.
 *  Re-pointed at each new connection, and anything already degraded is
 *  replayed — it may have escalated while offline. (Only the orphaned WS
 *  transport ever registered this relay, so no shipped client reported client
 *  degradations at all.) */
function _wireDegradedRelay(): void {
  _setDegradedRelay((ev) => _sendRaw(enc("cdiag", ev)));
  for (const d of degradedReport()) {
    _sendRaw(enc("cdiag", { kind: "down", ...d }));
  }
}

function _connect() {
  if (_closed) return;
  if (_ipc && !_ws) {
    _connectIPC();
    return;
  }
  if (_ws) return;
  // NEVER fall back to WS on a page whose origin has no HTTP. On an aio://
  // page `buildWsUrl()` is `ws://app/ws` — a socket that cannot exist in a
  // zero-port app — and the retry loop would sit on it forever, the window
  // blank. That is the hot-reload failure that kept zero-port opt-in for a while:
  // the reloaded page had the bridge (the preload re-injects it) but this
  // function only ever reached IPC through the branch above, so with the
  // bridge missing it degraded QUIETLY. Now it stops, says why, and throws.
  if (!hasHttpOrigin()) {
    _connecting = false;
    _closed = true; // no retry loop — retrying cannot conjure an origin
    _status(NO_TRANSPORT_MSG);
    diagEmit({
      type: "browser-air-transport:no-transport",
      severity: "error",
      source: "browser-air-transport",
      message: NO_TRANSPORT_MSG,
      hint: "open the app through its Electron window (deno task dev), " +
        "not as a file or a foreign scheme",
    });
    throw new Error(`[aio:air] ${NO_TRANSPORT_MSG}`);
  }
  const ws = new WebSocket(buildWsUrl());
  ws.onopen = () => {
    _connecting = false;
    _retry = 0;
    // A fresh budget per socket — the server's counters are per connection.
    const pacer = _openPacer() ?? _pacerFor(ws);
    // Before _coreSetTransport — installing it flushes the core's queue.
    const pending = _takePending();
    _coreSetTransport({
      send: (d) => void pacer.push({ frame: d, seq: _nextSeq() }),
      close: () => ws.close(),
    });
    _coreSetConnected(true);
    _syncOnline?.(true);
    // Announce our wire-protocol version before anything else — without this
    // hello the server's version gate never applies to AIR clients.
    pacer.push({
      frame: enc("proto", protoHello(stampedVersion())),
      seq: _nextSeq(),
    });
    const ua = typeof navigator !== "undefined" &&
      /electron/i.test(navigator.userAgent);
    pacer.push({
      frame: enc("type", { kind: ua ? "electron" : "browser" }),
      seq: _nextSeq(),
    });
    if (_wasConnected) _status("Connected", "#2a2", 2000);
    _wasConnected = true;
    _coreResendSubs();
    _flushPending(pending, (e) =>
      void pacer.push({
        frame: enc("action", e.action),
        action: e.action,
        seq: e.seq,
      }));
    _wireDegradedRelay();
    // Client vitals ride the WS only (envelope.ts: `vitals-ping` is refused
    // on UDS/IPC). The heartbeat is per connection; the meter is per page.
    _startClientVitals(
      _sendRaw,
      () => _ws === ws && ws.readyState === WebSocket.OPEN,
    );
  };
  ws.onmessage = (e) => {
    if (typeof e.data !== "string") return;
    _route(e.data);
  };
  ws.onclose = (ev?: CloseEvent) => {
    // A socket that is no longer THE socket has nothing to say about the
    // connection. `close()` is asynchronous — `onclose` lands after the
    // handshake — so a teardown (`_closed = true; _ws = null`) followed by a
    // reconnect before that lands (`_tryConnect` resets `_closed` and opens
    // ws2) had the OLD socket's `onclose` arrive against the new one: it
    // nulled `_ws` (ws2's only handle), tore the transport down and scheduled
    // a reconnect that opened ws3 while ws2 was still open. Two live sockets
    // on one page, each receiving every broadcast — and a patch frame applied
    // twice inserts twice.
    if (_ws !== null && _ws !== ws) return;
    _ws = null;
    // Frames still waiting on this socket's pacer were never written: actions
    // go back to the offline queue (before the in-flight rejection below, which
    // must not — and does not — touch them) and replay on the next open.
    _takeBackRefused(_takePacer());
    _written.clear();
    if (ev?.code === 1008) {
      // The server's anti-abuse close. Said out loud: the reconnect below may
      // be refused (429) for a few seconds while its block runs.
      console.error(
        `[aio:air] the server closed this connection: ${
          ev.reason || "policy violation"
        } (1008). Queued actions are kept and replay when it reconnects; ` +
          `calls already sent are rejected as "connection lost".`,
      );
      diagEmit({
        type: "browser-air-transport:closed-by-policy",
        severity: "error",
        source: "browser-air-transport",
        message: `Server closed the connection: ${ev.reason || "1008"}`,
        hint: "The server's per-connection message budget was exceeded; it " +
          "may refuse reconnects briefly (see the server log for how long)",
      });
    }
    _pauseClientVitals();
    // In-flight only — the queue survives and flushes on reconnect (see the
    // IPC close above for the full reasoning).
    _rejectInFlight(new Error("connection lost"));
    _setDegradedRelay(null);
    _coreSetTransport(null);
    _coreSetConnected(false);
    _syncOnline?.(false);
    if (_closed) return;
    _connecting = true;
    if (_wasConnected) _status("Reconnecting\u2026");
    _scheduleReconnect();
  };
  ws.onerror = () => ws.close();
  _ws = ws;
}

/** THE way an action enters the offline queue — every path that cannot write
 *  a frame goes through here.
 *
 *  The WS-throw path used to push straight onto `_queue`: past `QUEUE_MAX`
 *  (a socket that reports OPEN and throws on every send grows it without any
 *  bound), past the drop-rejection (the evicted action's caller waits out the
 *  full 15s ack ceiling for a frame discarded locally and instantly), past the
 *  `queue-drop` diagnostic and past the RAM-only offline notice. "How does an
 *  action get queued" is one question; it had two answers, and only one of them
 *  was the one everything else was written against. */
function _enqueue(tagged: { type: string; payload?: unknown }): void {
  // The drop policy (oldest-first + reject-that-ack) and its diagnostic live
  // in the shared factory — see offline-queue.ts.
  _queue.push(tagged);
  _updateDegraded();
  _noteQueued();
}

function _send(action: { type: string; payload?: unknown }) {
  const tagged = { ...action, _source: "UI" };
  const cid = (tagged as { cid?: string }).cid;
  // The frame is built through the ONE action door (state/action-encode.ts):
  // it names the action when JSON cannot carry the payload, and in dev it says
  // which argument the wire is about to change (a Date into a string, a Map
  // into `{}`) — the loss an in-process test cannot see, and the one
  // `serverFn` arguments have been warned about since alpha76.
  //
  // A refusal here used to throw out of `enc` with `Do not know how to
  // serialize a BigInt` — no method named — while the ack registered for this
  // call was left pending with no timer armed, so `await cell.method(1n)`
  // never settled. Reject it first, then throw: the caller hears it once,
  // through the channel it is already waiting on.
  let json: string;
  try {
    json = encodeAction(tagged);
  } catch (err) {
    if (cid) {
      _rejectAck(cid, err instanceof Error ? err : new Error(String(err)));
    }
    throw err;
  }
  if (_terminal) {
    // Nothing will ever flush the queue after a version gap (`_dropQueue`
    // said so when it emptied it), so queueing here is a silent drop with a
    // promise that never settles. The caller hears the same verdict the
    // queued callers heard, now.
    if (cid) {
      _rejectAck(
        cid,
        new Error("action was never sent — protocol version mismatch"),
      );
    }
    _noteTerminalDrop(tagged.type);
    return;
  }
  const pacer = _openPacer();
  if (pacer) {
    try {
      // The pacer arms the call's clock when the frame actually leaves.
      pacer.push({ frame: json, action: tagged, seq: _nextSeq() });
    } catch {
      // The socket says OPEN and refuses the write — it is offline in every
      // way that matters to this action. Queue it exactly as the no-transport
      // path does.
      _enqueue(tagged);
    }
  } else if (_ipc && _ipcConnected) {
    // The SAME rule as the WS branch above, which it did not have: a bridge
    // that refuses the write is offline in every way that matters to this
    // action. Without this the throw propagated synchronously out of the cell
    // binding's dispatch — so one transport queued the action and recovered,
    // and the other threw at the call site, for the same failure. Electron is
    // the target that uses this branch.
    try {
      _ipc.send(json);
      if (cid) _armAckTimer(cid);
    } catch {
      _enqueue(tagged);
    }
  } else {
    _enqueue(tagged);
  }
}

// ── Wire transport into protocol layer ──────────────────────────────

/** Set once a version gap has been diagnosed and never cleared: the two sides
 *  cannot read each other's frames, and no reconnect can change what either
 *  side is running. `_closed` alone did not hold — `_tryConnect` resets it for
 *  every new subscriber (`client.subscribe`, `_waitForState`), so each one
 *  re-opened a socket the server refused again, and each refusal re-ran
 *  `_protoMismatch`: the queue emptied and every pending call rejected once
 *  per subscriber, for a page whose only remedy is a reload. */
let _terminal = false;
let _terminalDropWarned = false;
function _noteTerminalDrop(type: string): void {
  if (_terminalDropWarned) return;
  _terminalDropWarned = true;
  console.warn(
    `[aio:air] "${type}" was not sent — the connection is terminally closed ` +
      `(protocol version mismatch). Reload/update the app. Further drops ` +
      `are not repeated.`,
  );
}

function _tryConnect() {
  if (_terminal) return; // a version gap has no reconnect
  if (!_ws && !_ipcConnected && !_connecting) {
    _closed = false;
    _connecting = true;
    _connect();
  }
}

_setConnectFn(_tryConnect);
_setSubscribeTriggers(_tryConnect, () => {});

_setTeardownFn(() => {
  _closed = true;
  _clearIpcWatchdog();
  if (_reconnectTimer !== null) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }
  _ws?.close();
  _ws = null;
  _ipcConnected = false;
  _connecting = false;
  _setDegradedRelay(null);
  _stopClientVitals();
  if (_ipcPingTimer) {
    clearInterval(_ipcPingTimer);
    _ipcPingTimer = null;
  }
  // Teardown DISCARDS the queue, so every caller still waiting on it hears
  // about it — silently emptying it left those promises pending forever (their
  // clocks are deferred until the frame is written, and it never will be).
  _dropQueue("the client was torn down");
  _rejectAllPending(new Error("client torn down before the server confirmed"));
  _retry = 0;
  // The time-travel panel is part of "nothing of this client outlives it": it
  // holds a `keydown` listener on `document` and a node in the DOM, and both
  // survived every teardown. `resetTT`'s own doc comment said it was "called
  // from browser.ts _reset() and teardown" — browser.ts has not existed since
  // alpha52, and the one import of it (in browser-protocol.ts) was aliased to
  // `_resetTT`, which is exactly the spelling that silences the unused-import
  // lint. Three layers of looking wired, and one leaked document listener per
  // teardown.
  resetTT();
});

// Arms ack clocks itself: on write in `_send`, and on flush for queued actions.
(_send as unknown as Record<symbol, boolean>)[ARMS_ACK_TIMER] = true;
_setClientSend(_send);
// The channel question is the CONNECTED signal — the one every consumer of
// "is this client online" reads (`useAio().connected`, serverFn) — so a line
// written before the socket opens is not scored as a refused write.
// "Is there a channel?" is `_sendRaw`'s own test, not the connected signal:
// a socket that reports OPEN is a channel before its `onopen` has run, and a
// refused write on it is a real failure that must still be counted.
installConsoleIntercept(
  _sendRaw,
  () => (_ws?.readyState === WebSocket.OPEN) || (!!_ipc && _ipcConnected),
);
// …and in dev, the same problems ON THE PAGE, plus the two DOM audits and the
// `am surface` / `am trigger` executor. All of it is in ONE dynamically
// imported module (browser/dev-diagnostics.ts) that the browser bundler marks
// external, so a production page carries none of it — 32,878 bytes raw,
// 12.0 KB gz measured. The specifier is the dev server's own live-transpile
// route, which is why it resolves in dev and 404s (loudly, once) in prod. See
// air/dev-hooks.ts for the dev==prod argument, module by module.
if (isDevMode()) void loadDevChunk();
// …and `__aioProfile()`, so `am eval '__aioProfile()'` answers "what is
// rendering most, and what is each render costing" without anyone having to
// add up `_dtRenders` by hand. Counts are always collected; only the clock is
// opt-in, and calling this turns it on — see air/component-profile.ts.
installProfileGlobal();
