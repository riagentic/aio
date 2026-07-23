// UDS (Unix Domain Socket) transport — NDJSON listener for Electron IPC bridge (AIO-52 Phase 3)
// Extracted from aio.ts. Speaks the same v2 envelope as WS (B4b) — one
// decoded line = one frame. Since v2, UDS serves sync + serverFns too
// (the alpha28 transport-capability skew is gone); vitals/time-travel stay
// WS-only diagnostics and are rejected loudly.

import { compactPatches } from "../state/patch-compact.ts";
import { writeClientLog } from "./client-log.ts";
import { log } from "../diagnostics/logger.ts";
import { _isFrameworkInternalActionType } from "./server-ws.ts";
import { invokeServerFn } from "./server-fns.ts";
import {
  type ActionPayload,
  dec,
  enc,
  encRaw,
  type SfnPayload,
  unsupportedOnUds,
} from "../protocol/envelope.ts";
import { VERSION } from "./aio-cli.ts";
import {
  negotiateProtocol,
  parseProtoHello,
  protoHello,
} from "../protocol/protocol-version.ts";
import type { ServerSyncHandler } from "../sync/server-handler.ts";

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
  syncHandler?: ServerSyncHandler | null,
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
      sendTo(conn, enc("proto", protoHello(VERSION)));
      // AIO-239: route initial write through sendTo() to use per-connection write queue
      sendTo(conn, encRaw("state", JSON.stringify(getUIState())));

      _handleUDSConn(
        conn,
        connSet,
        clientMap,
        pendingState,
        onAction,
        debug,
        getUIState,
        sendTo,
        syncHandler ?? null,
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
            const patchJson = JSON.stringify(allOps);
            // Size guard: if patches exceed full state, send full state instead
            const fullJson = _getFilteredFullJson(client);
            if (fullJson && patchJson.length > fullJson.length) {
              debug(
                `uds: patch payload (${patchJson.length}B) > full state (${fullJson.length}B) — sending full state`,
              );
              if (fullJson !== client.lastFullJson) {
                const fj = fullJson;
                sendTo(conn, encRaw("state", fullJson), () => {
                  client.lastFullJson = fj;
                });
              }
            } else {
              const fj = fullJson;
              sendTo(
                conn,
                encRaw("patches", patchJson),
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
        sendTo(conn, encRaw("state", json), () => {
          client.lastFullJson = j;
        });
      }
    },
    clients: () => [...clientMap.values()],
    requestClientState: (
      index: number,
      msg = enc("get-state"),
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
  syncHandler: ServerSyncHandler | null,
): void {
  const decoder = new TextDecoder();
  const MAX_BUF = 10 * 1024 * 1024; // 10MB — prevent OOM from missing newlines
  let buf = "";

  // Minimal structural WebSocket stand-in for the sync handler — it only
  // ever calls .send(). One stable object per conn so broadcast exclusion
  // (identity-based) stays consistent across calls.
  const _sinks = new WeakMap<Deno.Conn, WebSocket>();
  function _wireSink(conn: Deno.Conn): WebSocket {
    let sink = _sinks.get(conn);
    if (!sink) {
      sink = {
        send: (m: string) => sendTo(conn, m),
        readyState: 1,
      } as unknown as WebSocket;
      _sinks.set(conn, sink);
    }
    return sink;
  }

  function _sendFilteredState(conn: Deno.Conn, client: UDSClient): void {
    try {
      let uiState: unknown = getUIState();
      if (client.subscriptions) {
        const filtered: Record<string, unknown> = {};
        const src = uiState as Record<string, unknown>;
        for (const sub of client.subscriptions) {
          const feat = sub.includes(".") ? sub.slice(0, sub.indexOf(".")) : sub;
          if (feat in src && !(feat in filtered)) filtered[feat] = src[feat];
        }
        uiState = filtered;
      }
      const msg = JSON.stringify(uiState);
      sendTo(conn, encRaw("state", msg), () => {
        client.lastFullJson = msg;
      });
    } catch (err) {
      log.warn("uds", `filtered state send error — ${err}`);
    }
  }
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

          // v1 hello → refuse in the v1-readable string form (the one shim).
          if (line.startsWith("__proto:")) {
            log.error(
              "uds",
              "v1 client refused — this server speaks wire protocol v2+ (rebuild the client)",
            );
            sendTo(
              conn,
              "__proto-err:this server speaks wire protocol v2+ — rebuild/update the client",
            );
            sendTo(conn, "", () => {
              try {
                conn.close();
              } catch { /* already closed */ }
            });
            continue;
          }

          const frame = dec(line);
          if (!frame) {
            log.warn("uds", "undecodable frame — dropped");
            continue;
          }
          switch (frame.t) {
            case "ping":
              continue;
            case "proto": {
              const theirs = parseProtoHello(frame.d);
              if (!theirs) {
                debug("uds: malformed proto hello — ignored");
                continue;
              }
              const result = negotiateProtocol(protoHello(VERSION), theirs);
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
            case "client-state":
            case "ui-surface-result":
            case "ui-trigger-result": {
              const client = clientMap.get(conn);
              if (client) {
                const pending = pendingState.get(client.id);
                if (pending) {
                  pendingState.delete(client.id);
                  clearTimeout(pending.timer);
                  pending.resolve(frame.d ?? null);
                }
              }
              continue;
            }
            case "log": {
              const client = clientMap.get(conn);
              if (client && frame.d) {
                try {
                  // deno-lint-ignore no-explicit-any
                  writeClientLog(client.index, frame.d as any);
                } catch { /* malformed — drop */ }
              }
              continue;
            }
            case "subs": {
              const client = clientMap.get(conn);
              if (!client) continue;
              const paths = (frame.d as { subs?: unknown } | undefined)?.subs;
              if (Array.isArray(paths)) {
                if (paths.includes("*")) {
                  client.subscriptions = null;
                } else {
                  client.subscriptions = new Set(
                    paths.filter((p: unknown) => typeof p === "string"),
                  );
                }
                _sendFilteredState(conn, client);
              }
              continue;
            }
            case "resync": {
              // Client detected patch desync — send full state.
              const client = clientMap.get(conn);
              if (client) _sendFilteredState(conn, client);
              continue;
            }
            // ── v2 parity: sync + serverFns over UDS ────────────────────
            case "op": {
              const client = clientMap.get(conn);
              if (!syncHandler) {
                log.warn(
                  "uds",
                  "op received but sync is not configured — dropping",
                );
                continue;
              }
              const op = frame.d as Record<string, unknown> | undefined;
              if (
                !op || typeof op.id !== "string" ||
                typeof op.cell !== "string" || typeof op.action !== "string" ||
                !Array.isArray(op.hlc) ||
                ["__proto__", "constructor", "prototype"].includes(
                  op.cell as string,
                ) ||
                ["__proto__", "constructor", "prototype"].includes(
                  op.action as string,
                ) ||
                // Same gate as the WS path (audit F-1): op.action routes to
                // dispatch, so internal action types must be refused here too.
                _isFrameworkInternalActionType(op.action as string)
              ) {
                log.warn("uds", "invalid op — malformed or forbidden fields");
                continue;
              }
              syncHandler.handleOp(
                op,
                { id: client?.id ?? "uds" },
                _wireSink(conn),
              );
              continue;
            }
            case "sync-req": {
              const client = clientMap.get(conn);
              if (!syncHandler) {
                log.warn(
                  "uds",
                  "sync-req received but sync is not configured — dropping",
                );
                continue;
              }
              const sync = frame.d as Record<string, unknown> | undefined;
              if (!sync || typeof sync.clientId !== "string") {
                log.warn("uds", "invalid sync-req — malformed");
                continue;
              }
              syncHandler.handleSync(
                sync,
                { id: client?.id ?? "uds" },
                _wireSink(conn),
              );
              continue;
            }
            case "sfn": {
              const { cid, ns, name, args } = (frame.d ?? {}) as SfnPayload;
              if (
                typeof cid !== "string" || typeof ns !== "string" ||
                typeof name !== "string" || !Array.isArray(args)
              ) {
                log.warn("uds", "invalid sfn frame — dropping");
                continue;
              }
              // Fire-and-forget: BOTH the call and the reply encode must be
              // guarded. An unserializable return value (or a throwing access
              // predicate) escaped as an unhandled rejection, and aio's crash
              // handler is a last-words logger, not a survival net — one bad
              // serverFn took the whole server down.
              invokeServerFn(ns, name, args)
                .then((result) => {
                  try {
                    sendTo(conn, enc("sfnr", { cid, ...result }));
                  } catch (e) {
                    sendTo(
                      conn,
                      enc("sfnr", {
                        cid,
                        ok: false,
                        error: `serverFn result is not serializable: ${e}`,
                      }),
                    );
                  }
                })
                .catch((e) => {
                  log.error("uds", `sfn ${ns}.${name} failed — ${e}`);
                  try {
                    sendTo(
                      conn,
                      enc("sfnr", { cid, ok: false, error: String(e) }),
                    );
                  } catch { /* peer gone */ }
                });
              continue;
            }
            case "action": {
              const action = (frame.d ?? {}) as ActionPayload;
              if (!action || typeof action.type !== "string") {
                log.warn("uds", "invalid action — missing type field");
                continue;
              }
              // Block framework-internal action types from UDS sources —
              // parity with the WS server. Internal actions carry trusted
              // payload shapes that bypass cell method bodies (audit F-1).
              if (_isFrameworkInternalActionType(action.type)) {
                log.warn(
                  "uds",
                  `rejected framework-internal action type "${action.type}"`,
                );
                continue;
              }
              // Strip client-set identity provenance — parity with the WS
              // server; a network-sourced `_user` must never become the
              // trusted dispatch identity, and a forged `payload._origin` must
              // not steer the cell `access` method check (see server-ws.ts).
              delete (action as Record<string, unknown>)._user;
              const _pl = (action as { payload?: unknown }).payload;
              if (_pl && typeof _pl === "object") {
                delete (_pl as Record<string, unknown>)._origin;
              }
              onAction(action);
              // AIO-402: per-action ack — parity with the WS server. Settles
              // the Promise of an awaited method call over UDS+IPC.
              // queueMicrotask so the ack follows any broadcast the dispatch
              // triggered.
              if (typeof action.cid === "string" && action.cid.length > 0) {
                const cid = action.cid;
                queueMicrotask(() => {
                  try {
                    sendTo(conn, enc("ack", { cid, ok: true }));
                  } catch { /* client gone */ }
                });
              }
              continue;
            }
            default:
              // Vitals/time-travel are WS-only diagnostics; anything else
              // S→C-only. Loud, never silent (dev/prod equivalency).
              log.warn(
                "uds",
                unsupportedOnUds(frame.t)
                  ? `"${frame.t}" frames are WS-only diagnostics — not served over UDS/IPC`
                  : `unexpected "${frame.t}" frame from client — dropped`,
              );
              continue;
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
