// WebSocket connection handler — extracted from server.ts
// Manages WS upgrades, per-client state, message routing, rate limiting, backpressure
import type { AioUser } from "./aio.ts";
import { invokeServerFn } from "./server-fns.ts";
import {
  _clearClientDegraded,
  _recordClientDegraded,
  type DegradedChange,
} from "../diagnostics/degraded.ts";
import {
  makeServerRequest,
  runWithRequest,
  runWithUser,
  type ServerRequest,
} from "./auth-context.ts";
import {
  type ActionPayload,
  dec,
  enc,
  encRaw,
  type SfnPayload,
} from "../protocol/envelope.ts";
import { filterStateBySubs, parseSubs } from "../protocol/broadcast-utils.ts";
import { serializeReturn } from "../protocol/return-value.ts";
import { writeClientLog } from "./client-log.ts";
import { log } from "../diagnostics/logger.ts";
import { parseTTCommand } from "../diagnostics/time-travel.ts";
import { rawStateControlAllowed } from "./server-auth.ts";
import type { ClientLogEntry } from "../air/dom-inspector-types.ts";
import type { VitalsSystem } from "../vitals/mod.ts";
import { VERSION } from "./aio-cli.ts";
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

/** Strip client-set trusted provenance off a network action, loudly, and
 *  re-stamp it as what it IS: client input. ONE decider for all three network
 *  entry points (WS, UDS, trojan — each calls this on every action).
 *
 *  The fields, and why a network value is never legitimate:
 *  - `_user` — the SERVER-side caller identity consumed by dispatch hooks
 *    (beforeReduce/onAction/onEffect). In open/shared-token mode meta.user is
 *    undefined, so a spoofed `_user:{role:"admin"}` would become the trusted
 *    identity. The server sets the real `_user` downstream.
 *  - `_source` — dispatch lets `_source:"Effect"` through a CLOSED queue while
 *    it drains in-flight effects (a streaming method's write-set must land)
 *    and drops everything else. A forged value would have a `cell:method`
 *    action run during shutdown drain — new work started while the server is
 *    closing — and its write captured by the final persist. The server tags
 *    its own effect dispatches inside the cell machinery.
 *  - `_syncOp` — only the sync handler sets it, on ops already persisted to
 *    the op-log, so afterAction skips the durability fold for sync cells. A
 *    forged value makes the server treat a write that is durable NOWHERE as
 *    durable — it silently vanishes on restart.
 *  - `payload._origin` — the async-batcher sets it SERVER-side to the
 *    originating method name; the cell `access` gate discriminates on it. A
 *    caller could forge `payload:{_origin:"read"}` on a `cell:delete` action
 *    to be gated as a read while the reducer ran the delete.
 *
 *  Re-stamping (not just deleting) `_source: "UI"` keeps provenance real for
 *  app hooks: clients tag their own dispatches `_source:"UI"` and deleting it
 *  outright would leave hooks unable to tell client input from server work.
 *  Anything OTHER than "UI" from the wire is warned about — a forged trusted
 *  field is an attack signal (or a badly stale client), never a shrug. */
export function sanitizeClientAction(
  action: Record<string, unknown>,
  via: "ws" | "uds" | "trojan",
): void {
  const forged: string[] = [];
  if (action._user !== undefined) forged.push("_user");
  if (action._source !== undefined && action._source !== "UI") {
    forged.push("_source");
  }
  if (action._syncOp !== undefined) forged.push("_syncOp");
  delete action._user;
  delete action._syncOp;
  const pl = action.payload;
  if (pl && typeof pl === "object") {
    if ((pl as Record<string, unknown>)._origin !== undefined) {
      forged.push("payload._origin");
      delete (pl as Record<string, unknown>)._origin;
    }
  }
  if (forged.length > 0) {
    log.warn(
      via,
      `client sent trusted field(s) ${forged.join(", ")} on ` +
        `'${String(action.type)}' — stripped (a network value is never ` +
        `legitimate here)`,
    );
  }
  action._source = "UI";
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
  /** The upgrade request's transport facts — what `serverRequest()` answers for
   *  every action / serverFn frame arriving on this socket. */
  request?: ServerRequest;
  /** Negotiated wire-protocol version (A3). Undefined until the client's
   *  "proto" hello arrives. */
  protocolVersion?: number;
  /** The SESSION token this socket authenticated with, when it authenticated
   *  with one. A socket outlives the credential that opened it, so the token
   *  is kept and re-checked — see `_revalidate`. Absent for anonymous sockets
   *  and for static `users:`/`resolveUser` tokens, which nothing can revoke. */
  sessionToken?: string;
};

/** Dependencies injected from server.ts closure */
export interface WsDeps {
  /** Cost meter — sees every frame handed to a socket (`am cost`). */
  costMeter?: import("../vitals/cost-meter.ts").CostMeter;
  dispatch: (event: unknown, user?: AioUser) => Promise<unknown> | void;
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
  /** Resolved client config — sent as an early "cfg" frame so a shell
   *  templated at build time (electron UDS, android assets) still learns the
   *  compose-time decisions (`syncCells`, `callTimeouts`, `renderBudget`). */
  clientConfig?: Record<string, unknown>;
  vitalsSystem?: VitalsSystem;
  onConnect?: (user?: AioUser) => void;
  onDisconnect?: (user?: AioUser) => void;
  onTTCommand?: (cmd: string, arg?: number) => void;
  /** True when this server authenticates INDIVIDUALS (sessions / `users:` /
   *  `resolveUser` / login flows). It is the context `rawStateControlAllowed`
   *  needs: in public mode there is no identity to check and the dev panel is
   *  the point; in per-user mode a `tt-cmd` frame is raw-state control and
   *  answers to the admin bar. */
  perUserAuth?: boolean;
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
  /** Re-resolve a session token → its CURRENT user, or null when it is gone
   *  (revoked, kicked, password-rotated, expired). Supplied whenever a session
   *  store exists. See `_revalidate` for why a socket must ask again. */
  revalidateSession?: (token: string) => AioUser | null;
}

/** Returned by createWsManager — the WS subsystem's public API */
export interface WsManager {
  handleWs: (
    req: Request,
    user?: AioUser,
    clientKey?: string,
    sessionToken?: string,
  ) => Response;
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
  /** Re-check every socket's session NOW (a session was revoked out of band).
   *  Same decider as the periodic sweep — this only removes the latency. */
  sweepSessions: () => void;
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

  // ── Session revocation reaches live sockets ────────────────────────────────
  // `meta.user` used to be resolved ONCE, at upgrade, and never again: logging
  // out (or kicking a user, or rotating a password, or the session simply
  // expiring) killed the token for HTTP while the already-open socket kept
  // dispatching as that identity and kept receiving its `forUser` state — for
  // as long as it stayed connected. `sessions.ts` promises tokens are
  // "revocable at any time (logout, kick, breach response)"; a control that
  // only half-applies is not a control.
  //
  // CLOSING is the fix, not per-action filtering: the socket also RECEIVES
  // that identity's state, so leaving it open but ignoring its frames still
  // leaks. We learn about revocation by ASKING the store rather than by a
  // callback threaded through the boot path, because the same question also
  // answers TTL expiry and out-of-band edits — one decider covering every way
  // a session can die, instead of one per revocation call site.
  //
  // Two triggers, same decider: every inbound frame (immediate — a revoked
  // socket cannot act even once) and a sweep (idle sockets stop receiving).
  const SESSION_SWEEP_MS = 5_000;
  let _sessionSweep: ReturnType<typeof setInterval> | undefined;

  /** True when the socket may keep going. Closes + reaps it when its session
   *  is gone. Sockets without a session token (anonymous, static `users:`
   *  tokens, shared key) are never in question — nothing can revoke those. */
  function _revalidate(socket: WebSocket, meta: ClientMeta): boolean {
    if (!meta.sessionToken || !deps.revalidateSession) return true;
    const fresh = deps.revalidateSession(meta.sessionToken);
    if (fresh) {
      meta.user = fresh; // a role change lands here too, not just revocation
      return true;
    }
    deps.debug(
      `ws: closing ${meta.id.slice(0, 8)} — session revoked or expired (user=${
        meta.user?.id ?? "anon"
      })`,
    );
    meta.sessionToken = undefined; // one close, not one per frame
    try {
      socket.close(1008, "session revoked");
    } catch { /* already closing */ }
    connections.delete(socket);
    _clearTimers(meta);
    return false;
  }

  function sweepSessions(): void {
    let live = 0;
    for (const [socket, meta] of connections) {
      if (_revalidate(socket, meta) && meta.sessionToken) live++;
    }
    // Nothing left to watch — stop polling until the next session socket
    // arrives (`handleWs` restarts it). A timer that outlives its reason is
    // how "cheap" becomes "always on".
    if (live === 0 && _sessionSweep) {
      clearInterval(_sessionSweep);
      _sessionSweep = undefined;
    }
  }

  function _startSessionSweep(): void {
    if (_sessionSweep || !deps.revalidateSession) return;
    _sessionSweep = setInterval(sweepSessions, SESSION_SWEEP_MS);
    // Never a reason to keep the process alive on its own.
    Deno.unrefTimer?.(_sessionSweep as unknown as number);
  }

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

  // Derive request kind from the outgoing command envelope for the dedup key
  const reqKind = (msg: string) => {
    const t = dec(msg)?.t;
    return t === "ui-surface"
      ? "surface"
      : t === "ui-trigger"
      ? "trigger"
      : "clientState";
  };

  function handleWs(
    req: Request,
    user?: AioUser,
    clientKey?: string,
    sessionToken?: string,
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
        const allowed = deps.allowedOrigins ?? [];
        // Configured trust, by hostname or by full origin, plus the "*" opt-out.
        const isAllowed = allowed.includes(h) || allowed.includes(origin) ||
          allowed.includes("*");
        // a page this very server served has Origin === our Host header
        const hostHeader = req.headers.get("host");
        const isOwnHost = hostHeader !== null && u.host === hostHeader;
        // A SUBMITTED origin cannot certify itself. This used to exempt ANY
        // loopback hostname — so `Origin: http://localhost:1234` walked past
        // the gate unconditionally, under `--expose` included. A port is not
        // part of a "site", so `SameSite=Strict` sends the session cookie to
        // every loopback port: any other local dev server or tool UI could
        // open an authenticated socket as the victim and dispatch (CSWSH).
        // The app's own page is covered by `isOwnHost` (the client builds the
        // WS URL from `location.host`); anything else is a deliberate
        // `allowedOrigins` entry.
        if (!isAllowed && !isOwnHost) {
          deps.debug(
            `ws: rejected origin ${origin} — not this server's own origin ` +
              `(${hostHeader ?? "no Host header"}); add it to allowedOrigins ` +
              `if it is meant to connect`,
          );
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
    // Same reason: snapshot the request for serverRequest() BEFORE the upgrade
    // consumes it. Every frame on this socket carries the connection's facts.
    const request = makeServerRequest(req, clientKey, "ws");
    const { socket, response } = Deno.upgradeWebSocket(req);
    const clientId = crypto.randomUUID();
    // Meter the SOCKET, not the callers. Frames reach a client from several
    // places — the broadcaster, the handshake's first state, per-action acks,
    // diagnostics — and instrumenting each one guarantees the count drifts the
    // day a new sender is added. `am cost` promises "the bytes that crossed the
    // wire", and a correctness test holds it to a real client's own count
    // (tests/cost-wire-accuracy.test.ts), so the measurement belongs at the one
    // place every frame passes through.
    if (deps.costMeter) {
      const meter = deps.costMeter;
      const rawSend = socket.send.bind(socket);
      socket.send = (
        data: string | ArrayBufferLike | Blob | ArrayBufferView,
      ) => {
        try {
          const bytes = typeof data === "string"
            ? new TextEncoder().encode(data).byteLength
            : ((data as ArrayBufferView).byteLength ?? 0);
          // Read the envelope's kind EXACTLY — `{"v":2,"t":"<kind>",…}` — never
          // by substring: a patch payload can contain the literal `"t":"state"`
          // in its own data. And acks / diagnostics / time-travel frames are
          // `other`, not full resends: counting a wall of 40-byte acks as
          // "the whole state went out" is a plausible headline that is wrong,
          // and this feature was accepted on the condition that it never
          // produces one.
          const text = typeof data === "string" ? data : "";
          const envKind = /^\{"v":\d+,"t":"([^"]+)"/.exec(text)?.[1];
          const kind: "patch" | "full" | "other" = envKind === "patches"
            ? "patch"
            : envKind === "state"
            ? "full"
            : "other";
          meter.recordSend(bytes, clientId, kind);
        } catch { /* metering must never break a send */ }
        // The wrapper's parameter type is the DOM union (which includes
        // SharedArrayBuffer); the underlying send accepts the narrower one.
        // Nothing is transformed — the exact value goes through.
        (rawSend as (d: unknown) => void)(data);
      };
    }
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
      request,
      sessionToken,
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
      if (sessionToken) _startSessionSweep();
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
        socket.send(enc("proto", protoHello(VERSION)));
      } catch { /* socket closing during onopen (AIO-155) */ }
      try {
        const uiState = deps.getUIState(meta.user);
        const msg = JSON.stringify(uiState);
        socket.send(encRaw("state", msg));
        meta.lastFullJson = msg;
      } catch (e) {
        deps.debug(`ws: getUIState error on connect — ${e}`);
      }
      if (deps.getTTBroadcast) {
        try {
          socket.send(enc("tt-state", deps.getTTBroadcast()));
        } catch (e) {
          deps.debug(`ws: getTTBroadcast error on connect — ${e}`);
        }
      }
      try {
        socket.send(enc("boot", { id: deps.bootId }));
      } catch { /* socket closing during onopen (AIO-155) */ }
      if (deps.clientConfig && Object.keys(deps.clientConfig).length > 0) {
        try {
          socket.send(enc("cfg", deps.clientConfig));
        } catch { /* socket closing */ }
      }
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
      // A gone client's degradations are no longer live signal for health.
      _clearClientDegraded(meta.id);
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
    // Before ANYTHING else: a socket whose session died acts zero more times.
    if (!_revalidate(socket, meta)) return;

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

    // v2 envelope demux (B4b): every frame is {v:2, t, d} — one decode,
    // one switch. A legacy v1 hello (`__proto:{...}`) is answered with the
    // v1 `__proto-err:` string + 4505 so the old peer can read WHY.
    if (e.data.startsWith("__proto:")) {
      const msg = `ws: v1 client ${
        meta.id.slice(0, 8)
      } refused — this server speaks wire protocol v2+ (rebuild the client)`;
      log.error("ws", msg);
      try {
        socket.send(
          "__proto-err:this server speaks wire protocol v2+ — rebuild/update the client",
        );
        socket.close(PROTOCOL_MISMATCH_CLOSE_CODE, "protocol mismatch");
      } catch { /* already closed */ }
      return;
    }
    const frame = dec(e.data);
    if (!frame) {
      log.warn(
        "ws",
        `ws: undecodable frame from ${meta.id.slice(0, 8)} — dropped`,
      );
      return;
    }
    switch (frame.t) {
      case "client-state":
        _resolvePending(meta, "clientState", frame.d);
        return;
      case "log":
        if (!deps.prod) {
          try {
            writeClientLog(meta.index, frame.d as ClientLogEntry);
          } catch { /* malformed */ }
        }
        return;
      case "cdiag": {
        // A client's degraded() escalation — recorded so /__aio/health can
        // name a browser subsystem that is failing forever. Values are capped
        // inside _recordClientDegraded; malformed frames are dropped.
        const d = frame.d as DegradedChange | undefined;
        if (
          d && typeof d.name === "string" && d.name.length > 0 &&
          (d.kind === "down" || d.kind === "up")
        ) {
          _recordClientDegraded(meta.id, {
            name: d.name,
            kind: d.kind,
            failures: typeof d.failures === "number" ? d.failures : 0,
            since: typeof d.since === "number" ? d.since : Date.now(),
            lastError: typeof d.lastError === "string" ? d.lastError : "",
          });
        }
        return;
      }
      case "ui-surface-result":
        _resolvePending(meta, "surface", frame.d);
        return;
      case "ui-trigger-result":
        _resolvePending(meta, "trigger", frame.d);
        return;
      case "type": {
        const t = (frame.d as { kind?: string } | undefined)?.kind;
        if (t === "electron" || t === "browser") meta.clientType = t;
        return;
      }
      case "proto": {
        const theirs = parseProtoHello(frame.d);
        if (!theirs) {
          deps.debug(
            `ws: malformed proto hello from ${meta.id.slice(0, 8)} — ignored`,
          );
          return;
        }
        const result = negotiateProtocol(protoHello(VERSION), theirs);
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
      case "tt-cmd":
        if (deps.onTTCommand) {
          // Raw-state control, on a socket. Same admin bar as /__aio/snapshot
          // and /__aio/trojan/* — see rawStateControlAllowed.
          if (deps.perUserAuth && !rawStateControlAllowed(meta.user)) {
            log.warn(
              "ws",
              `time-travel command '${
                (frame.d as { cmd?: string } | undefined)?.cmd ?? ""
              }' denied for ${
                meta.user
                  ? `user=${meta.user.id} role=${meta.user.role}`
                  : "anonymous client"
              } — it rewinds/freezes state for EVERY client and requires ` +
                `role "admin"`,
            );
            return;
          }
          _handleTTCommand(
            (frame.d as { cmd?: string } | undefined)?.cmd ?? "",
          );
        }
        return;
      case "vitals-ping":
        _handleVitalsPing(socket, meta, frame.d);
        return;
      case "subs":
        _handleSubs(socket, meta, (frame.d as { subs?: unknown })?.subs);
        return;
      case "resync":
        _handleResync(socket, meta);
        return;
      case "op":
        _handleSyncOp(frame.d as Record<string, unknown>, meta, socket);
        return;
      case "sync-req":
        _handleSyncMsg(frame.d as Record<string, unknown>, meta, socket);
        return;
      case "sfn": {
        const { cid, ns, name, args } = (frame.d ?? {}) as SfnPayload;
        if (
          typeof cid !== "string" || typeof ns !== "string" ||
          typeof name !== "string" || !Array.isArray(args)
        ) {
          log.warn("ws", "invalid sfn frame — dropping");
          return;
        }
        // Ambient identity + transport: the fn body (and everything it awaits)
        // can ask serverUser() who is calling and serverRequest() from where;
        // access rules check meta.user directly.
        runWithRequest(
          meta.request,
          () =>
            runWithUser(
              meta.user,
              () => invokeServerFn(ns, name, args, meta.user),
            ),
        )
          .then((result) => {
            try {
              socket.send(enc("sfnr", { cid, ...result }));
            } catch { /* client disconnected */ }
          })
          // No .catch here meant a rejecting serverFn (or a throwing access
          // predicate) surfaced as an unhandled rejection — process death.
          .catch((e) => {
            log.error("ws", `sfn ${ns}.${name} failed — ${e}`);
            try {
              socket.send(enc("sfnr", { cid, ok: false, error: String(e) }));
            } catch { /* client disconnected */ }
          });
        return;
      }
      case "action":
        break; // falls through to the dispatch path below
      default:
        // S→C-only kinds arriving C→S, or future kinds — loud, never silent.
        log.warn(
          "ws",
          `ws: unexpected "${frame.t}" frame from client ${
            meta.id.slice(0, 8)
          } — dropped`,
        );
        return;
    }

    const parsed = (frame.d ?? {}) as ActionPayload;
    if (!parsed || typeof parsed.type !== "string") {
      const msg = "ws: invalid action — missing type field";
      log.warn("ws", msg);
      return;
    }
    // Block framework-internal action types from network sources.
    // Internal actions (cell:__setX, cell:__exec, cell:__error,
    // cell:__Init, cell:__Destroy) carry trusted payload shapes
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
    // Strip client-set trusted provenance and re-stamp `_source:"UI"` — ONE
    // decider for all three network entry points (sanitizeClientAction).
    sanitizeClientAction(parsed as Record<string, unknown>, "ws");
    deps.debug(
      `ws: recv ${JSON.stringify(parsed)} user=${meta.user?.id ?? "anon"}`,
    );
    // The cell method (and everything it awaits) sees this socket's transport
    // facts via serverRequest(); dispatch itself wraps runWithUser downstream.
    const result = runWithRequest(
      meta.request,
      () => deps.dispatch(parsed, meta.user),
    );
    // AIO-2.2 + return-value transport: emit a per-action ack carrying the
    // method's RETURN value if the client supplied a cid. We settle only AFTER
    // the dispatch promise resolves — for an async method that's on completion,
    // for a sync/void method that's the next microtask (after any synchronous
    // broadcast the dispatch triggered, so ordering is preserved).
    if (typeof parsed.cid === "string" && parsed.cid.length > 0) {
      const cid = parsed.cid;
      const actionType = typeof parsed.type === "string" ? parsed.type : "?";
      Promise.resolve(result).then(
        (value) => _sendAck(socket, cid, actionType, value),
        (err) => _sendAckErr(socket, cid, err),
      );
    }
  }

  /** Send a success ack carrying the (JSON-vetted) return value. */
  function _sendAck(
    socket: WebSocket,
    cid: string,
    actionType: string,
    value: unknown,
  ): void {
    // Pass the method name so a lossy-conversion warning names it (the UDS
    // path already did) — "a method" is not a diagnosis.
    const { value: safe, dropped } = serializeReturn(value, actionType);
    if (dropped && !deps.prod) {
      console.warn(
        `[aio] method "${actionType}" returned a non-serializable value — ` +
          `the caller resolves with undefined. Return JSON-safe data ` +
          `(plain objects/arrays/primitives) to transport a value.`,
      );
    }
    try {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(enc("ack", { cid, ok: true, value: safe }));
      }
    } catch { /* client gone */ }
  }

  /** Send a failure ack — the awaited method rejected server-side. */
  function _sendAckErr(socket: WebSocket, cid: string, err: unknown): void {
    try {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(enc("ack", { cid, ok: false, error: String(err) }));
      }
    } catch { /* client gone */ }
  }

  function _resolvePending(
    meta: ClientMeta,
    kind: string,
    data: unknown,
  ): void {
    const key = `${meta.id}:${kind}`;
    const pending = pendingClientState.get(key);
    if (pending) {
      pendingClientState.delete(key);
      clearTimeout(pending.timer);
      try {
        pending.resolve(data);
      } catch {
        pending.resolve(null);
      }
    }
  }

  function _handleTTCommand(body: string): void {
    deps.debug(`ws: tt command ${body}`);
    const c = parseTTCommand(body);
    if (c) deps.onTTCommand?.(c.cmd, c.cmd === "goto" ? c.arg : undefined);
  }

  function _handleVitalsPing(
    socket: WebSocket,
    _meta: ClientMeta,
    data: unknown,
  ): void {
    try {
      const ping = data as { t1: number; ms?: number };
      if (!ping || typeof ping.t1 !== "number") throw new Error("malformed");
      const vmeta = connections.get(socket);
      if (vmeta && deps.vitalsSystem) {
        // Liveness is stamped by the probe from the SERVER's clock. `ping.t1`
        // is the browser's `Date.now()` and is echoed back in the pong for the
        // client to compute its own RTT — it is never used as a server-side
        // timestamp (see the one-clock invariant in transport-probe.ts).
        deps.vitalsSystem.serverTransport.onClientPing(vmeta.id);
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
        socket.send(enc("vitals-pong", pong));
      }
    } catch (err) {
      log.warn("vitals", `bad ping: ${err}`);
    }
  }

  function _handleSubs(
    socket: WebSocket,
    meta: ClientMeta,
    rawSubs: unknown,
  ): void {
    const subs = parseSubs(rawSubs);
    if (subs === undefined) {
      log.warn("ws", "bad subs frame");
      return;
    }
    meta.subscriptions = subs;
    try {
      const msg = JSON.stringify(
        filterStateBySubs(deps.getUIState(meta.user), meta.subscriptions),
      );
      socket.send(encRaw("state", msg));
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
      socket.send(encRaw("state", msg));
      meta.lastFullJson = msg;
      meta.bpLastSentAt = Date.now();
    } catch (err) {
      log.warn("ws", `resync send error — ${err}`);
    }
  }

  function _handleSyncOp(
    op: Record<string, unknown>,
    meta: ClientMeta,
    socket: WebSocket,
  ): void {
    if (!deps.syncHandler) {
      log.warn("ws", "op received but no syncHandler configured — dropping");
      return;
    }
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
      log.warn("ws", "invalid op — malformed or forbidden fields");
      return;
    }
    deps.syncHandler.handleOp(op, { id: meta.id, user: meta.user }, socket);
  }

  function _handleSyncMsg(
    sync: Record<string, unknown>,
    meta: ClientMeta,
    socket: WebSocket,
  ): void {
    if (!deps.syncHandler) {
      log.warn(
        "ws",
        "sync-req received but no syncHandler configured — dropping",
      );
      return;
    }
    if (
      !sync || typeof sync !== "object" || typeof sync.clientId !== "string"
    ) {
      log.warn("ws", "invalid sync-req — malformed");
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
    if (_sessionSweep) {
      clearInterval(_sessionSweep);
      _sessionSweep = undefined;
    }
    for (const [ws, meta] of connections) {
      _clearTimers(meta);
      try {
        ws.close(1001, "server shutting down");
      } catch { /* already closing */ }
    }
    connections.clear();
    // SETTLE, don't just drop: each entry owns an unresolved promise that a
    // caller (the trojan client-state route) is awaiting. Clearing the timer
    // and deleting the entry left that promise pending forever, so a shutdown
    // racing an in-flight request never completed — every timeout path was
    // gone with the timer.
    for (const [, pending] of pendingClientState) {
      clearTimeout(pending.timer);
      pending.resolve({ error: "server shutting down" });
    }
    pendingClientState.clear();
  }

  return {
    handleWs,
    connections,
    payloadStats,
    pendingClientState,
    sendToWsClient,
    sweepSessions,
    shutdown,
  };
}
