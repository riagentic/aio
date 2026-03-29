// UDS (Unix Domain Socket) transport — NDJSON listener for Electron IPC bridge (AIO-52 Phase 3)
// Extracted from aio.ts. Same protocol as WS (state JSON, __reload, __css, __tt:, __boot:).

import { _computeDelta, _filterByPaths, flattenKeys } from "./server.ts";
import { diagEmit } from "./diagnostic-bus.ts";

export type UDSClient = {
  conn: Deno.Conn;
  index: number;
  id: string;
  subscriptions: Set<string> | null;
  lastState: unknown;
  lastKeyJsons: Record<string, string>;
  broadcastCount: number;
};

export type UDSHandle = {
  broadcast: (msg: string) => void;
  broadcastState: (force?: boolean) => void;
  shutdown: () => void;
  socketPath: string;
  clients: () => UDSClient[];
  requestClientState: (index: number, msg?: string) => Promise<unknown>;
};

export function createUDSListener(
  socketPath: string,
  getUIState: () => unknown,
  onAction: (action: { type: string; payload?: unknown }) => void,
  debug: (msg: string) => void,
  clientCounter?: { value: number },
  fullStateThreshold = 0.5,
): UDSHandle {
  try {
    Deno.removeSync(socketPath);
  } catch { /* doesn't exist */ }

  const listener = Deno.listen({ transport: "unix", path: socketPath });
  const connSet = new Set<Deno.Conn>();
  const clientMap = new Map<Deno.Conn, UDSClient>();
  const counter = clientCounter ?? { value: 0 };
  let closed = false;

  const pendingState = new Map<
    string,
    { resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }
  >();

  (async () => {
    for await (const conn of listener) {
      connSet.add(conn);
      const client: UDSClient = {
        conn,
        index: counter.value++,
        id: crypto.randomUUID(),
        subscriptions: null,
        lastState: null,
        lastKeyJsons: {},
        broadcastCount: 0,
      };
      clientMap.set(conn, client);
      debug(`uds: client connected #${client.index} (${connSet.size} total)`);

      const initial = JSON.stringify(getUIState()) + "\n";
      const writer = conn.writable.getWriter();
      writer.write(new TextEncoder().encode(initial)).catch((e: unknown) => {
        diagEmit({
          type: "transport-error",
          severity: "warning",
          source: "server",
          message: "UDS write failed — message not delivered to renderer",
          detail: { error: String(e) },
          hint:
            "Electron IPC pipe may be broken. Check if renderer process is running.",
        });
      });
      writer.releaseLock();

      _handleUDSConn(
        conn,
        connSet,
        clientMap,
        pendingState,
        onAction,
        debug,
        getUIState,
        sendTo,
      );
    }
  })().catch((e) => {
    if (!closed) debug(`uds: accept loop error — ${e}`);
  });

  function sendTo(conn: Deno.Conn, msg: string): void {
    try {
      const writer = conn.writable.getWriter();
      writer.write(new TextEncoder().encode(msg + "\n")).catch(() => {
        connSet.delete(conn);
        try {
          conn.close();
        } catch { /* already closed */ }
      });
      writer.releaseLock();
    } catch {
      connSet.delete(conn);
      try {
        conn.close();
      } catch { /* already closed */ }
    }
  }

  return {
    socketPath,
    broadcast: (msg: string) => {
      const data = new TextEncoder().encode(msg + "\n");
      for (const conn of connSet) {
        try {
          const writer = conn.writable.getWriter();
          writer.write(data).catch(() => {
            connSet.delete(conn);
            try {
              conn.close();
            } catch { /* already closed */ }
            debug("uds: broadcast write failed — conn closed");
          });
          writer.releaseLock();
        } catch {
          connSet.delete(conn);
          try {
            conn.close();
          } catch { /* already closed */ }
        }
      }
    },
    broadcastState: (force = false) => {
      for (const [conn, client] of clientMap) {
        if (force) {
          client.lastState = null;
          client.lastKeyJsons = {};
        }
        let uiState: unknown;
        try {
          uiState = getUIState();
          if (client.subscriptions) {
            uiState = _filterByPaths(uiState, client.subscriptions);
          }
        } catch (e) {
          debug(`uds: broadcastState getUIState error — ${e}`);
          continue;
        }
        if (uiState === client.lastState) continue;
        // AIO-33: periodic forced full-state resync every 100 broadcasts
        client.broadcastCount++;
        if (client.broadcastCount >= 100) {
          client.broadcastCount = 0;
          client.lastState = null;
          client.lastKeyJsons = {};
        }
        const delta = _computeDelta(
          uiState,
          client.lastState,
          client.lastKeyJsons,
          fullStateThreshold,
        );
        if (delta.kind === "skip") {
          client.lastState = uiState;
          client.lastKeyJsons = delta.newKeyJsons;
          continue;
        }
        if (client.subscriptions && delta.kind === "full") {
          sendTo(conn, '{"$f":1,' + delta.msg.slice(1));
        } else {
          sendTo(conn, delta.msg);
        }
        client.lastState = uiState;
        client.lastKeyJsons = delta.newKeyJsons;
      }
    },
    clients: () => [...clientMap.values()],
    requestClientState: (
      index: number,
      msg = "__getState",
    ): Promise<unknown> => {
      const client = [...clientMap.values()].find((c) => c.index === index);
      if (!client) {
        return Promise.resolve({ error: `client ${index} not connected` });
      }
      return new Promise<unknown>((resolve) => {
        const timer = setTimeout(() => {
          pendingState.delete(client.id);
          resolve({ error: "client did not respond within 5s" });
        }, 5000);
        pendingState.set(client.id, { resolve, timer });
        sendTo(client.conn, msg);
      });
    },
    shutdown: () => {
      closed = true;
      listener.close();
      for (const conn of connSet) {
        try {
          conn.close();
        } catch { /* already closed */ }
      }
      for (const entry of pendingState.values()) clearTimeout(entry.timer);
      pendingState.clear();
      connSet.clear();
      clientMap.clear();
      try {
        Deno.removeSync(socketPath);
      } catch { /* already removed */ }
    },
  };
}

function _handleUDSConn(
  conn: Deno.Conn,
  connections: Set<Deno.Conn>,
  clientMap: Map<Deno.Conn, UDSClient>,
  pendingState: Map<
    string,
    { resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }
  >,
  onAction: (action: { type: string; payload?: unknown }) => void,
  debug: (msg: string) => void,
  getUIState: () => unknown,
  sendTo: (conn: Deno.Conn, msg: string) => void,
): void {
  const decoder = new TextDecoder();
  let buf = "";
  (async () => {
    const reader = conn.readable.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop()!;
        for (const line of lines) {
          if (!line) continue;
          if (line === "__ping") continue;
          if (line.startsWith("__clientState:")) {
            const client = clientMap.get(conn);
            if (client) {
              const pending = pendingState.get(client.id);
              if (pending) {
                pendingState.delete(client.id);
                clearTimeout(pending.timer);
                try {
                  pending.resolve(JSON.parse(line.slice(14)));
                } catch {
                  pending.resolve(null);
                }
              }
            }
            continue;
          }
          if (line.startsWith("__subs:")) {
            const client = clientMap.get(conn);
            if (!client) continue;
            try {
              const paths = JSON.parse(line.slice(7));
              if (Array.isArray(paths)) {
                if (paths.includes("*")) {
                  client.subscriptions = null;
                } else {
                  client.subscriptions = new Set(
                    paths.filter((p: unknown) => typeof p === "string"),
                  );
                }
                client.lastState = null;
                client.lastKeyJsons = {};
                try {
                  let uiState: unknown = getUIState();
                  if (client.subscriptions) {
                    uiState = _filterByPaths(uiState, client.subscriptions);
                  }
                  const toSend = client.subscriptions && uiState &&
                      typeof uiState === "object" && !Array.isArray(uiState)
                    ? { $f: 1, ...(uiState as Record<string, unknown>) }
                    : uiState;
                  sendTo(conn, JSON.stringify(toSend));
                  client.lastState = uiState;
                  if (
                    uiState && typeof uiState === "object" &&
                    !Array.isArray(uiState)
                  ) {
                    const flat = flattenKeys(
                      uiState as Record<string, unknown>,
                    );
                    for (const k of Object.keys(flat)) {
                      client.lastKeyJsons[k] = JSON.stringify(flat[k]);
                    }
                  }
                } catch (err) {
                  debug(`uds: filtered state send error — ${err}`);
                }
              }
            } catch {
              debug("uds: bad __subs message");
            }
            continue;
          }
          try {
            const action = JSON.parse(line);
            if (action && typeof action.type === "string") onAction(action);
          } catch {
            debug("uds: malformed message");
          }
        }
      }
    } catch { /* connection closed */ }
    connections.delete(conn);
    clientMap.delete(conn);
    try {
      conn.close();
    } catch { /* already closed */ }
    debug(`uds: client disconnected (${connections.size} total)`);
  })();
}
