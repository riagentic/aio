// UDS (Unix Domain Socket) transport — NDJSON listener for Electron IPC bridge (AIO-52 Phase 3)
// Extracted from aio.ts. Same protocol as WS (state JSON, __reload, __css, __tt:, __boot:).

import { compactPatches } from "../state/patch-compact.ts";
import { writeClientLog } from "./client-log.ts";
import { log } from "../diagnostics/logger.ts";
import { _isFrameworkInternalActionType } from "./server-ws.ts";
import {
  negotiateProtocol,
  parseProtoHello,
  protoHello,
} from "../protocol/protocol-version.ts";

export type UDSClient = {
  conn: Deno.Conn;
  index: number;
  id: string;
  subscriptions: Set<string> | null;
  lastFullJson?: string;
};

type PatchEntry = { cell: string; ops: import("immer").Patch[] };

export type UDSHandle = {
  broadcast: (msg: string) => void;
  broadcastState: (forceOrPatches?: boolean | PatchEntry[]) => void;
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
  _fullStateThreshold = 0.5, // deprecated: kept for API compat, no longer used
  _cellPatchStrategies?: Map<string, "raw" | "skip" | "filter" | "full">, // unused — patches pre-filtered by aio.ts
  _cellFilterFields?: Map<
    string,
    { mode: "include" | "exclude"; fields: Set<string> }
  >, // unused — patches pre-filtered by aio.ts
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
      };
      clientMap.set(conn, client);
      debug(`uds: client connected #${client.index} (${connSet.size} total)`);

      // A3: version handshake — server speaks first, before any state.
      sendTo(conn, "__proto:" + JSON.stringify(protoHello()));
      // AIO-239: route initial write through sendTo() to use per-connection write queue
      const initial = JSON.stringify(getUIState());
      sendTo(conn, initial);

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
    if (!closed) log.error("uds", `accept loop error — ${e}`);
  });

  // AIO-216: per-connection write queue to prevent byte interleaving
  const _writeQueues = new WeakMap<Deno.Conn, Promise<void>>();

  function sendTo(conn: Deno.Conn, msg: string, onSent?: () => void): void {
    const encoded = new TextEncoder().encode(msg + "\n");
    const prev = _writeQueues.get(conn) ?? Promise.resolve();
    const next = prev.then(async () => {
      const writer = conn.writable.getWriter();
      try {
        await writer.write(encoded);
        onSent?.();
      } finally {
        writer.releaseLock();
      }
    }).catch(() => {
      _writeQueues.delete(conn);
      connSet.delete(conn);
      clientMap.delete(conn);
      try {
        conn.close();
      } catch { /* already closed */ }
    });
    _writeQueues.set(conn, next);
  }

  function _getFilteredFullJson(
    client: Pick<UDSClient, "subscriptions">,
  ): string | undefined {
    let uiState: unknown;
    try {
      uiState = getUIState();
      if (client.subscriptions) {
        const filtered: Record<string, unknown> = {};
        const src = uiState as Record<string, unknown>;
        for (const sub of client.subscriptions) {
          const feat = sub.includes(".") ? sub.slice(0, sub.indexOf(".")) : sub;
          if (feat in src && !(feat in filtered)) filtered[feat] = src[feat];
        }
        uiState = filtered;
      }
    } catch (e) {
      log.error("uds", `getUIState error — ${e}`);
      return undefined;
    }
    return JSON.stringify(uiState);
  }

  return {
    socketPath,
    // AIO-239: route broadcast through sendTo() to use per-connection write queue
    broadcast: (msg: string) => {
      for (const conn of connSet) sendTo(conn, msg);
    },
    broadcastState: (forceOrPatches?: boolean | PatchEntry[]) => {
      const force = forceOrPatches === true;
      // Patches are pre-filtered by aio.ts filterPatchesByStrategy — use directly
      const patches = Array.isArray(forceOrPatches)
        ? forceOrPatches
        : undefined;

      for (const [conn, client] of clientMap) {
        if (force) {
          client.lastFullJson = undefined;
        }

        // Patch-based path: filter patches by client subscriptions and send $patches
        if (patches && patches.length > 0 && !force) {
          const clientPatches = client.subscriptions
            ? patches.filter((p) => {
              for (const sub of client.subscriptions!) {
                if (
                  sub === p.cell || sub.startsWith(p.cell + ".")
                ) return true;
              }
              return false;
            })
            : patches;

          const allOps = compactPatches(
            clientPatches.flatMap((p) =>
              p.ops.map((op) => ({
                ...op,
                path: [p.cell, ...op.path],
              }))
            ),
          );

          if (allOps.length > 0) {
            const patchJson = JSON.stringify({ $patches: allOps });
            // Size guard: if patches exceed full state, send full state instead
            const fullJson = _getFilteredFullJson(client);
            if (fullJson && patchJson.length > fullJson.length) {
              debug(
                `uds: patch payload (${patchJson.length}B) > full state (${fullJson.length}B) — sending full state`,
              );
              if (fullJson !== client.lastFullJson) {
                const fj = fullJson;
                sendTo(conn, fullJson, () => {
                  client.lastFullJson = fj;
                });
              }
            } else {
              const fj = fullJson;
              sendTo(
                conn,
                patchJson,
                fj
                  ? () => {
                    client.lastFullJson = fj;
                  }
                  : undefined,
              );
            }
            continue;
          }
        }

        // Fallback: force-full, trailing flush, or no patches — send full state
        const json = _getFilteredFullJson(client);
        if (!json) continue;
        if (json === client.lastFullJson) continue; // no change
        const j = json;
        sendTo(conn, json, () => {
          client.lastFullJson = j;
        });
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
        // AIO-223: cleanup existing pending request before overwriting
        const existing = pendingState.get(client.id);
        if (existing) {
          clearTimeout(existing.timer);
          existing.resolve({ error: "superseded by new request" });
        }
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
  sendTo: (conn: Deno.Conn, msg: string, onSent?: () => void) => void,
): void {
  const decoder = new TextDecoder();
  const MAX_BUF = 10 * 1024 * 1024; // 10MB — prevent OOM from missing newlines
  let buf = "";
  (async () => {
    const reader = conn.readable.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (buf.length > MAX_BUF && !buf.includes("\n")) {
          log.error(
            "uds",
            `client buffer exceeded ${MAX_BUF}B without newline — closing`,
          );
          break;
        }
        const lines = buf.split("\n");
        buf = lines.pop()!;
        for (const line of lines) {
          if (!line) continue;
          if (line === "__ping") continue;

          // A3: wire-protocol version handshake
          if (line.startsWith("__proto:")) {
            const theirs = parseProtoHello(line.slice(8));
            if (!theirs) {
              debug("uds: malformed __proto hello — ignored");
              continue;
            }
            const result = negotiateProtocol(protoHello(), theirs);
            if (!result.ok) {
              log.error("uds", `protocol mismatch — ${result.reason}`);
              sendTo(conn, "__proto-err:" + result.reason);
              // Close after the error message flushes through the write queue.
              sendTo(conn, "", () => {
                try {
                  conn.close();
                } catch { /* already closed */ }
              });
            }
            continue;
          }

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
          // Client log forwarding
          if (line.startsWith("__log:")) {
            const client = clientMap.get(conn);
            if (client) {
              try {
                const entry = JSON.parse(line.slice(6));
                writeClientLog(client.index, entry);
              } catch { /* malformed — drop */ }
            }
            continue;
          }
          // Semantic UI-surface / trigger results — resolve pending. Gives the
          // unified facility (am surface/trigger, sharing testUI's impl) parity
          // over UDS/electron, matching the WS path. (The old snapshot/interact
          // results were removed with the selector/raw-DOM path.)
          {
            const uiPfx = line.startsWith("__ui:surface-result:")
              ? "__ui:surface-result:"
              : line.startsWith("__ui:trigger-result:")
              ? "__ui:trigger-result:"
              : null;
            if (uiPfx) {
              const client = clientMap.get(conn);
              if (client) {
                const pending = pendingState.get(client.id);
                if (pending) {
                  pendingState.delete(client.id);
                  clearTimeout(pending.timer);
                  try {
                    pending.resolve(JSON.parse(line.slice(uiPfx.length)));
                  } catch {
                    pending.resolve(null);
                  }
                }
              }
              continue;
            }
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
                try {
                  let uiState: unknown = getUIState();
                  if (client.subscriptions) {
                    const filtered: Record<string, unknown> = {};
                    const src = uiState as Record<string, unknown>;
                    for (const sub of client.subscriptions) {
                      const feat = sub.includes(".")
                        ? sub.slice(0, sub.indexOf("."))
                        : sub;
                      if (feat in src && !(feat in filtered)) {
                        filtered[feat] = src[feat];
                      }
                    }
                    uiState = filtered;
                  }
                  const msg = JSON.stringify(uiState);
                  sendTo(conn, msg, () => {
                    client.lastFullJson = msg;
                  });
                } catch (err) {
                  log.warn("uds", `filtered state send error — ${err}`);
                }
              }
            } catch {
              log.warn("uds", "bad __subs message");
            }
            continue;
          }
          // Resync request — client detected patch desync, send full state
          if (line === "__resync") {
            const client = clientMap.get(conn);
            if (client) {
              try {
                let uiState: unknown = getUIState();
                if (client.subscriptions) {
                  const filtered: Record<string, unknown> = {};
                  const src = uiState as Record<string, unknown>;
                  for (const sub of client.subscriptions) {
                    const feat = sub.includes(".")
                      ? sub.slice(0, sub.indexOf("."))
                      : sub;
                    if (feat in src && !(feat in filtered)) {
                      filtered[feat] = src[feat];
                    }
                  }
                  uiState = filtered;
                }
                const msg = JSON.stringify(uiState);
                sendTo(conn, msg, () => {
                  client.lastFullJson = msg;
                });
              } catch (err) {
                log.warn("uds", `resync send error — ${err}`);
              }
            }
            continue;
          }
          try {
            const action = JSON.parse(line);
            if (action && typeof action.type === "string") {
              // Block framework-internal action types from UDS sources —
              // parity with the WS server (server-ws.ts:621) and trojan
              // (server-trojan.ts:315). Internal actions (cell:__setX,
              // cell:__exec, cell:__flow, etc.) carry trusted payload shapes
              // (e.g. mutation lists) that bypass cell method bodies.
              // Accepting them from any UDS client is a remote-code-style
              // vector — see audit F-1 (prototype pollution via __setMethod).
              // UDS is typically local-only (Electron in-process), but this
              // closes the defense-in-depth invariant for any UDS-exposing
              // deployment (socket on a shared host, dev hot-reload).
              if (_isFrameworkInternalActionType(action.type)) {
                log.warn(
                  "uds",
                  `rejected framework-internal action type "${action.type}"`,
                );
                continue;
              }
              onAction(action);
              // AIO-402: per-action ack — parity with the WS server
              // (server-ws.ts). Settles the Promise returned by an awaited
              // method call; without it every `await cell.method()` over the
              // UDS+IPC transport (electron dev/prod) hangs until the 15s ack
              // timeout, so calculations, imports and progress appear frozen.
              // queueMicrotask so the ack follows any broadcast the dispatch
              // triggered (broadcast also defers via microtask).
              if (typeof action.cid === "string" && action.cid.length > 0) {
                const cid = action.cid;
                queueMicrotask(() => {
                  try {
                    sendTo(conn, `__ack:${cid}:1`);
                  } catch { /* client gone */ }
                });
              }
            }
          } catch {
            log.warn("uds", "malformed message");
          }
        }
      }
    } catch { /* connection closed */ }
    try {
      reader.releaseLock();
    } catch { /* stream may be errored (AIO-149) */ }
    connections.delete(conn);
    clientMap.delete(conn);
    try {
      conn.close();
    } catch { /* already closed */ }
    debug(`uds: client disconnected (${connections.size} total)`);
  })();
}
