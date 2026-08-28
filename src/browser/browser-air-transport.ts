// deno-lint-ignore-file
// browser-air-transport: WS/IPC transport layer for AIR renderer.
// Minimal WS transport — WS/IPC <-> state-core bridge, plus the client vitals
// heartbeat on WS (browser-vitals.ts: render meter + `vitals-ping`).

import { diagEmit } from "../diagnostics/diagnostic-bus.ts";
import { _registerSfnTransport, handleSfnResult } from "./server-fns-client.ts";
import { installConsoleIntercept } from "./console-intercept.ts";
import { routeCommand } from "./browser-air-commands.ts";
import {
  PROTOCOL_MISMATCH_CLOSE_CODE,
  protoHello,
  stampedVersion,
} from "../protocol/protocol-version.ts";
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
  _rejectAck,
  _rejectAllPending,
  _rejectInFlight,
  ARMS_ACK_TIMER,
} from "./browser-ack.ts";
import { backoffDelay } from "../protocol/transport-shared.ts";
import { _showStatus } from "../protocol/protocol-status.ts";
import { _setDegradedRelay, degradedReport } from "../diagnostics/degraded.ts";
import { offlineQueue, type QueuedEntry } from "../state/offline-queue.ts";
import {
  _noteClientPatch,
  _pauseClientVitals,
  _startClientVitals,
  _stopClientVitals,
} from "./browser-vitals.ts";
import { _takeOfflineQueue as _coreTakeOfflineQueue } from "../state/state-transport.ts";

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
  _checkStateIntegrity(_coreGetState());
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
  if (_ws && _ws.readyState === WebSocket.OPEN) {
    try {
      _ws.send(msg);
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
    if (v1) console.error(`[aio:air] protocol version mismatch: ${v1}`);
    else console.warn("[aio:air] undecodable frame — dropped");
    return;
  }
  if (handleControlFrame(f, _bootId, _protoMismatch)) return;
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
  const q = _queue.drain();
  _connectionDegraded = false;
  _offlineWarned = false;
  if (q.length === 0) return;
  console.warn(
    `[aio:air] ${q.length} queued action(s) discarded — ${why}. They were ` +
      `never sent; their callers reject.`,
  );
  for (const a of q) {
    if (a.cid) _rejectAck(a.cid, new Error(`action was never sent — ${why}`));
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
  const mine = _queue.drainEntries();
  const core = _coreTakeOfflineQueue();
  _connectionDegraded = false;
  _offlineWarned = false;
  if (core.length === 0) return mine;
  if (mine.length === 0) return core;
  return [...mine, ...core].sort((a, b) => a.seq - b.seq);
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
function _flushPending(pending: QueuedEntry[], send: (d: string) => void) {
  for (let i = 0; i < pending.length; i++) {
    const a = pending[i]!.action;
    try {
      send(enc("action", a));
    } catch (err) {
      const rest = pending.slice(i);
      for (const e of rest) _queue.push(e.action, e.seq);
      _updateDegraded();
      console.warn(
        `[aio:air] offline flush stopped after ${i} action(s) — the transport ` +
          `refused the write (${
            err instanceof Error ? err.message : String(err)
          }). The remaining ${rest.length} action(s) are back in the queue, in ` +
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
    // The frame is out now — this is when a queued call's ack clock starts.
    if (a.cid) _armAckTimer(a.cid);
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
  setTimeout(() => _connect(), delay);
}

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
    _flushPending(pending, (d) => _ipc!.send(d));
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
    // Before _coreSetTransport — installing it flushes the core's queue.
    const pending = _takePending();
    _coreSetTransport({ send: (d) => ws.send(d), close: () => ws.close() });
    _coreSetConnected(true);
    _syncOnline?.(true);
    // Announce our wire-protocol version before anything else — without this
    // hello the server's version gate never applies to AIR clients.
    ws.send(enc("proto", protoHello(stampedVersion())));
    const ua = typeof navigator !== "undefined" &&
      /electron/i.test(navigator.userAgent);
    ws.send(enc("type", { kind: ua ? "electron" : "browser" }));
    if (_wasConnected) _status("Connected", "#2a2", 2000);
    _wasConnected = true;
    _coreResendSubs();
    _flushPending(pending, (d) => ws.send(d));
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
  ws.onclose = () => {
    _ws = null;
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
  const json = enc("action", tagged);
  const cid = (tagged as { cid?: string }).cid;
  if (_ws && _ws.readyState === WebSocket.OPEN) {
    try {
      _ws.send(json);
      if (cid) _armAckTimer(cid);
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

function _tryConnect() {
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
});

// Arms ack clocks itself: on write in `_send`, and on flush for queued actions.
(_send as unknown as Record<symbol, boolean>)[ARMS_ACK_TIMER] = true;
_setClientSend(_send);
installConsoleIntercept(_sendRaw);
