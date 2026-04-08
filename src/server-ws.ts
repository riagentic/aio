// WebSocket connection handler — extracted from server.ts
// Manages WS upgrades, per-client state, message routing, rate limiting, backpressure
import type { AioUser } from "./aio.ts";
import { filterStateBySubs, parseSubs } from "./broadcast-utils.ts";
import { writeClientLog } from "./client-log.ts";
import type { ClientLogEntry } from "./dom-inspector-types.ts";
import type { VitalsSystem } from "./vitals/mod.ts";

/** Safety limits — prevent resource exhaustion */
const WS_MAX_MESSAGE = 1_000_000; // 1MB — reject oversized WS messages
const WS_MAX_CONNECTIONS = 100; // max concurrent WebSocket clients
const WS_RATE_LIMIT = 100; // max messages per second per client
const WS_BYTES_PER_SEC = 5_000_000; // 5MB/s per client — prevents bandwidth DoS

/** Backpressure thresholds */
const BP_STALENESS_HIGH = 300; // ms — client render staleness triggering 4x throttle
const BP_STALENESS_MODERATE = 100; // ms — 2x throttle
const BP_RECOVERY_PINGS = 3; // consecutive low-staleness pings before stepping down

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
  subscriptions: Set<string> | null;
  disconnected: boolean;
};

/** Dependencies injected from server.ts closure */
export interface WsDeps {
  dispatch: (event: unknown, user?: AioUser) => void;
  getUIState: (user?: AioUser) => unknown;
  debug: (msg: string) => void;
  prod: boolean;
  maxConnections?: number;
  expose?: boolean;
  allowedOrigins?: string[];
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
  handleWs: (req: Request, user?: AioUser) => Response;
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

  // Derive request kind from WS command message for deduplication key
  const reqKind = (msg: string) =>
    msg.startsWith("__ui:snapshot")
      ? "snapshot"
      : msg.startsWith("__ui:interact")
      ? "interact"
      : "clientState";

  function handleWs(req: Request, user?: AioUser): Response {
    if (!deps.expose || deps.allowedOrigins?.length) {
      const origin = req.headers.get("origin");
      if (origin) {
        try {
          const u = new URL(origin);
          const h = u.hostname;
          const isLocal = h === "localhost" || h === "127.0.0.1" ||
            h === "::1" || h === "[::1]";
          const isAllowed = deps.allowedOrigins?.includes(h) ?? false;
          if (!isLocal && !isAllowed) {
            deps.debug(`ws: rejected origin ${origin}`);
            return new Response("Forbidden", { status: 403 });
          }
        } catch {
          return new Response("Bad Request", { status: 400 });
        }
      }
    }

    const maxConn = deps.maxConnections ?? WS_MAX_CONNECTIONS;
    if (connections.size >= maxConn) {
      deps.debug(`ws: rejected — max connections (${maxConn})`);
      return new Response("Too Many Connections", { status: 503 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    const clientId = crypto.randomUUID();
    const clientIndex = nextIndex();
    const isElectron = /electron/i.test(req?.headers.get("user-agent") ?? "");
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
    };

    socket.onerror = (e) => {
      deps.debug(
        `ws: error ${clientId.slice(0, 8)} — ${
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
          deps.debug(`hook onDisconnect: ${err}`);
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
          deps.debug(`hook onDisconnect: ${e}`);
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
    meta.msgCount++;
    if (!meta.msgResetTimer) {
      meta.msgResetTimer = setTimeout(() => {
        meta.msgCount = 0;
        meta.bytesThisSec = 0;
        meta.msgResetTimer = undefined;
      }, 1000);
    }
    if (meta.msgCount > WS_RATE_LIMIT) {
      deps.debug(
        `ws: rate limit exceeded for ${
          meta.id.slice(0, 8)
        } (${meta.msgCount}/s)`,
      );
      return;
    }
    if (typeof e.data !== "string") {
      deps.debug(`ws: binary message dropped — only JSON strings accepted`);
      return;
    }
    if (e.data.length > WS_MAX_MESSAGE) {
      deps.debug(`ws: message too large (${e.data.length} bytes), dropped`);
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
    if (meta.bytesThisSec > WS_BYTES_PER_SEC) {
      deps.debug(
        `ws: byte rate exceeded for ${meta.id.slice(0, 8)} (${
          (meta.bytesThisSec / 1_000_000).toFixed(1)
        }MB/s)`,
      );
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
    // UI snapshot result
    if (e.data.startsWith("__ui:snapshot-result:")) {
      _resolvePending(
        meta,
        "snapshot",
        e.data.slice("__ui:snapshot-result:".length),
      );
      return;
    }
    // UI interact result
    if (e.data.startsWith("__ui:interact-result:")) {
      _resolvePending(
        meta,
        "interact",
        e.data.slice("__ui:interact-result:".length),
      );
      return;
    }
    // Client type identification
    if (e.data.startsWith("__type:")) {
      const t = e.data.slice(7);
      if (t === "electron" || t === "browser") meta.clientType = t;
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
    if (!parsed || typeof parsed.type !== "string") {
      deps.debug(`ws: invalid action — missing type field`);
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
        deps.onTTCommand!("goto", n);
      }
    } else {
      deps.onTTCommand!(body);
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
            console.warn(
              `[aio:vitals] client ${cid} — staleness ${
                Math.round(staleness)
              }ms, backpressure ${prevMul}x→${vmeta.bpMultiplier}x`,
            );
          } else {
            console.warn(
              `[aio:vitals] client ${cid} — recovered, backpressure ${prevMul}x→${vmeta.bpMultiplier}x`,
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
      deps.debug(`[vitals] bad ping: ${err}`);
    }
  }

  function _handleSubs(socket: WebSocket, meta: ClientMeta, raw: string): void {
    const subs = parseSubs(raw);
    if (subs === undefined) {
      deps.debug("ws: bad __subs message");
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
      deps.debug(`ws: filtered state send error — ${err}`);
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
      deps.debug(`ws: resync send error — ${err}`);
    }
  }

  function _handleSyncOp(
    parsed: Record<string, unknown>,
    meta: ClientMeta,
    socket: WebSocket,
  ): void {
    if (!deps.syncHandler) {
      deps.debug(`ws: __op received but no syncHandler configured — dropping`);
      return;
    }
    const op = parsed.__op as Record<string, unknown>;
    if (
      !op || typeof op !== "object" || typeof op.id !== "string" ||
      typeof op.cell !== "string" || typeof op.action !== "string" ||
      !Array.isArray(op.hlc) ||
      ["__proto__", "constructor", "prototype"].includes(op.cell as string)
    ) {
      deps.debug(`ws: invalid __op — malformed or forbidden fields`);
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
      deps.debug(
        `ws: __sync received but no syncHandler configured — dropping`,
      );
      return;
    }
    const sync = parsed.__sync as Record<string, unknown>;
    if (
      !sync || typeof sync !== "object" || typeof sync.clientId !== "string"
    ) {
      deps.debug(`ws: invalid __sync — malformed`);
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
