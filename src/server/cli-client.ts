// CLI client — state client for Deno (terminal-side equivalent of browser.ts)
// Connects to an aio server via WebSocket or UDS, receives state updates, sends actions.
// Same delta protocol as browser.ts but no DOM, no React — pure Deno runtime.

import { applyPatches, enablePatches, type Patch } from "immer";
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
export function connectCli<S>(
  url: string,
  opts?: {
    token?: string;
    /** Ceiling for one bound-cell call, ms (0 = wait indefinitely). Defaults
     *  to the shared `ACK_TIMEOUT_MS`. A CLI client has no page shell, so the
     *  server's per-method budgets cannot be bridged to it — an app whose
     *  methods legitimately run for minutes raises this. */
    ackTimeoutMs?: number;
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
  const _pending = createAckRegistry(() =>
    opts?.ackTimeoutMs ?? ACK_TIMEOUT_MS
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
      return { written: false, queued: true };
    }
    console.warn(
      `[aio:cli] offline queue full (${WS_MAX_QUEUE}) — action "${action.type}" was NOT sent`,
    );
    return { written: false, queued: false };
  }

  let _readyResolve: ((s: S) => void) | null = null;
  const ready = new Promise<S>((r) => {
    _readyResolve = r;
  });

  function connect(): void {
    if (ws || closed) return;
    const parsed = new URL(url);
    // wss:/https: stay secure — a TLS server never answers plain ws:
    const proto = parsed.protocol === "https:" || parsed.protocol === "wss:"
      ? "wss:"
      : "ws:";
    // token: explicit option wins, else the ?token= from the share-link URL
    const token = opts?.token ?? parsed.searchParams.get("token") ?? undefined;
    const wsUrl = `${proto}//${parsed.host}/ws${
      token ? `?token=${token}` : ""
    }`;

    const socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      retry = 0;
      wasConnected = true;
      // A3: announce our wire-protocol version before anything else.
      socket.send(enc("proto", protoHello(VERSION)));
      // Drain queued actions
      const q = [...queue];
      queue.length = 0;
      for (const a of q) socket.send(enc("action", a));
    };

    socket.onmessage = (e: MessageEvent) => {
      const raw = e.data;
      if (typeof raw !== "string") return;

      const frame = dec(raw);
      if (!frame) {
        // The one v1 shim: a v1 server's hello/refusal is still readable.
        const v1 = v1PeerReason(raw);
        if (v1) {
          console.error(`[aio:cli] protocol version mismatch: ${v1}`);
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
            console.error(
              `[aio:cli] protocol version mismatch: ${result.reason}`,
            );
            closed = true; // stop the reconnect loop — retrying can't fix it
            socket.close(PROTOCOL_MISMATCH_CLOSE_CODE, "protocol mismatch");
          }
          return;
        }
        case "proto-err":
          console.error(
            `[aio:cli] server rejected protocol version: ${
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
      const lost = _pending.rejectAll(
        new Error(
          "connection lost before the server confirmed this action — it may " +
            "or may not have been applied; re-check state before retrying " +
            "(the action is not resent automatically)",
        ),
      );
      if (lost > 0) {
        console.warn(
          `[aio:cli] connection lost with ${lost} unacked action(s) — rejected; verify via state`,
        );
      }
      ws = null;
      if (closed) return;
      if (!wasConnected && retry === 2) {
        console.error(
          `[aio:cli] cannot reach ${wsUrl}${
            ev.code === 1008 ? ` (${ev.reason || "unauthorized"})` : ""
          } — check the server is running and the URL/token match its share link (still retrying)`,
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
          const ackd = _pending.register(cid, {
            methodKey: ackMethodKey(action),
          });
          const sent = _trySend(
            { ...action, cid } as { type: string; payload?: unknown },
          );
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
  opts?: { ackTimeoutMs?: number },
): CliApp<S> {
  // Same per-connection registry as the WS client — see connectCli.
  const _udsPending = createAckRegistry(() =>
    opts?.ackTimeoutMs ?? ACK_TIMEOUT_MS
  );
  const _bound: CellDef[] = [];
  let state: S | null = null;
  let conn: Deno.Conn | null = null;
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  let closed = false;
  let retry = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  const queue: Array<{ type: string; payload?: unknown }> = [];
  const listeners = new Set<(state: S) => void>();
  const _pending = new Map<string, () => void>();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let _readyResolve: ((s: S) => void) | null = null;
  const ready = new Promise<S>((r) => {
    _readyResolve = r;
  });

  function connect(): void {
    if (conn || closed) return;
    Deno.connect({ transport: "unix", path: socketPath })
      .then((c) => {
        conn = c;
        writer = c.writable.getWriter();
        retry = 0;

        // A3: announce our wire-protocol version before anything else.
        writer!.write(
          encoder.encode(enc("proto", protoHello(VERSION)) + "\n"),
        ).catch(() => {});

        // Drain queued actions
        const q = [...queue];
        queue.length = 0;
        for (const a of q) {
          writer!.write(encoder.encode(enc("action", a) + "\n")).catch(
            () => {},
          );
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
                    console.error(`[aio:cli] protocol version mismatch: ${v1}`);
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
                      console.error(
                        `[aio:cli] protocol version mismatch: ${result.reason}`,
                      );
                      closed = true; // stop the reconnect loop
                      try {
                        c.close();
                      } catch { /* already closed */ }
                    }
                    continue;
                  }
                  case "proto-err":
                    console.error(
                      `[aio:cli] server rejected protocol version: ${
                        (frame.d as { reason?: string } | undefined)?.reason ??
                          "?"
                      }`,
                    );
                    closed = true;
                    continue;
                  case "state":
                  case "patches": {
                    state = applyServerFrame(state, frame) as S;
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
            const lost = _udsPending.rejectAll(
              new Error(
                "connection lost before the server confirmed this action — " +
                  "it may or may not have been applied; re-check state " +
                  "before retrying (the action is not resent automatically)",
              ),
            );
            if (lost > 0) {
              console.warn(
                `[aio:cli] UDS connection lost with ${lost} unacked action(s) — rejected; verify via state`,
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
      if (writer) {
        writer.write(encoder.encode(enc("action", action) + "\n")).catch(
          () => {},
        );
      } else if (queue.length < WS_MAX_QUEUE) {
        queue.push(action);
      }
    },

    bind(...cells: CellDef[]): void {
      for (const f of cells) {
        // Marked SETTLES_CALLS for the same reason as the WS client: the ack
        // is the call's real outcome, and without it every async bound method
        // waited on a local promise nobody would ever settle.
        const dispatch = (action: Msg): Promise<unknown> => {
          const cid = crypto.randomUUID();
          const ackd = _udsPending.register(cid, {
            methodKey: ackMethodKey(action),
          });
          this.send({ ...action, cid } as { type: string; payload?: unknown });
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
