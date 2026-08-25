// CLI client — state client for Deno (terminal-side equivalent of browser.ts)
// Connects to an aio server via WebSocket or UDS, receives state updates, sends actions.
// Same delta protocol as browser.ts but no DOM, no React — pure Deno runtime.

import { applyPatches, enablePatches, type Patch } from "immer";
import { connectLocal, type LocalConn } from "./local-listen.ts";
import { backoffDelay } from "../protocol/transport-shared.ts";
import {
  type AckPayload,
  dec,
  enc,
  type Frame,
  v1PeerReason,
} from "../protocol/envelope.ts";
import { bindCell } from "../state/cell-catalog.ts";
import { _releaseCellBindings } from "../state/cell-reactive.ts";
import type { CellDef, Msg } from "../state/cell-types.ts";
import {
  ackMethodKey,
  createAckRegistry,
  SETTLES_CALLS,
} from "../protocol/ack-registry.ts";
import { ACK_TIMEOUT_MS } from "../protocol/protocol-types.ts";
import { VERSION } from "./aio-cli.ts";
import {
  negotiateProtocol,
  parseProtoHello,
  PROTOCOL_MISMATCH_CLOSE_CODE,
  protoHello,
} from "../protocol/protocol-version.ts";

import { log } from "../diagnostics/logger-api.ts";

enablePatches();

const WS_MAX_QUEUE = 100;

/** Apply one decoded state frame ("state" snapshot or "patches" delta) to
 *  the current state. Returns the new state. On a patch that fails to apply
 *  (desync), returns the prior state unchanged and calls `onResync` so the
 *  caller can ask the server for a fresh snapshot. Shared by the WS and UDS
 *  client paths so both transports apply deltas identically. */
function applyServerFrame<S>(
  prev: S | null,
  frame: Frame,
  onResync?: () => void,
): S | null {
  if (frame.t === "patches") {
    if (prev != null && Array.isArray(frame.d)) {
      try {
        return applyPatches(
          prev as unknown as Record<string, unknown>,
          frame.d as Patch[],
        ) as unknown as S;
      } catch {
        // desync — ask the server for a full snapshot
        onResync?.();
      }
    }
    return prev;
  }
  // Full state
  return frame.d as S;
}

/** Reactive WS client handle — subscribe to state, send actions, close when done */
export type CliApp<S> = {
  /** Current state (null until first message from server) */
  readonly state: S | null;
  /** Send an action to the server */
  send(action: { type: string; payload?: unknown }): void;
  /** Bind cell definitions to this connection — after `cli.bind(counter)`,
   *  `await counter.increment(1)` dispatches over the socket (resolves on
   *  the server ack) and `counter.count` reads the latest server state. No
   *  raw `{ type, payload }` wire actions needed. */
  bind(...cells: import("../state/cell-types.ts").CellDef[]): void;
  /** Subscribe to state changes — returns unsubscribe function. Fires immediately if state exists. */
  subscribe(fn: (state: S) => void): () => void;
  /** Close the connection (no reconnect) */
  close(): void;
  /** Whether WS is currently open */
  readonly connected: boolean;
  /** Resolves when first state is received */
  readonly ready: Promise<S>;
};

/** Connect to an aio server. URL can be http:// or ws:// — protocol is auto-detected. */
/** Wire the first-connect deadline onto a `ready` promise.
 *
 *  Shared by both transports so "can I detect a connection that never
 *  happened" does not depend on which one an app picked. Returns the settle
 *  function each client calls on its first state frame — settling clears the
 *  deadline, so a slow-but-successful connect never rejects afterwards. */
function _readyDeadline<S>(
  what: string,
  ms: number | undefined,
  resolve: (s: S) => void,
  reject: (e: Error) => void,
): (s: S) => void {
  let done = false;
  let timer: number | undefined;
  if (ms && ms > 0) {
    timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(
        new Error(
          `[aio:cli] no connection to ${what} after ${ms}ms — the address, ` +
            `the token or the certificate is wrong (a reachable server sends ` +
            `state immediately). Reconnection continues in the background; ` +
            `call close() to stop it.`,
        ),
      );
    }, ms) as unknown as number;
    // Never hold a process open just to report a failure.
    try {
      Deno.unrefTimer(timer);
    } catch { /* not Deno (browser bundle) — nothing to unref */ }
  }
  return (s: S) => {
    if (done) return;
    done = true;
    if (timer !== undefined) clearTimeout(timer);
    resolve(s);
  };
}

/** Connect a CLI process to a running aio app as a real client: live state,
 *  method calls, and reconnect with the offline queue — the terminal twin of a
 *  browser client. */
export function connectCli<S>(
  url: string,
  opts?: {
    /** Auth token — a string, or a FUNCTION resolved before every (re)connect.
     *  Pass a function when tokens expire (a 5-minute signed assertion): a
     *  static string 401s forever on the first silent reconnect past its
     *  window, which no retry can fix (a field report hand-rolled a refresh
     *  loop for exactly this). A rejected token() follows the normal
     *  reconnect backoff. */
    token?: string | (() => string | Promise<string>);
    /** Ceiling for one bound-cell call, ms (0 = wait indefinitely). Defaults
     *  to the shared `ACK_TIMEOUT_MS`. A CLI client has no page shell, so the
     *  server's per-method budgets cannot be bridged to it — an app whose
     *  methods legitimately run for minutes raises this. */
    ackTimeoutMs?: number;
    /** Reject `ready` if the FIRST connection has not succeeded within this
     *  many ms. Off by default: a client that HAS connected should out-wait a
     *  flaky network, and that is the common case.
     *
     *  The first attempt is a different question. A wrong URL, a wrong token
     *  and an untrusted certificate never become right by retrying, and with
     *  `ready` unsettled a caller cannot tell them from a slow server — the
     *  console said "still retrying" while `await app.ready` simply never
     *  returned, which reads as a hang. Set this wherever a failure has to be
     *  REPORTABLE rather than waited on: a script, a test, a service-to-service
     *  link. Reconnection continues regardless; this is about the caller
     *  getting an answer, not about giving up. */
    readyTimeoutMs?: number;
  },
): CliApp<S> {
  let state: S | null = null;
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let wasConnected = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  const queue: Array<{ type: string; payload?: unknown }> = [];
  const listeners = new Set<(state: S) => void>();
  // One registry PER CONNECTION (not the browser's module-level singleton):
  // `connectCli` can be called more than once in a process, and one client's
  // disconnect must never settle another's pending calls (D2).
  const _pending = createAckRegistry(
    () => opts?.ackTimeoutMs ?? ACK_TIMEOUT_MS,
    (m) => log.warn(m),
  );
  // Cells bound through THIS client — released on close() so the same defs can
  // be bound again by a later client (a cell def binds to exactly ONE
  // dispatcher, and until now there was no way to give it back).
  const _bound: import("../state/cell-types.ts").CellDef[] = [];

  /** Write an action, or queue it while the socket is down.
   *
   *  Returns which happened, because the caller must be able to tell a real
   *  send from a silent drop: this used to `return` without sending OR queuing
   *  once the client had connected at least once, so an action issued during a
   *  reconnect vanished with no error anywhere — a quiet write loss in exactly
   *  the window a reconnecting client spends most of its time in. */
  function _trySend(
    action: { type: string; payload?: unknown },
  ): { written: boolean; queued: boolean } {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(enc("action", action));
      return { written: true, queued: false };
    }
    if (queue.length < WS_MAX_QUEUE) {
      queue.push(action);
      _noteQueued();
      return { written: false, queued: true };
    }
    log.warn(
      "cli",
      `offline queue full (${WS_MAX_QUEUE}) — action "${action.type}" was NOT sent`,
    );
    return { written: false, queued: false };
  }

  /** Say — once per offline period — that actions are being held rather than
   *  sent. A queued call's promise stays PENDING until its frame is written
   *  (it has not failed; it has not happened), so the one thing that must
   *  never happen is for that wait to be unexplained. */
  let _queueNoted = false;
  function _noteQueued(): void {
    if (_queueNoted) return;
    _queueNoted = true;
    log.warn(
      "cli",
      `offline — actions are queued in memory (max ${WS_MAX_QUEUE}) ` +
        `and sent on reconnect; awaited calls stay pending until then, and ` +
        `close() rejects whatever is still queued`,
    );
  }

  let _readyResolve: ((s: S) => void) | null = null;
  const ready = new Promise<S>((r, j) => {
    _readyResolve = _readyDeadline<S>(url, opts?.readyTimeoutMs, r, j);
  });
  // An unhandled rejection is not the point of the deadline — a caller that
  // never awaits `ready` (the normal UI case) must not crash the process.
  ready.catch(() => {});

  let connecting = false;
  function connect(): void {
    if (ws || closed || connecting) return;
    const t = opts?.token;
    if (typeof t !== "function") return _openSocket(t);
    // A function token is resolved fresh before EVERY (re)connect — this is
    // the whole point (an expiring assertion must not be frozen at connect
    // #1). A rejection is a failed attempt, not a dead client: same backoff.
    connecting = true;
    Promise.resolve().then(t).then(
      (tok) => {
        connecting = false;
        if (ws || closed) return;
        _openSocket(tok);
      },
      (e) => {
        connecting = false;
        if (closed) return;
        log.error("cli", `token() failed: ${e} — retrying`);
        reconnectTimer = setTimeout(connect, backoffDelay(retry));
        retry++;
      },
    );
  }

  function _openSocket(explicitToken: string | undefined): void {
    const parsed = new URL(url);
    // wss:/https: stay secure — a TLS server never answers plain ws:
    const proto = parsed.protocol === "https:" || parsed.protocol === "wss:"
      ? "wss:"
      : "ws:";
    // token: explicit option wins, else the ?token= from the share-link URL
    const token = explicitToken ?? parsed.searchParams.get("token") ??
      undefined;
    const wsUrl = `${proto}//${parsed.host}/ws${
      token ? `?token=${token}` : ""
    }`;

    const socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      retry = 0;
      wasConnected = true;
      // A3: announce our wire-protocol version before anything else.
      socket.send(enc("proto", protoHello(VERSION)));
      // Drain queued actions. Each frame's ack clock starts HERE, when it is
      // actually written — not at dispatch time, or an action queued for
      // longer than the ceiling times out while still sitting in the queue and
      // is then delivered anyway.
      const q = [...queue];
      queue.length = 0;
      _queueNoted = false;
      for (const a of q) {
        socket.send(enc("action", a));
        const cid = (a as { cid?: string }).cid;
        if (cid) _pending.armTimer(cid);
      }
    };

    socket.onmessage = (e: MessageEvent) => {
      const raw = e.data;
      if (typeof raw !== "string") return;

      const frame = dec(raw);
      if (!frame) {
        // The one v1 shim: a v1 server's hello/refusal is still readable.
        const v1 = v1PeerReason(raw);
        if (v1) {
          log.error("cli", `protocol version mismatch: ${v1}`);
          closed = true;
          socket.close(PROTOCOL_MISMATCH_CLOSE_CODE, "protocol mismatch");
        }
        return;
      }
      switch (frame.t) {
        // Browser-only signals — irrelevant in a terminal.
        case "reload":
        case "css":
        case "boot":
        case "tt-state":
        case "diag":
          return;
        // Per-action acks for bound-cell method calls.
        //
        // The ack carries `ok`, the method's return `value`, and on refusal
        // the server's `error` — this used to read ONLY `cid` and resolve, so
        // a method that threw resolved exactly like one that succeeded and
        // every return value was dropped. An app could not tell "done" from
        // "refused" (a field report built a whole parallel error channel —
        // ~150 lines — because a promise could not reject). The browser
        // clients have always branched on `ok`; this is that same contract.
        case "ack": {
          const { cid, ok, value, error } = (frame.d ?? {}) as AckPayload;
          if (typeof cid !== "string") return;
          if (ok === false) {
            _pending.reject(
              cid,
              new Error(error ?? "the server refused the action"),
            );
          } else {
            _pending.resolve(cid, value);
          }
          return;
        }
        // A3: wire-protocol version handshake — terminal on mismatch.
        case "proto": {
          const theirs = parseProtoHello(frame.d);
          if (!theirs) return;
          const result = negotiateProtocol(protoHello(VERSION), theirs);
          if (!result.ok) {
            log.error("cli", `protocol version mismatch: ${result.reason}`);
            closed = true; // stop the reconnect loop — retrying can't fix it
            socket.close(PROTOCOL_MISMATCH_CLOSE_CODE, "protocol mismatch");
          }
          return;
        }
        case "proto-err":
          log.error(
            "cli",
            `server rejected protocol version: ${
              (frame.d as { reason?: string } | undefined)?.reason ?? "?"
            }`,
          );
          closed = true;
          return;
        case "state":
        case "patches": {
          state = applyServerFrame(state, frame, () => {
            // desync — request full state from server
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(enc("resync"));
            }
          }) as S;
          // Resolve ready on first state
          if (state != null && _readyResolve) {
            _readyResolve(state);
            _readyResolve = null;
          }
          if (state != null) { for (const fn of listeners) fn(state); }
          return;
        }
        default:
          return; // other diagnostics — irrelevant in a terminal
      }
    };

    socket.onerror = () => {};

    socket.onclose = (ev) => {
      // A dropped connection can never ack. These calls did NOT demonstrably
      // succeed, so they must not resolve: resolving them reported success for
      // work whose fate is unknown, and an app that awaited one carried on as
      // though its write had landed. Rejecting is the honest answer — the
      // error says what is and is not known, and `state` remains the truth.
      //
      // IN-FLIGHT ONLY. `queue` survives this close and is drained by the next
      // `onopen`, so rejecting a still-queued call — with a message that
      // promises "the action is not resent automatically" — was a guarantee
      // this very client then broke: the app retried as invited and the server
      // applied one user intent twice.
      const lost = _pending.rejectInFlight(
        new Error(
          "connection lost before the server confirmed this action — it may " +
            "or may not have been applied; re-check state before retrying " +
            "(the action is not resent automatically)",
        ),
      );
      if (lost > 0) {
        log.warn(
          "cli",
          `connection lost with ${lost} unacked action(s) — rejected; verify via state`,
        );
      }
      ws = null;
      if (closed) return;
      if (!wasConnected && retry === 2) {
        // A `wss://` dial that NEVER opened is, more often than not, the
        // self-signed cert an exposed aio server generates: Deno's WebSocket
        // has no API to pass a CA, so the connection dies before any protocol
        // frame and the generic "check the server is running" line sends
        // people to look at the wrong thing (R-7). DENO_CERT is read
        // at process start, so this can only be said, not fixed from here.
        const tlsHint = proto === "wss:"
          ? `\n  If the server uses aio's self-signed cert, this client cannot ` +
            `trust it after start: relaunch with DENO_CERT=<cert.pem> (get it ` +
            `with \`am profile --app=<appId>\`), or serve a real cert ` +
            `(tls: { cert, key }) / plain HTTP (tls: false) on the server.`
          : "";
        log.error(
          "cli",
          `cannot reach ${wsUrl}${
            ev.code === 1008 ? ` (${ev.reason || "unauthorized"})` : ""
          } — check the server is running and the URL/token match its share link (still retrying)${tlsHint}`,
        );
      }
      // Exponential backoff: 1s → 2s → 4s → 8s max, ±20% jitter (shared)
      reconnectTimer = setTimeout(connect, backoffDelay(retry));
      retry++;
    };

    ws = socket;
  }

  connect();

  return {
    get state() {
      return state;
    },
    get connected() {
      return ws?.readyState === WebSocket.OPEN;
    },
    ready,

    // Queue whenever the socket is down — NOT only before the first connect.
    // The old `!wasConnected` guard meant that once a client had connected,
    // an action sent during a reconnect was neither written nor queued and
    // vanished with no error: a silent write loss in the window a
    // reconnecting client spends most of its time in.
    send(action: { type: string; payload?: unknown }): void {
      _trySend(action);
    },

    bind(...cells: import("../state/cell-types.ts").CellDef[]): void {
      for (const f of cells) {
        // The dispatcher SETTLES the call itself: its promise is the real
        // outcome, carried back on the ack. Without this marker `bindCell`'s
        // async branch returns a LOCAL pending-call promise that nothing in
        // this process ever resolves, so every async bound method rejected at
        // the call ceiling — 30 seconds after the method had already
        // succeeded (see SETTLES_CALLS in protocol/ack-registry.ts).
        const dispatch = (action: Msg): Promise<unknown> => {
          const cid = crypto.randomUUID();
          // deferTimer: the clock belongs to the FRAME, not to the call. It
          // starts in `armTimer` below when the write happens (here, or at the
          // queue drain in `onopen`) — never while the action is still queued.
          const ackd = _pending.register(cid, {
            methodKey: ackMethodKey(action),
            deferTimer: true,
          });
          const sent = _trySend(
            { ...action, cid } as { type: string; payload?: unknown },
          );
          if (sent.written) _pending.armTimer(cid);
          // Queued while offline: the ack clock must not run against a call
          // that has not been written yet, and if we close still holding it,
          // close() rejects it rather than reporting a success that never
          // happened.
          if (!sent.queued && !sent.written) {
            _pending.reject(
              cid,
              new Error(
                "not connected and the offline queue is full — the action " +
                  "was NOT sent",
              ),
            );
          }
          return ackd;
        };
        (dispatch as unknown as Record<symbol, boolean>)[SETTLES_CALLS] = true;
        bindCell(
          f,
          dispatch,
          () => (state ?? {}) as Record<string, unknown>,
        );
        _bound.push(f);
      }
    },

    subscribe(fn: (state: S) => void): () => void {
      listeners.add(fn);
      if (state !== null) fn(state);
      return () => {
        listeners.delete(fn);
      };
    },

    close(): void {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      ws?.close();
      ws = null;
      listeners.clear();
      // close() DISCARDS the queue — nothing will ever drain it — so here the
      // queued calls really are dead and rejectAll (not rejectInFlight) is the
      // truthful settlement. Say how many frames went with it.
      if (queue.length > 0) {
        log.warn(
          "cli",
          `closed with ${queue.length} action(s) still queued — ` +
            `they were never sent; their callers reject`,
        );
        queue.length = 0;
      }
      // Outstanding calls REJECT, never resolve: closing does not make an
      // unconfirmed action succeed, and a bound call that quietly resolved on
      // close reported work the server may never have seen.
      _pending.rejectAll(
        new Error("client closed before the server confirmed this action"),
      );
      // Give the cell definitions back. A def binds to exactly ONE dispatcher
      // (D2), and without this a second `connectCli(...).bind(cell)` — after a
      // reconnect-by-hand, or in a test file that also runs the server —
      // threw "already bound" forever, with no way to undo it.
      if (_bound.length > 0) {
        _releaseCellBindings(_bound);
        _bound.length = 0;
      }
    },
  };
}

/** Connect to an aio server via Unix Domain Socket — same API as connectCli but over UDS/NDJSON.
 *  Uses Deno.connect({ transport: 'unix' }) — no TCP port needed. */
export function connectCliUDS<S>(
  socketPath: string,
  /** Same contract as `connectCli` — including `readyTimeoutMs`, which must
   *  exist on BOTH clients or the answer to "can I detect a dead connection"
   *  depends on which transport you happened to pick. */
  opts?: { ackTimeoutMs?: number; readyTimeoutMs?: number },
): CliApp<S> {
  // Same per-connection registry as the WS client — see connectCli.
  const _udsPending = createAckRegistry(
    () => opts?.ackTimeoutMs ?? ACK_TIMEOUT_MS,
    (m) => log.warn(m),
  );
  const _bound: CellDef[] = [];
  let state: S | null = null;
  let conn: LocalConn | null = null;
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  let closed = false;
  let retry = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  const queue: Array<{ type: string; payload?: unknown }> = [];
  const listeners = new Set<(state: S) => void>();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let _readyResolve: ((s: S) => void) | null = null;
  const ready = new Promise<S>((r, j) => {
    _readyResolve = _readyDeadline<S>(socketPath, opts?.readyTimeoutMs, r, j);
  });
  ready.catch(() => {}); // see connectCli — an unawaited ready must not crash

  let _udsQueueNoted = false;
  /** Write an action, or queue it while the socket is down — the ONE writer,
   *  and it reports which happened.
   *
   *  A closure, not a method on the returned object: `bind`'s dispatcher used
   *  to call `this.send(...)`, so `const { bind } = connectCliUDS(...)` made
   *  every bound method throw SYNCHRONOUSLY (uncatchable through the awaited
   *  promise) while its ack sat registered until `close()` turned it into an
   *  unhandled rejection that killed the process. `connectCli` has always used
   *  a closure; this is that same shape.
   *
   *  It also has to REPORT the over-cap discard: swallowing it left the caller
   *  to wait out the full ack ceiling and hear "the server never confirmed the
   *  call" about a frame this client threw away instantly and knowably. */
  function _udsTrySend(
    action: { type: string; payload?: unknown },
  ): { written: boolean; queued: boolean } {
    if (writer) {
      writer.write(encoder.encode(enc("action", action) + "\n")).catch(
        () => {},
      );
      return { written: true, queued: false };
    }
    if (queue.length < WS_MAX_QUEUE) {
      queue.push(action);
      if (!_udsQueueNoted) {
        _udsQueueNoted = true;
        log.warn(
          "cli",
          `UDS offline — actions are queued in memory (max ` +
            `${WS_MAX_QUEUE}) and sent on reconnect; awaited calls stay ` +
            `pending until then, and close() rejects whatever is still queued`,
        );
      }
      return { written: false, queued: true };
    }
    log.warn(
      "cli",
      `UDS offline queue full (${WS_MAX_QUEUE}) — action "${action.type}" was NOT sent`,
    );
    return { written: false, queued: false };
  }

  function connect(): void {
    if (conn || closed) return;
    connectLocal(socketPath)
      .then((c) => {
        conn = c;
        writer = c.writable.getWriter();
        retry = 0;

        // A3: announce our wire-protocol version before anything else.
        writer!.write(
          encoder.encode(enc("proto", protoHello(VERSION)) + "\n"),
        ).catch(() => {});

        // Drain queued actions. The ack clock starts HERE — at the write —
        // not at dispatch time (see connectCli's drain).
        const q = [...queue];
        queue.length = 0;
        _udsQueueNoted = false;
        for (const a of q) {
          writer!.write(encoder.encode(enc("action", a) + "\n")).catch(
            () => {},
          );
          const cid = (a as { cid?: string }).cid;
          if (cid) _udsPending.armTimer(cid);
        }

        // Read NDJSON
        let buf = "";
        const reader = c.readable.getReader();
        (async () => {
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              const lines = buf.split("\n");
              buf = lines.pop()!;
              for (const line of lines) {
                if (!line) continue;
                const frame = dec(line);
                if (!frame) {
                  // v1 shim: a v1 server's hello/refusal is still readable.
                  const v1 = v1PeerReason(line);
                  if (v1) {
                    log.error("cli", `protocol version mismatch: ${v1}`);
                    closed = true;
                    try {
                      c.close();
                    } catch { /* already closed */ }
                  }
                  continue;
                }
                switch (frame.t) {
                  // Per-action acks for bound-cell method calls
                  case "ack": {
                    // Branch on `ok` — parity with the WS client and the
                    // browser transports. Dropping it resolved a refused
                    // call exactly like a successful one.
                    const { cid, ok, value, error } = (frame.d ??
                      {}) as AckPayload;
                    if (typeof cid !== "string") continue;
                    if (ok === false) {
                      _udsPending.reject(
                        cid,
                        new Error(error ?? "the server refused the action"),
                      );
                    } else {
                      _udsPending.resolve(cid, value);
                    }
                    continue;
                  }
                  // A3: version handshake — terminal on mismatch.
                  case "proto": {
                    const theirs = parseProtoHello(frame.d);
                    if (!theirs) continue;
                    const result = negotiateProtocol(
                      protoHello(VERSION),
                      theirs,
                    );
                    if (!result.ok) {
                      log.error(
                        "cli",
                        `protocol version mismatch: ${result.reason}`,
                      );
                      closed = true; // stop the reconnect loop
                      try {
                        c.close();
                      } catch { /* already closed */ }
                    }
                    continue;
                  }
                  case "proto-err":
                    log.error(
                      "cli",
                      `server rejected protocol version: ${
                        (frame.d as { reason?: string } | undefined)?.reason ??
                          "?"
                      }`,
                    );
                    closed = true;
                    continue;
                  case "state":
                  case "patches": {
                    // onResync is NOT optional: without it a patch that fails
                    // to apply left this client frozen at its last good state
                    // — no error, no log, permanent divergence from a server
                    // that kept moving. The UDS server answers `resync` with a
                    // full snapshot exactly like the WS one.
                    state = applyServerFrame(state, frame, () => {
                      log.warn(
                        "cli",
                        "UDS patch did not apply (desync) — " +
                          "requesting a full snapshot",
                        { detail: String() },
                      );
                      writer?.write(encoder.encode(enc("resync") + "\n"))
                        .catch(() => {});
                    }) as S;
                    if (state != null && _readyResolve) {
                      _readyResolve(state);
                      _readyResolve = null;
                    }
                    if (state != null) {
                      for (const fn of listeners) fn(state);
                    }
                    continue;
                  }
                  default:
                    continue; // browser-only signals — irrelevant here
                }
              }
            }
          } catch { /* connection closed */ }
          // Dropped UDS connection can never ack — see the WS onclose note.
          {
            // Reject, never resolve — an unconfirmed action did not succeed
            // just because the socket died (see connectCli's onclose).
            // IN-FLIGHT ONLY: `queue` survives and is drained on reconnect.
            const lost = _udsPending.rejectInFlight(
              new Error(
                "connection lost before the server confirmed this action — " +
                  "it may or may not have been applied; re-check state " +
                  "before retrying (the action is not resent automatically)",
              ),
            );
            if (lost > 0) {
              log.warn(
                "cli",
                `UDS connection lost with ${lost} unacked action(s) — rejected; verify via state`,
              );
            }
          }
          conn = null;
          writer = null;
          if (!closed) {
            reconnectTimer = setTimeout(connect, backoffDelay(retry));
            retry++;
          }
        })();
      })
      .catch(() => {
        if (!closed) {
          reconnectTimer = setTimeout(
            connect,
            backoffDelay(retry++),
          );
        }
      });
  }

  connect();

  return {
    get state() {
      return state;
    },
    get connected() {
      return conn !== null;
    },
    ready,

    send(action: { type: string; payload?: unknown }): void {
      _udsTrySend(action);
    },

    bind(...cells: CellDef[]): void {
      for (const f of cells) {
        // Marked SETTLES_CALLS for the same reason as the WS client: the ack
        // is the call's real outcome, and without it every async bound method
        // waited on a local promise nobody would ever settle.
        const dispatch = (action: Msg): Promise<unknown> => {
          const cid = crypto.randomUUID();
          // deferTimer + arm-on-write: identical rule to connectCli — the
          // clock belongs to the frame, never to a queued action.
          const ackd = _udsPending.register(cid, {
            methodKey: ackMethodKey(action),
            deferTimer: true,
          });
          const sent = _udsTrySend(
            { ...action, cid } as { type: string; payload?: unknown },
          );
          if (sent.written) _udsPending.armTimer(cid);
          else if (!sent.queued) {
            _udsPending.reject(
              cid,
              new Error(
                "not connected and the offline queue is full — the action " +
                  "was NOT sent",
              ),
            );
          }
          return ackd;
        };
        (dispatch as unknown as Record<symbol, boolean>)[SETTLES_CALLS] = true;
        bindCell(f, dispatch, () => (state ?? {}) as Record<string, unknown>);
        _bound.push(f);
      }
    },

    subscribe(fn: (state: S) => void): () => void {
      listeners.add(fn);
      if (state !== null) fn(state);
      return () => {
        listeners.delete(fn);
      };
    },

    close(): void {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      try {
        conn?.close();
      } catch { /* already closed */ }
      conn = null;
      writer = null;
      listeners.clear();
      // close() discards the queue — those frames are dead, so rejectAll is
      // the truthful settlement here (see connectCli.close).
      if (queue.length > 0) {
        log.warn(
          "cli",
          `UDS closed with ${queue.length} action(s) still queued — ` +
            `they were never sent; their callers reject`,
        );
        queue.length = 0;
      }
      _udsPending.rejectAll(
        new Error("client closed before the server confirmed this action"),
      );
      if (_bound.length > 0) {
        _releaseCellBindings(_bound);
        _bound.length = 0;
      }
    },
  };
}
