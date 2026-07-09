// CLI client — state client for Deno (terminal-side equivalent of browser.ts)
// Connects to an aio server via WebSocket or UDS, receives state updates, sends actions.
// Same delta protocol as browser.ts but no DOM, no React — pure Deno runtime.

import { applyPatches, enablePatches, type Patch } from "immer";
import {
  negotiateProtocol,
  parseProtoHello,
  PROTOCOL_MISMATCH_CLOSE_CODE,
  protoHello,
} from "../protocol/protocol-version.ts";

enablePatches();

const WS_MAX_QUEUE = 100;

/** Apply one server message (full state, Immer `$patches`, or legacy `$p`/`$d`
 *  delta) to the current state. Returns the new state. On a patch that fails
 *  to apply (desync), returns the prior state unchanged and calls `onResync`
 *  so the caller can ask the server for a fresh snapshot. Shared by the WS
 *  and UDS client paths so both transports apply deltas identically. */
function applyServerMessage<S>(
  prev: S | null,
  data: Record<string, unknown>,
  onResync?: () => void,
): S | null {
  // Immer patches — new format from server
  if (data.$patches && Array.isArray(data.$patches)) {
    if (prev != null) {
      try {
        return applyPatches(
          prev as unknown as Record<string, unknown>,
          data.$patches as Patch[],
        ) as unknown as S;
      } catch {
        // desync — ask the server for a full snapshot
        onResync?.();
      }
    }
    return prev;
  }
  // Legacy delta patch
  if (data.$p && typeof data.$p === "object") {
    const p = data.$p as Record<string, unknown>;
    const next: Record<string, unknown> =
      prev != null && typeof prev === "object"
        ? { ...(prev as Record<string, unknown>), ...p }
        : { ...p };
    if (Array.isArray(data.$d)) {
      for (const k of data.$d) {
        if (
          typeof k === "string" && k !== "__proto__" &&
          k !== "constructor" && k !== "prototype"
        ) {
          delete next[k];
        }
      }
    }
    return next as S;
  }
  // Full state
  return data as S;
}

/** Reactive WS client handle — subscribe to state, send actions, close when done */
export type CliApp<S> = {
  /** Current state (null until first message from server) */
  readonly state: S | null;
  /** Send an action to the server */
  send(action: { type: string; payload?: unknown }): void;
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
      socket.send("__proto:" + JSON.stringify(protoHello()));
      // Drain queued actions
      const q = [...queue];
      queue.length = 0;
      for (const a of q) socket.send(JSON.stringify(a));
    };

    socket.onmessage = (e: MessageEvent) => {
      const raw = e.data;
      if (typeof raw !== "string") return;

      // Skip browser-only signals
      if (raw === "__reload" || raw === "__css") return;
      if (raw.startsWith("__tt:") || raw.startsWith("__boot:")) return;

      // A3: wire-protocol version handshake — terminal on mismatch.
      if (raw.startsWith("__proto:")) {
        const theirs = parseProtoHello(raw.slice(8));
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
      if (raw.startsWith("__proto-err:")) {
        console.error(
          `[aio:cli] server rejected protocol version: ${raw.slice(12)}`,
        );
        closed = true;
        return;
      }

      try {
        const data = JSON.parse(raw);
        if (data === null || typeof data !== "object") return;
        state = applyServerMessage(state, data, () => {
          // desync — request full state from server
          if (socket.readyState === WebSocket.OPEN) socket.send("__resync");
        }) as S;
        // Resolve ready on first state
        if (state != null && _readyResolve) {
          _readyResolve(state);
          _readyResolve = null;
        }
        if (state != null) { for (const fn of listeners) fn(state); }
      } catch { /* bad JSON — skip */ }
    };

    socket.onerror = () => {};

    socket.onclose = (ev) => {
      ws = null;
      if (closed) return;
      if (!wasConnected && retry === 2) {
        console.error(
          `[aio:cli] cannot reach ${wsUrl}${
            ev.code === 1008 ? ` (${ev.reason || "unauthorized"})` : ""
          } — check the server is running and the URL/token match its share link (still retrying)`,
        );
      }
      // Exponential backoff: 1s → 2s → 4s → 8s max, ±20% jitter
      const base = Math.min(1000 * Math.pow(2, retry), 8000);
      retry++;
      reconnectTimer = setTimeout(connect, base * (0.8 + Math.random() * 0.4));
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
        ws.send(JSON.stringify(action));
      } else if (!wasConnected && queue.length < WS_MAX_QUEUE) {
        queue.push(action);
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
    },
  };
}

/** Connect to an aio server via Unix Domain Socket — same API as connectCli but over UDS/NDJSON.
 *  Uses Deno.connect({ transport: 'unix' }) — no TCP port needed. */
export function connectCliUDS<S>(socketPath: string): CliApp<S> {
  let state: S | null = null;
  let conn: Deno.Conn | null = null;
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  let closed = false;
  let retry = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  const queue: Array<{ type: string; payload?: unknown }> = [];
  const listeners = new Set<(state: S) => void>();
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
          encoder.encode("__proto:" + JSON.stringify(protoHello()) + "\n"),
        ).catch(() => {});

        // Drain queued actions
        const q = [...queue];
        queue.length = 0;
        for (const a of q) {
          writer!.write(encoder.encode(JSON.stringify(a) + "\n")).catch(
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
                // Skip browser-only signals
                if (line === "__reload" || line === "__css") continue;
                if (line.startsWith("__tt:") || line.startsWith("__boot:")) {
                  continue;
                }
                // A3: wire-protocol version handshake — terminal on mismatch.
                if (line.startsWith("__proto:")) {
                  const theirs = parseProtoHello(line.slice(8));
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
                if (line.startsWith("__proto-err:")) {
                  console.error(
                    `[aio:cli] server rejected protocol version: ${
                      line.slice(12)
                    }`,
                  );
                  closed = true;
                  continue;
                }
                try {
                  const data = JSON.parse(line);
                  if (data === null || typeof data !== "object") continue;
                  state = applyServerMessage(state, data) as S;
                  if (state != null && _readyResolve) {
                    _readyResolve(state);
                    _readyResolve = null;
                  }
                  if (state != null) { for (const fn of listeners) fn(state); }
                } catch { /* bad JSON */ }
              }
            }
          } catch { /* connection closed */ }
          conn = null;
          writer = null;
          if (!closed) {
            const base = Math.min(1000 * Math.pow(2, retry), 8000);
            retry++;
            reconnectTimer = setTimeout(
              connect,
              base * (0.8 + Math.random() * 0.4),
            );
          }
        })();
      })
      .catch(() => {
        if (!closed) {
          const base = Math.min(1000 * Math.pow(2, retry), 8000);
          retry++;
          reconnectTimer = setTimeout(
            connect,
            base * (0.8 + Math.random() * 0.4),
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
        writer.write(encoder.encode(JSON.stringify(action) + "\n")).catch(
          () => {},
        );
      } else if (queue.length < WS_MAX_QUEUE) {
        queue.push(action);
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
    },
  };
}
