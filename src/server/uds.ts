// UDS (Unix Domain Socket) transport — NDJSON listener for Electron IPC bridge (AIO-52 Phase 3)
// Extracted from aio.ts. Speaks the same v2 envelope as WS (B4b) — one
// decoded line = one frame. Since v2, UDS serves sync + serverFns too
// (the alpha28 transport-capability skew is gone); time travel flows here too
// (tt-state out, tt-cmd in — the Electron panel needs it); vitals stay
// WS-only and are rejected loudly.

import { compactPatches } from "../state/patch-compact.ts";
import { writeClientLog } from "./client-log.ts";
import { log } from "../diagnostics/logger-api.ts";
import {
  _recordClientDegraded,
  type DegradedChange,
} from "../diagnostics/degraded.ts";
import {
  _isFrameworkInternalActionType,
  sanitizeClientAction,
} from "./server-ws.ts";
import { invokeServerFn } from "./server-fns.ts";
import {
  type ActionPayload,
  type CtlPayload,
  dec,
  enc,
  encRaw,
  isIgnorableKind,
  type SfnPayload,
  unsupportedOnUds,
} from "../protocol/envelope.ts";
import { serializeReturn } from "../protocol/return-value.ts";
import { VERSION } from "./aio-cli.ts";
import { parseTTCommand } from "../diagnostics/time-travel.ts";
import {
  negotiateProtocol,
  parseProtoHello,
  protoHello,
} from "../protocol/protocol-version.ts";
import type { ServerSyncHandler } from "../sync/server-handler.ts";
import { isPipePath, listenLocal, type LocalConn } from "./local-listen.ts";

/** How long the server waits for a live client to answer a control request
 *  (`am surface N`, `am trigger N …`, `am client N`) — THE one decider for both
 *  transports (WS in server-ws.ts, UDS here). `am`'s transport timeout must be
 *  strictly LONGER (am-http.ts asserts it): with the two equal, the transport
 *  gave up in the same instant this fired, and the reason named here never
 *  reached the caller — every stall read as "timeout connecting". */
export const CLIENT_REPLY_TIMEOUT_MS = 5000;

/** The named reason a client did not answer, with the causes a caller can act
 *  on. `ok:false` so the CLI's one "did this happen" rule (`data.ok === false`)
 *  fails the command instead of printing the error as a success. */
export function clientReplyTimeoutError(index: number): string {
  return `client ${index} did not respond within ${CLIENT_REPLY_TIMEOUT_MS}ms — ` +
    `it is connected but not answering ui requests: its main thread is busy ` +
    `(a long render/effect), or it is a headless/thin client that does not ` +
    `run the ui-trigger handler. Check \`am clients\` for the index you meant.`;
}

export type UDSClient = {
  conn: LocalConn;
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
  onAction: (
    action: { type: string; payload?: unknown },
  ) => Promise<unknown> | void,
  debug: (msg: string) => void,
  clientCounter?: { value: number },
  syncHandler?: ServerSyncHandler | null,
  /** Resolved client config — sent as an early "cfg" frame (the electron UDS
   *  shell is templated at build time and embeds no `__aioConfig`). */
  clientConfig?: Record<string, unknown>,
  /** Time travel (dev): command sink + state getter. tt-state used to flow to
   *  WS clients only — the Electron window's panel (Ctrl+.) never received a
   *  frame, so the shortcut never even bound. */
  tt?: {
    onCommand: (cmd: string, arg?: number) => void;
    getBroadcast: () => unknown;
  },
  /** Raise the per-frame buffer ceiling (default 10 MB) — the UDS twin of
   *  `wsLimits.maxMessageBytes`. An app that raises its WS frame limit for
   *  large payloads (a base64 attachment) hits the same wall here when the
   *  Electron window talks over UDS instead, and the failure was a silent
   *  connection reset mid-send. Never lowers the default. */
  maxFrameBytes?: number,
  /** Serve one control-plane request that arrived as a `ctl` frame.
   *
   *  Supplied by `aio-server.ts` from the ServerHandle, so it IS the HTTP
   *  handler — same routes, same auth gates, same dev-only trojan mount. When
   *  absent (no HTTP server was built), a `ctl` frame is answered with a plain
   *  503 rather than dropped: a control client that gets silence cannot tell
   *  "refused" from "this build has no control plane". */
  control?: (req: Request) => Promise<Response>,
): UDSHandle {
  // A stale socket FILE from a crashed instance is unlinked; a pipe is a
  // kernel name that vanished with that process — nothing to remove.
  if (!isPipePath(socketPath)) {
    try {
      Deno.removeSync(socketPath);
    } catch { /* doesn't exist */ }
  }

  const listener = listenLocal(socketPath);
  const connSet = new Set<LocalConn>();
  const clientMap = new Map<LocalConn, UDSClient>();
  const counter = clientCounter ?? { value: 0 };
  let closed = false;

  const pendingState = new Map<
    string,
    { resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }
  >();

  (async () => {
    for await (const conn of listener) {
      // Everything below is PER-CONNECTION work, and this loop is the
      // transport's only door: a throw here does not fail one client, it ends
      // the loop — and `for await` disposes the listener on the way out, so the
      // process runs on with a socket nothing will ever accept again (and a
      // shutdown that then throws BadResource). One unserializable snapshot
      // used to be enough. Fail the CONNECTION, loudly, and keep the door open.
      try {
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
        if (clientConfig && Object.keys(clientConfig).length > 0) {
          sendTo(conn, enc("cfg", clientConfig));
        }
        // AIO-239: route the initial write through sendTo() for the
        // per-connection write queue — and through the SAME snapshot builder
        // every later frame uses, so the accept-time state cannot drift from
        // (or crash where) the broadcast-time state does.
        const initial = _fullJsonFor(client);
        if (initial !== undefined) {
          sendTo(conn, encRaw("state", initial), () => {
            client.lastFullJson = initial;
          });
        }
        // Dev: hand the panel its history now — Ctrl+. binds on the first
        // tt-state frame, so without this the shortcut is inert until the next
        // recorded action's broadcast.
        if (tt) sendTo(conn, enc("tt-state", tt.getBroadcast()));

        _handleUDSConn(
          conn,
          connSet,
          clientMap,
          pendingState,
          onAction,
          debug,
          _fullJsonFor,
          sendTo,
          syncHandler ?? null,
          tt,
          maxFrameBytes,
          control,
        );
      } catch (e) {
        log.error("uds", `client handshake failed — ${e}`);
        connSet.delete(conn);
        clientMap.delete(conn);
        try {
          conn.close();
        } catch { /* already closed */ }
      }
    }
  })().catch((e) => {
    if (!closed) log.error("uds", `accept loop error — ${e}`);
  });

  // AIO-216: per-connection write queue to prevent byte interleaving
  const _writeQueues = new WeakMap<LocalConn, Promise<void>>();

  function sendTo(conn: LocalConn, msg: string, onSent?: () => void): void {
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

  /** THE snapshot builder for this listener: read state, apply the client's
   *  subscription filter, serialize. Every state frame on this transport —
   *  accept-time, broadcast, `subs` reply, `resync` reply — comes from here,
   *  because a snapshot that is built two ways is a snapshot that eventually
   *  differs two ways.
   *
   *  `undefined` means the snapshot could not be produced (a throwing getter, a
   *  BigInt, a cycle). Serializing is INSIDE the guard: the stringify is where
   *  that actually throws, and it used to sit outside — so the guard caught the
   *  rarer failure and let the common one through. */
  function _fullJsonFor(
    client: Pick<UDSClient, "subscriptions">,
  ): string | undefined {
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
      return JSON.stringify(uiState);
    } catch (e) {
      log.error("uds", `state snapshot failed — ${e}`);
      return undefined;
    }
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
            const fullJson = _fullJsonFor(client);
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
        const json = _fullJsonFor(client);
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
          resolve({ error: clientReplyTimeoutError(index) });
        }, CLIENT_REPLY_TIMEOUT_MS);
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
      if (!isPipePath(socketPath)) {
        try {
          Deno.removeSync(socketPath);
        } catch { /* already removed */ }
      }
    },
  };
}

/** The per-frame buffer ceiling for a UDS connection.
 *
 *  10MB floor — it prevents an OOM from a peer that never sends a newline. An
 *  app may RAISE it via `wsLimits.maxMessageBytes` (the WS frame limit; this is
 *  its twin, so one transport cannot refuse a payload the other accepts — a
 *  ~9MB base64 attachment travelled over WS and reset the Electron/UDS
 *  connection mid-send), and may never LOWER it below the floor. Pure, so the
 *  rule is unit-tested rather than reasoned about. */
export function udsFrameCeiling(maxFrameBytes?: number): number {
  return Math.max(10 * 1024 * 1024, maxFrameBytes ?? 0);
}

function _handleUDSConn(
  conn: LocalConn,
  connections: Set<LocalConn>,
  clientMap: Map<LocalConn, UDSClient>,
  pendingState: Map<
    string,
    { resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }
  >,
  onAction: (
    action: { type: string; payload?: unknown },
  ) => Promise<unknown> | void,
  debug: (msg: string) => void,
  /** THE snapshot builder (see `_fullJsonFor`) — passed in, never re-derived
   *  here: this handler used to carry its own copy of the subscription filter,
   *  which is the same fact decided twice. */
  fullJsonFor: (client: Pick<UDSClient, "subscriptions">) => string | undefined,
  sendTo: (conn: LocalConn, msg: string, onSent?: () => void) => void,
  syncHandler: ServerSyncHandler | null,
  tt?: {
    onCommand: (cmd: string, arg?: number) => void;
    getBroadcast: () => unknown;
  },
  maxFrameBytes?: number,
  /** The control-plane server (see `createUDSListener`) — the HTTP handler
   *  itself, so a `ctl` frame meets the same routes and gates as a request
   *  over TCP. */
  control?: (req: Request) => Promise<Response>,
): void {
  const decoder = new TextDecoder();
  const MAX_BUF = udsFrameCeiling(maxFrameBytes);
  let buf = "";

  // Minimal structural WebSocket stand-in for the sync handler — it only
  // ever calls .send(). One stable object per conn so broadcast exclusion
  // (identity-based) stays consistent across calls.
  const _sinks = new WeakMap<LocalConn, WebSocket>();
  function _wireSink(conn: LocalConn): WebSocket {
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

  function _sendFilteredState(conn: LocalConn, client: UDSClient): void {
    const msg = fullJsonFor(client);
    if (msg === undefined) return; // already reported by the snapshot builder
    sendTo(conn, encRaw("state", msg), () => {
      client.lastFullJson = msg;
    });
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
            case "type": {
              // A peer declaring it is not a UI. The control client (`am`,
              // amui) asks a question and leaves; it is not a window, so it
              // must not appear in the client roster, must not consume the
              // index `am surface N` addresses, and must not be mailed state
              // broadcasts it will never render. `clientMap` keys BOTH the
              // roster and the broadcast loop, so leaving it is the whole fix.
              const kind = (frame.d as { kind?: string } | undefined)?.kind;
              if (kind === "control") clientMap.delete(conn);
              continue;
            }
            case "tt-cmd": {
              if (tt && typeof frame.d === "string") {
                const cmd = parseTTCommand(frame.d);
                if (cmd) {
                  tt.onCommand(cmd.cmd, "arg" in cmd ? cmd.arg : undefined);
                }
              }
              continue;
            }
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
            case "cdiag": {
              // A client's degraded() escalation — mirrors server-ws.ts.
              // Electron speaks UDS, so a health escalation from its renderer
              // MUST land here too, or /__aio/health reports "healthy" while
              // the window's subsystem is failing forever (the exact silent
              // fork the cdiag frame exists to close). Values are capped
              // inside _recordClientDegraded; malformed frames are dropped.
              const client = clientMap.get(conn);
              const d = frame.d as DegradedChange | undefined;
              if (
                client && d && typeof d.name === "string" &&
                d.name.length > 0 &&
                (d.kind === "down" || d.kind === "up")
              ) {
                _recordClientDegraded(client.id, {
                  name: d.name,
                  kind: d.kind,
                  failures: typeof d.failures === "number" ? d.failures : 0,
                  since: typeof d.since === "number" ? d.since : Date.now(),
                  lastError: typeof d.lastError === "string" ? d.lastError : "",
                });
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
            case "ctl": {
              // The control plane (`am`, amui) over the socket. The frame is
              // HTTP-shaped on purpose: it is turned back into a `Request` and
              // handed to the server's own handler, so nothing about the
              // trojan's routing or its gates is re-decided here. This file
              // does transport, not policy.
              const c = (frame.d ?? {}) as CtlPayload;
              if (
                typeof c?.id !== "string" || typeof c.path !== "string" ||
                (c.method !== "GET" && c.method !== "POST")
              ) {
                log.warn("uds", "invalid ctl frame — dropping");
                continue;
              }
              const reply = (
                status: number,
                body: string,
                headers?: Record<string, string>,
              ) => {
                try {
                  sendTo(
                    conn,
                    enc("ctlr", { id: c.id, status, body, headers }),
                  );
                } catch { /* peer gone mid-call */ }
              };
              if (!control) {
                reply(
                  503,
                  JSON.stringify({
                    error:
                      "this app has no control plane (no HTTP handler built)",
                  }),
                );
                continue;
              }
              // The origin is a placeholder: only the PATH is routed on, and
              // every gate downstream reads the peer address, never the host.
              const req = new Request(`http://uds.invalid${c.path}`, {
                method: c.method,
                headers: c.headers ?? {},
                ...(c.method === "POST" ? { body: c.body ?? "" } : {}),
              });
              control(req)
                .then(async (res: Response) => {
                  const headers: Record<string, string> = {};
                  res.headers.forEach((v: string, k: string) => {
                    headers[k] = v;
                  });
                  reply(res.status, await res.text(), headers);
                })
                .catch((e: unknown) => {
                  // A throw from the handler is an ANSWER, not a dropped
                  // frame — the caller is waiting on this id.
                  log.error("uds", `ctl ${c.method} ${c.path} failed — ${e}`);
                  reply(500, JSON.stringify({ error: String(e) }));
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
              // Strip client-set trusted provenance and re-stamp
              // `_source:"UI"` — ONE decider for all three network entry
              // points (sanitizeClientAction, server-ws.ts).
              sanitizeClientAction(action as Record<string, unknown>, "uds");
              const result = onAction(action);
              // AIO-402 + return-value transport: per-action ack — parity with
              // the WS server. Settles the Promise of an awaited method call
              // over UDS+IPC, carrying the method's RETURN value. We wait for
              // the dispatch promise (async → completion; sync/void → next
              // microtask, after any broadcast the dispatch triggered).
              if (typeof action.cid === "string" && action.cid.length > 0) {
                const cid = action.cid;
                const actionType = typeof action.type === "string"
                  ? action.type
                  : "?";
                Promise.resolve(result).then(
                  (value) => {
                    const { value: safe, dropped } = serializeReturn(
                      value,
                      actionType,
                    );
                    if (dropped) {
                      log.warn(
                        "uds",
                        `method "${actionType}" returned a non-serializable ` +
                          `value — caller resolves with undefined. Return ` +
                          `JSON-safe data to transport a value.`,
                      );
                    }
                    try {
                      sendTo(conn, enc("ack", { cid, ok: true, value: safe }));
                    } catch { /* client gone */ }
                  },
                  (err) => {
                    try {
                      sendTo(
                        conn,
                        enc("ack", { cid, ok: false, error: String(err) }),
                      );
                    } catch { /* client gone */ }
                  },
                );
              }
              continue;
            }
            default:
              // Reserved-ignorable kinds ("x" extension frames) skip silently
              // BY CONTRACT — see IGNORABLE in envelope.ts.
              if (isIgnorableKind(frame.t)) continue;
              // Vitals are WS-only diagnostics; anything else S→C-only.
              // Loud, never silent (dev/prod equivalency).
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
