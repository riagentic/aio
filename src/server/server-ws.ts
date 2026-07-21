// WebSocket connection handler — extracted from server.ts
// Manages WS upgrades, per-client state, message routing, rate limiting, backpressure
import type { AioUser } from "./aio.ts";
import { invokeServerFn } from "./server-fns.ts";
import { filterStateBySubs, parseSubs } from "../protocol/broadcast-utils.ts";
import { writeClientLog } from "./client-log.ts";
import { log } from "../diagnostics/logger.ts";
import type { ClientLogEntry } from "../air/dom-inspector-types.ts";
import type { VitalsSystem } from "../vitals/mod.ts";
import {
  negotiateProtocol,
  parseProtoHello,
  PROTOCOL_MISMATCH_CLOSE_CODE,
  protoHello,
} from "../protocol/protocol-version.ts";

/** Safety limits — prevent resource exhaustion */
const WS_MAX_MESSAGE = 1_000_000; // 1MB — reject oversized WS messages
const WS_MAX_CONNECTIONS = 100; // max concurrent WebSocket clients
const WS_RATE_LIMIT = 100; // max messages per second per client
const WS_BYTES_PER_SEC = 5_000_000; // 5MB/s per client — prevents bandwidth DoS

/** Backpressure thresholds */
const BP_STALENESS_HIGH = 300; // ms — client render staleness triggering 4x throttle
const BP_STALENESS_MODERATE = 100; // ms — 2x throttle
const BP_RECOVERY_PINGS = 3; // consecutive low-staleness pings before stepping down

/** Consecutive drop threshold before client is flagged as abusive (H3/H4 fix). */
const CONSECUTIVE_DROP_THRESHOLD = 50;

/** How long (ms) an abusive client key stays denylisted after forced close.
 *  Plugs F-4: per-socket strike counters get reset on reconnect, so an IP
 *  can amplify throughput by cycling connections. Denylist survives reconnects. */
const ABUSE_DENYLIST_MS = 60_000;

/** Action types that may only be dispatched from server-internal code paths.
 *  Match either a top-level `__name` or a cell-prefixed `cell:__name` form. */
export function _isFrameworkInternalActionType(type: string): boolean {
  if (type.startsWith("__")) return true;
  const colon = type.indexOf(":");
  if (colon === -1) return false;
  return type.charCodeAt(colon + 1) === 0x5f /* "_" */ &&
    type.charCodeAt(colon + 2) === 0x5f;
}

export type ClientType =
  | "electron"
  | "browser"
  | "electron-reload"
  | "browser-reload"
  | "unknown";

export type ClientMeta = {
  id: string;
  index: number;
  clientType: ClientType;
  isElectron: boolean;
  user?: AioUser;
  lastFullJson?: string;
  msgCount: number;
  bytesThisSec: number;
  msgResetTimer?: ReturnType<typeof setTimeout>;
  typeDetectTimer?: ReturnType<typeof setTimeout>;
  bpMultiplier: number;
  bpConsecutiveLow: number;
  bpLastSentAt: number;
  // H3/H4 fix: track consecutive drops for abuse detection (backpressure deadlock prevention)
  consecutiveDrops: number;
  subscriptions: Set<string> | null;
  disconnected: boolean;
  /** Stable client key (usually remote IP) used for cross-connection abuse tracking. */
  clientKey?: string;
  /** Negotiated wire-protocol version (A3). Undefined until the client's
   *  `__proto:` hello arrives; legacy clients never send one. */
  protocolVersion?: number;
};

/** Dependencies injected from server.ts closure */
export interface WsDeps {
  dispatch: (event: unknown, user?: AioUser) => void;
  getUIState: (user?: AioUser) => unknown;
  debug: (msg: string) => void;
  prod: boolean;
  maxConnections?: number;
  wsLimits?: import("./aio-types.ts").WsLimits;
  expose?: boolean;
  allowedOrigins?: string[];
  /** When true AND expose=true, require Origin header on WS upgrade.
   *  Plugs F-6: empty/absent Origin is otherwise accepted by the handshake. */
  strictOrigin?: boolean;
  clientCounter: { value: number };
  bootId: string;
  vitalsSystem?: VitalsSystem;
  onConnect?: (user?: AioUser) => void;
  onDisconnect?: (user?: AioUser) => void;
  onTTCommand?: (cmd: string, arg?: number) => void;
  getTTBroadcast?: () => unknown;
  syncHandler?: {
    handleOp: (
      op: unknown,
      meta: { id: string; user?: unknown },
      socket: WebSocket,
    ) => void;
    handleSync: (
      sync: unknown,
      meta: { id: string; user?: unknown },
      socket: WebSocket,
    ) => void;
  };
}

/** Returned by createWsManager — the WS subsystem's public API */
export interface WsManager {
  handleWs: (req: Request, user?: AioUser, clientKey?: string) => Response;
  connections: Map<WebSocket, ClientMeta>;
  payloadStats: Map<
    string,
    { lastPayloadBytes: number; totalBytes: number; count: number }
  >;
  pendingClientState: Map<
    string,
    { resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }
  >;
  sendToWsClient: (
    idx: number,
    msg: string,
  ) => { found: true; promise: Promise<Response> } | { found: false };
  shutdown: () => void;
}

const PENDING_STATE_MAX = 50;

/** Factory — creates isolated WS manager with its own connection state */
export function createWsManager(deps: WsDeps): WsManager {
  // W6.6: per-client limits are configurable; defaults stay the hardened
  // constants so existing deployments are unchanged.
  const wsMaxMessage = deps.wsLimits?.maxMessageBytes ?? WS_MAX_MESSAGE;
  const wsRateLimit = deps.wsLimits?.messagesPerSec ?? WS_RATE_LIMIT;
  const wsBytesPerSec = deps.wsLimits?.bytesPerSec ?? WS_BYTES_PER_SEC;

  // Global rolling-window message counter — protects against distributed
  // clients each staying under the per-socket limit while flooding the server.
  let _totalMsgsThisSec = 0;
  let _globalRateTimer: ReturnType<typeof setTimeout> | undefined;

  const connections = new Map<WebSocket, ClientMeta>();
  const payloadStats = new Map<
    string,
    { lastPayloadBytes: number; totalBytes: number; count: number }
  >();
  const pendingClientState = new Map<
    string,
    { resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }
  >();
  const nextIndex = () => deps.clientCounter.value++;

  // F-4: IP/client-key denylist with TTL. Survives socket reconnects so
  // abusive clients can't reset their strike count by opening new connections.
  const abuseDenylist = new Map<string, number>(); // key → expiresAt (epoch ms)
  function _isDenied(key: string | undefined): boolean {
    if (!key) return false;
    const expiresAt = abuseDenylist.get(key);
    if (expiresAt === undefined) return false;
    if (Date.now() > expiresAt) {
      abuseDenylist.delete(key);
      return false;
    }
    return true;
  }
  function _addToDenylist(key: string | undefined): void {
    if (!key) return;
    abuseDenylist.set(key, Date.now() + ABUSE_DENYLIST_MS);
  }

  // Derive request kind from WS command message for deduplication key
  const reqKind = (msg: string) =>
    msg.startsWith("__ui:surface")
      ? "surface"
      : msg.startsWith("__ui:trigger")
      ? "trigger"
      : "clientState";

  function handleWs(
    req: Request,
    user?: AioUser,
    clientKey?: string,
  ): Response {
    // F-4: reject denylisted clients at handshake so reconnect loops can't
    // reset per-socket abuse counters.
    if (_isDenied(clientKey)) {
      deps.debug(`ws: rejected denylisted client ${clientKey}`);
      return new Response("Too Many Requests", { status: 429 });
    }
    // CSWSH defense — always validate Origin header. Browsers attach Origin to
    // every cross-origin WebSocket upgrade; same-origin tools (curl, internal
    // health checks) typically omit it, in which case we accept the upgrade.
    //
    // Audit F-2: previous logic only ran the check when (!expose || allowedOrigins),
    // so `--expose` without an explicit allowedOrigins accepted any origin —
    // a Cross-Site WebSocket Hijacking surface for token-in-URL deployments.
    const origin = req.headers.get("origin");
    // F-6: defense-in-depth for --expose deployments. When strictOrigin is on,
    // reject upgrades that have no Origin header (or empty string). Without this,
    // origin-stripping proxies and certain sandboxed contexts reach the handler
    // with falsy `origin` and bypass the check below.
    if (deps.expose && deps.strictOrigin && !origin) {
      deps.debug("ws: rejected — strictOrigin requires Origin header");
      return new Response("Forbidden", { status: 403 });
    }
    if (origin) {
      try {
        const u = new URL(origin);
        const h = u.hostname;
        const isLocal = h === "localhost" || h === "127.0.0.1" ||
          h === "::1" || h === "[::1]";
        const allowed = deps.allowedOrigins ?? [];
        const isAllowed = allowed.includes(h) || allowed.includes("*");
        // a page this very server served has Origin === our Host header
        const hostHeader = req.headers.get("host");
        const isOwnHost = hostHeader !== null && u.host === hostHeader;
        if (!isLocal && !isAllowed && !isOwnHost) {
          deps.debug(`ws: rejected origin ${origin}`);
          return new Response("Forbidden", { status: 403 });
        }
      } catch {
        return new Response("Bad Request", { status: 400 });
      }
    }

    const maxConn = deps.maxConnections ?? WS_MAX_CONNECTIONS;
    if (connections.size >= maxConn) {
      deps.debug(`ws: rejected — max connections (${maxConn})`);
      return new Response("Too Many Connections", { status: 503 });
    }
    // Read headers BEFORE upgrading — upgradeWebSocket consumes the request,
    // and header access afterwards throws "Request closed" (Deno ≥2.9),
    // killing the serve callback on every WS connect.
    const userAgent = req.headers.get("user-agent") ?? "";
    const { socket, response } = Deno.upgradeWebSocket(req);
    const clientId = crypto.randomUUID();
    const clientIndex = nextIndex();
    const isElectron = /electron/i.test(userAgent);
    const meta: ClientMeta = {
      id: clientId,
      index: clientIndex,
      clientType: "unknown",
      isElectron,
      user,
      msgCount: 0,
      bytesThisSec: 0,
      bpMultiplier: 1,
      bpConsecutiveLow: 0,
      bpLastSentAt: 0,
      subscriptions: null,
      disconnected: false,
      consecutiveDrops: 0,
      clientKey,
    };

    socket.onerror = (e) => {
      log.warn(
        "ws",
        `error ${clientId.slice(0, 8)} — ${
          e instanceof ErrorEvent ? e.message : e
        }`,
      );
      connections.delete(socket);
      _clearTimers(meta);
      _cleanupVitals(meta);
      if (!meta.disconnected && deps.onDisconnect) {
        meta.disconnected = true;
        try {
          deps.onDisconnect(meta.user);
        } catch (err) {
          log.warn("ws", `hook onDisconnect: ${err}`);
        }
      }
    };

    socket.onopen = () => {
      connections.set(socket, meta);
      meta.typeDetectTimer = setTimeout(() => {
        meta.typeDetectTimer = undefined;
        if (meta.clientType === "unknown") {
          meta.clientType = meta.isElectron
            ? "electron-reload"
            : "browser-reload";
        }
      }, 2000);
      deps.debug(
        `ws: connect ${clientId.slice(0, 8)} user=${
          user?.id ?? "anon"
        } (${connections.size} total)`,
      );
      if (deps.onConnect) {
        try {
          deps.onConnect(meta.user);
        } catch (e) {
          deps.debug(`hook onConnect: ${e}`);
        }
      }
      // A3: version handshake — server speaks first, before any state.
      try {
        socket.send("__proto:" + JSON.stringify(protoHello()));
      } catch { /* socket closing during onopen (AIO-155) */ }
      try {
        const uiState = deps.getUIState(meta.user);
        const msg = JSON.stringify(uiState);
        socket.send(msg);
        meta.lastFullJson = msg;
      } catch (e) {
        deps.debug(`ws: getUIState error on connect — ${e}`);
      }
      if (deps.getTTBroadcast) {
        try {
          socket.send("__tt:" + JSON.stringify(deps.getTTBroadcast()));
        } catch (e) {
          deps.debug(`ws: getTTBroadcast error on connect — ${e}`);
        }
      }
      try {
        socket.send("__boot:" + deps.bootId);
      } catch { /* socket closing during onopen (AIO-155) */ }
    };

    socket.onmessage = (e) => {
      try {
        _handleMessage(socket, meta, e);
      } catch (err) {
        deps.debug(`ws: malformed message — ${err}`);
      }
    };

    socket.onclose = () => {
      connections.delete(socket);
      _clearTimers(meta);
      deps.debug(
        `ws: disconnect ${clientId.slice(0, 8)} user=${
          meta.user?.id ?? "anon"
        } (${connections.size} total)`,
      );
      _cleanupVitals(meta);
      if (!meta.disconnected && deps.onDisconnect) {
        meta.disconnected = true;
        try {
          deps.onDisconnect(meta.user);
        } catch (e) {
          log.warn("ws", `hook onDisconnect: ${e}`);
        }
      }
    };
    return response;
  }

  function _clearTimers(meta: ClientMeta): void {
    if (meta.msgResetTimer) {
      clearTimeout(meta.msgResetTimer);
      meta.msgResetTimer = undefined;
    }
    if (meta.typeDetectTimer) {
      clearTimeout(meta.typeDetectTimer);
      meta.typeDetectTimer = undefined;
    }
  }

  function _cleanupVitals(meta: ClientMeta): void {
    if (deps.vitalsSystem) {
      deps.vitalsSystem.serverTransport.removeClient(meta.id);
      deps.vitalsSystem.pressureMonitor?.onClientDisconnect(meta.id);
      payloadStats.delete(meta.id);
    }
  }

  /** Route a single WS message — called from socket.onmessage */
  function _handleMessage(
    socket: WebSocket,
    meta: ClientMeta,
    e: MessageEvent,
  ): void {
    // Rate limiting — per-second counter (original behavior)
    meta.msgCount++;
    if (!meta.msgResetTimer) {
      meta.msgResetTimer = setTimeout(() => {
        meta.msgCount = 0;
        meta.bytesThisSec = 0;
        meta.msgResetTimer = undefined;
      }, 1000);
    }

    // Reset global rolling-window counter once per second (lazy)
    if (!_globalRateTimer) {
      _globalRateTimer = setTimeout(() => {
        _totalMsgsThisSec = 0;
        _globalRateTimer = undefined;
      }, 1000);
    }

    // Global rate-limit fuse: rolling window counter on WsManager itself
    _totalMsgsThisSec++;
    if (_totalMsgsThisSec > wsRateLimit * 2) {
      const msg =
        `ws: global rate limit exceeded (${_totalMsgsThisSec} msg/sec) — dropping from client ${
          meta.id.slice(0, 8)
        }`;
      log.error("ws", msg);
      writeClientLog(meta.index, {
        level: "error",
        msg,
        ts: Date.now(),
        source: "server-ws",
      });
      return;
    }

    // H3/H4 fix: track consecutive drops for abuse detection (backpressure deadlock prevention)
    if (meta.msgCount > wsRateLimit) {
      meta.consecutiveDrops++;
      if (meta.consecutiveDrops >= CONSECUTIVE_DROP_THRESHOLD) {
        const msg = `ws: client ${
          meta.id.slice(0, 8)
        } flagged — ${meta.consecutiveDrops} consecutive drops`;
        log.error("ws", msg);
        writeClientLog(meta.index, {
          level: "error",
          msg,
          ts: Date.now(),
          source: "server-ws",
        });
        // F-4: block this client-key at handshake for ABUSE_DENYLIST_MS
        // so reconnect loops can't reset the strike counter.
        _addToDenylist(meta.clientKey);
        try {
          socket.close(1008, "Rate limit exceeded");
        } catch { /* already closed */ }
        return;
      }
      return;
    }

    // Reset consecutive drop counter on successful message
    meta.consecutiveDrops = 0;

    if (typeof e.data !== "string") {
      const msg = "ws: binary message dropped — only JSON strings accepted";
      log.error("ws", msg);
      writeClientLog(meta.index, {
        level: "error",
        msg,
        ts: Date.now(),
        source: "server-ws",
      });
      return;
    }
    if (e.data.length > wsMaxMessage) {
      const msg = `ws: message too large (${e.data.length} bytes), dropped`;
      log.error("ws", msg);
      writeClientLog(meta.index, {
        level: "error",
        msg,
        ts: Date.now(),
        source: "server-ws",
      });
      try {
        socket.send(
          JSON.stringify({
            error: "message_too_large",
            code: 1009,
            size: e.data.length,
          }),
        );
      } catch { /* client gone */ }
      return;
    }
    meta.bytesThisSec += e.data.length;
    if (meta.bytesThisSec > wsBytesPerSec) {
      const msg = `ws: byte rate exceeded for ${meta.id.slice(0, 8)} (${
        (meta.bytesThisSec / 1_000_000).toFixed(1)
      }MB/s)`;
      log.error("ws", msg);
      writeClientLog(meta.index, {
        level: "error",
        msg,
        ts: Date.now(),
        source: "server-ws",
      });
      return;
    }

    // Client state response (dev mode) — resolves pending am request
    if (e.data.startsWith("__clientState:")) {
      _resolvePending(meta, "clientState", e.data.slice(14));
      return;
    }
    // Client log forwarding (dev mode)
    if (!deps.prod && e.data.startsWith("__log:")) {
      try {
        writeClientLog(
          meta.index,
          JSON.parse(e.data.slice(6)) as ClientLogEntry,
        );
      } catch { /* malformed */ }
      return;
    }
    // UI semantic-surface result
    if (e.data.startsWith("__ui:surface-result:")) {
      _resolvePending(
        meta,
        "surface",
        e.data.slice("__ui:surface-result:".length),
      );
      return;
    }
    // UI semantic-trigger result
    if (e.data.startsWith("__ui:trigger-result:")) {
      _resolvePending(
        meta,
        "trigger",
        e.data.slice("__ui:trigger-result:".length),
      );
      return;
    }
    // Client type identification
    if (e.data.startsWith("__type:")) {
      const t = e.data.slice(7);
      if (t === "electron" || t === "browser") meta.clientType = t;
      return;
    }
    // A3: wire-protocol version handshake
    if (e.data.startsWith("__proto:")) {
      const theirs = parseProtoHello(e.data.slice(8));
      if (!theirs) {
        deps.debug(
          `ws: malformed __proto hello from ${meta.id.slice(0, 8)} — ignored`,
        );
        return;
      }
      const result = negotiateProtocol(protoHello(), theirs);
      if (!result.ok) {
        const msg = `ws: protocol mismatch with client ${
          meta.id.slice(0, 8)
        } — ${result.reason}`;
        log.error("ws", msg);
        writeClientLog(meta.index, {
          level: "error",
          msg,
          ts: Date.now(),
          source: "server-ws",
        });
        try {
          socket.send("__proto-err:" + result.reason);
          socket.close(PROTOCOL_MISMATCH_CLOSE_CODE, "protocol mismatch");
        } catch { /* already closed */ }
        return;
      }
      meta.protocolVersion = result.effective;
      return;
    }
    // Time-travel commands
    if (e.data.startsWith("__tt:") && deps.onTTCommand) {
      _handleTTCommand(e.data);
      return;
    }
    // Vitals ping
    if (e.data.startsWith("__vitals:ping:")) {
      _handleVitalsPing(socket, meta, e.data);
      return;
    }
    // Subscription update
    if (e.data.startsWith("__subs:")) {
      _handleSubs(socket, meta, e.data.slice(7));
      return;
    }
    // Resync request
    if (e.data === "__resync") {
      _handleResync(socket, meta);
      return;
    }

    // JSON action dispatch
    const parsed = JSON.parse(e.data);
    if (parsed.__op) {
      _handleSyncOp(parsed, meta, socket);
      return;
    }
    if (parsed.__sync) {
      _handleSyncMsg(parsed, meta, socket);
      return;
    }
    // serverFn call (perfect-aio B3): run the registered fn, reply w/ outcome.
    if (parsed.__sfn) {
      const { cid, ns, name, args } = parsed.__sfn as {
        cid: string;
        ns: string;
        name: string;
        args: unknown[];
      };
      if (
        typeof cid !== "string" || typeof ns !== "string" ||
        typeof name !== "string" || !Array.isArray(args)
      ) {
        log.warn("ws", "invalid __sfn envelope — dropping");
        return;
      }
      invokeServerFn(ns, name, args).then((result) => {
        try {
          socket.send(JSON.stringify({ __sfnr: { cid, ...result } }));
        } catch { /* client disconnected */ }
      });
      return;
    }
    if (!parsed || typeof parsed.type !== "string") {
      const msg = "ws: invalid action — missing type field";
      log.warn("ws", msg);
      return;
    }
    // Block framework-internal action types from network sources.
    // Internal actions (cell:__setX, cell:__exec, cell:__error, cell:__flow,
    // cell:__FlowState, cell:__Init, cell:__Destroy) carry trusted payload shapes
    // (e.g. mutation lists) that bypass cell method bodies. Accepting them from
    // clients is a remote-code-style vector — see audit F-1 (prototype pollution
    // via __setMethod with crafted mutation paths).
    if (_isFrameworkInternalActionType(parsed.type)) {
      const msg =
        `ws: rejected framework-internal action type "${parsed.type}" from client ${
          meta.id.slice(0, 8)
        }`;
      log.warn("ws", msg);
      return;
    }
    if (
      parsed.payload !== undefined &&
      (typeof parsed.payload !== "object" || parsed.payload === null ||
        Array.isArray(parsed.payload))
    ) {
      deps.debug(`ws: invalid action — payload must be a plain object`);
      return;
    }
    deps.debug(
      `ws: recv ${JSON.stringify(parsed)} user=${meta.user?.id ?? "anon"}`,
    );
    deps.dispatch(parsed, meta.user);
    // AIO-2.2: emit per-action ack if the client supplied a cid. Schedules a
    // microtask so the ack goes out AFTER any synchronous broadcast that the
    // dispatch triggered (broadcast itself uses queueMicrotask — by queuing
    // ours after dispatch returns, we run after the broadcast's send).
    if (typeof parsed.cid === "string" && parsed.cid.length > 0) {
      const cid = parsed.cid;
      queueMicrotask(() => {
        try {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(`__ack:${cid}:1`);
          }
        } catch { /* client gone */ }
      });
    }
  }

  function _resolvePending(
    meta: ClientMeta,
    kind: string,
    rawData: string,
  ): void {
    const key = `${meta.id}:${kind}`;
    const pending = pendingClientState.get(key);
    if (pending) {
      pendingClientState.delete(key);
      clearTimeout(pending.timer);
      try {
        pending.resolve(JSON.parse(rawData));
      } catch {
        pending.resolve(null);
      }
    }
  }

  function _handleTTCommand(data: string): void {
    deps.debug(`ws: tt command ${data}`);
    const body = data.slice(5);
    if (body.startsWith("goto:")) {
      const n = Number(body.slice(5));
      if (Number.isInteger(n) && n >= 0 && n < 1_000_000) {
        deps.onTTCommand?.("goto", n);
      }
    } else {
      deps.onTTCommand?.(body);
    }
  }

  function _handleVitalsPing(
    socket: WebSocket,
    _meta: ClientMeta,
    data: string,
  ): void {
    try {
      const ping = JSON.parse(data.slice(14));
      const vmeta = connections.get(socket);
      if (vmeta && deps.vitalsSystem) {
        deps.vitalsSystem.serverTransport.onClientPing(vmeta.id, ping.t1);
        const staleness = typeof ping.ms === "number" ? ping.ms : 0;
        const prevMul = vmeta.bpMultiplier;
        if (staleness > BP_STALENESS_HIGH) {
          vmeta.bpMultiplier = 4;
          vmeta.bpConsecutiveLow = 0;
        } else if (staleness > BP_STALENESS_MODERATE) {
          vmeta.bpMultiplier = 2;
          vmeta.bpConsecutiveLow = 0;
        } else {
          vmeta.bpConsecutiveLow++;
          if (
            vmeta.bpConsecutiveLow >= BP_RECOVERY_PINGS &&
            vmeta.bpMultiplier > 1
          ) {
            vmeta.bpMultiplier = Math.max(1, vmeta.bpMultiplier / 2);
            vmeta.bpConsecutiveLow = 0;
          }
        }
        if (vmeta.bpMultiplier !== prevMul) {
          const cid = vmeta.id.slice(0, 8);
          if (vmeta.bpMultiplier > prevMul) {
            log.warn(
              "vitals",
              `client ${cid} — staleness ${
                Math.round(staleness)
              }ms, backpressure ${prevMul}x→${vmeta.bpMultiplier}x`,
            );
          } else {
            log.warn(
              "vitals",
              `client ${cid} — recovered, backpressure ${prevMul}x→${vmeta.bpMultiplier}x`,
            );
          }
        }
        const pong = {
          t1: ping.t1,
          t2: Date.now(),
          loop: deps.vitalsSystem.getLoopVitalsForPong(),
        };
        socket.send("__vitals:pong:" + JSON.stringify(pong));
      }
    } catch (err) {
      log.warn("vitals", `bad ping: ${err}`);
    }
  }

  function _handleSubs(socket: WebSocket, meta: ClientMeta, raw: string): void {
    const subs = parseSubs(raw);
    if (subs === undefined) {
      log.warn("ws", "bad __subs message");
      return;
    }
    meta.subscriptions = subs;
    try {
      const msg = JSON.stringify(
        filterStateBySubs(deps.getUIState(meta.user), meta.subscriptions),
      );
      socket.send(msg);
      meta.lastFullJson = msg;
      meta.bpLastSentAt = Date.now();
    } catch (err) {
      log.warn("ws", `filtered state send error — ${err}`);
    }
  }

  function _handleResync(socket: WebSocket, meta: ClientMeta): void {
    deps.debug(`ws: client ${meta.id} requested resync`);
    try {
      const msg = JSON.stringify(
        filterStateBySubs(deps.getUIState(meta.user), meta.subscriptions),
      );
      socket.send(msg);
      meta.lastFullJson = msg;
      meta.bpLastSentAt = Date.now();
    } catch (err) {
      log.warn("ws", `resync send error — ${err}`);
    }
  }

  function _handleSyncOp(
    parsed: Record<string, unknown>,
    meta: ClientMeta,
    socket: WebSocket,
  ): void {
    if (!deps.syncHandler) {
      log.warn("ws", "__op received but no syncHandler configured — dropping");
      return;
    }
    const op = parsed.__op as Record<string, unknown>;
    if (
      !op || typeof op !== "object" || typeof op.id !== "string" ||
      typeof op.cell !== "string" || typeof op.action !== "string" ||
      !Array.isArray(op.hlc) ||
      ["__proto__", "constructor", "prototype"].includes(op.cell as string) ||
      // Validate op.action against banned keys AND framework-internal action
      // types — a malicious op.action like "cell:__setMethod" would bypass
      // the _isFrameworkInternalActionType gate at line 621 because the sync
      // path returns early here before reaching it. The sync handler routes
      // op.action to dispatch, so the same gate must apply.
      ["__proto__", "constructor", "prototype"].includes(op.action as string) ||
      _isFrameworkInternalActionType(op.action as string)
    ) {
      log.warn("ws", "invalid __op — malformed or forbidden fields");
      return;
    }
    deps.syncHandler.handleOp(op, { id: meta.id, user: meta.user }, socket);
  }

  function _handleSyncMsg(
    parsed: Record<string, unknown>,
    meta: ClientMeta,
    socket: WebSocket,
  ): void {
    if (!deps.syncHandler) {
      log.warn(
        "ws",
        "__sync received but no syncHandler configured — dropping",
      );
      return;
    }
    const sync = parsed.__sync as Record<string, unknown>;
    if (
      !sync || typeof sync !== "object" || typeof sync.clientId !== "string"
    ) {
      log.warn("ws", "invalid __sync — malformed");
      return;
    }
    deps.syncHandler.handleSync(sync, { id: meta.id, user: meta.user }, socket);
  }

  function sendToWsClient(
    idx: number,
    msg: string,
  ): { found: true; promise: Promise<Response> } | { found: false } {
    const wsEntry = [...connections.entries()].find(([, m]) => m.index === idx);
    if (!wsEntry) return { found: false };
    const [ws, m] = wsEntry;
    const _json = (data: unknown) =>
      new Response(JSON.stringify(data, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    const _err = (errMsg: string, status = 400) =>
      new Response(JSON.stringify({ error: errMsg }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (ws.readyState !== 1) {
      return {
        found: true,
        promise: Promise.resolve(_err(`client ${idx} not ready`, 503)),
      };
    }
    const pendingKey = `${m.id}:${reqKind(msg)}`;
    const statePromise = new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => {
        pendingClientState.delete(pendingKey);
        resolve({ error: "client did not respond within 5s" });
      }, 5000);
      if (pendingClientState.size >= PENDING_STATE_MAX) {
        const oldest = pendingClientState.keys().next().value!;
        const entry = pendingClientState.get(oldest)!;
        clearTimeout(entry.timer);
        entry.resolve({ error: "evicted — too many pending requests" });
        pendingClientState.delete(oldest);
      }
      const existing = pendingClientState.get(pendingKey);
      if (existing) {
        clearTimeout(existing.timer);
        existing.resolve({ error: "superseded by new request" });
      }
      pendingClientState.set(pendingKey, { resolve, timer });
    });
    try {
      ws.send(msg);
    } catch (e) {
      const entry = pendingClientState.get(pendingKey);
      if (entry) {
        clearTimeout(entry.timer);
        pendingClientState.delete(pendingKey);
      }
      return {
        found: true,
        promise: Promise.resolve(_err(`send failed: ${e}`, 503)),
      };
    }
    return { found: true, promise: statePromise.then((d) => _json(d)) };
  }

  function shutdown(): void {
    if (_globalRateTimer) {
      clearTimeout(_globalRateTimer);
      _globalRateTimer = undefined;
    }
    for (const [ws, meta] of connections) {
      _clearTimers(meta);
      try {
        ws.close(1001, "server shutting down");
      } catch { /* already closing */ }
    }
    connections.clear();
    for (const [, pending] of pendingClientState) clearTimeout(pending.timer);
    pendingClientState.clear();
  }

  return {
    handleWs,
    connections,
    payloadStats,
    pendingClientState,
    sendToWsClient,
    shutdown,
  };
}
