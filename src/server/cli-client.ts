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
  opts?: { token?: string },
): CliApp<S> {
  let state: S | null = null;
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let wasConnected = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  const queue: Array<{ type: string; payload?: unknown }> = [];
  const listeners = new Set<(state: S) => void>();
  const _pending = new Map<string, () => void>();

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
      socket.send(enc("proto", protoHello()));
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
        case "ack": {
          const { cid } = (frame.d ?? {}) as AckPayload;
          if (typeof cid === "string") {
            _pending.get(cid)?.();
            _pending.delete(cid);
          }
          return;
        }
        // A3: wire-protocol version handshake — terminal on mismatch.
        case "proto": {
          const theirs = parseProtoHello(frame.d);
          if (!theirs) return;
          const result = negotiateProtocol(protoHello(), theirs);
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
      // A dropped connection can never ack — resolve outstanding bound-method
      // calls so they don't hang (delivery is at-most-once; the app's next
      // state broadcast is the truth).
      if (_pending.size > 0) {
        console.warn(
          `[aio:cli] connection lost with ${_pending.size} unacked action(s) — resolving; verify via state`,
        );
        for (const resolve of _pending.values()) resolve();
        _pending.clear();
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

    send(action: { type: string; payload?: unknown }): void {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(enc("action", action));
      } else if (!wasConnected && queue.length < WS_MAX_QUEUE) {
        queue.push(action);
      }
    },

    bind(...cells: import("../state/cell-types.ts").CellDef[]): void {
      for (const f of cells) {
        bindCell(
          f,
          (action) => {
            const cid = crypto.randomUUID();
            const ackd = new Promise<void>((resolve) => {
              _pending.set(cid, resolve);
            });
            this.send(
              { ...action, cid } as { type: string; payload?: unknown },
            );
            // Not connected → the send was queued or dropped and no ack can
            // arrive; resolve now instead of hanging (at-most-once delivery).
            if (!this.connected) {
              _pending.delete(cid);
              return Promise.resolve();
            }
            return ackd;
          },
          () => (state ?? {}) as Record<string, unknown>,
        );
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
      // resolve outstanding method acks — bound calls must not hang forever
      for (const resolve of _pending.values()) resolve();
      _pending.clear();
    },
  };
}

/** Connect to an aio server via Unix Domain Socket — same API as connectCli but over UDS/NDJSON.
 *  Uses Deno.connect({ transport: 'unix' }) — no TCP port needed. */
export function connectCliUDS<S>(socketPath: string): CliApp<S> {
  const _udsPending = new Map<string, () => void>();
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
          encoder.encode(enc("proto", protoHello()) + "\n"),
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
                    const { cid } = (frame.d ?? {}) as AckPayload;
                    if (typeof cid === "string") {
                      _udsPending.get(cid)?.();
                      _udsPending.delete(cid);
                    }
                    continue;
                  }
                  // A3: version handshake — terminal on mismatch.
                  case "proto": {
                    const theirs = parseProtoHello(frame.d);
                    if (!theirs) continue;
                    const result = negotiateProtocol(protoHello(), theirs);
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
          if (_udsPending.size > 0) {
            console.warn(
              `[aio:cli] UDS connection lost with ${_udsPending.size} unacked action(s) — resolving; verify via state`,
            );
            for (const resolve of _udsPending.values()) resolve();
            _udsPending.clear();
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

    bind(...cells: import("../state/cell-types.ts").CellDef[]): void {
      for (const f of cells) {
        bindCell(
          f,
          (action) => {
            const cid = crypto.randomUUID();
            const ackd = new Promise<void>((resolve) => {
              _udsPending.set(cid, resolve);
            });
            this.send(
              { ...action, cid } as { type: string; payload?: unknown },
            );
            if (!this.connected) {
              _udsPending.delete(cid);
              return Promise.resolve();
            }
            return ackd;
          },
          () => (state ?? {}) as Record<string, unknown>,
        );
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
      for (const resolve of _udsPending.values()) resolve();
      _udsPending.clear();
    },
  };
}
