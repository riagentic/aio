// Trojan admin API — extracted from server.ts serveStatic()
// Control REST API at /__aio/trojan/* (localhost-only, CSRF-protected, rate-limited)
import type { AioUser } from "./aio.ts";
import { _isFrameworkInternalActionType } from "./server-ws.ts";

/** Client info visible to trojan introspection endpoints */
export interface TrojanClientInfo {
  index: number;
  id: string;
  clientType: string;
  user?: string;
  readyState: number;
}

/** Pending client state request — resolve when client responds */
type PendingEntry = {
  resolve: (v: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Dependencies injected by server.ts — keeps trojan module decoupled */
export interface TrojanDeps {
  dispatch: (event: unknown, user?: AioUser) => void;
  getUIState: (user?: AioUser) => unknown;
  debug: (msg: string) => void;
  prod: boolean;
  port: number;
  title: string;
  /** Trojan capabilities from ServerConfig.trojan */
  trojan: {
    getState: () => unknown;
    getSchedules: () => string[];
    getTTHistory?: () => unknown;
    forcePersist?: () => void;
    sqlQuery?: (sql: string) => Promise<unknown[]>;
    shutdown?: () => Promise<void>;
    startedAt: number;
    udsClients?: () => { index: number; id: string }[];
    requestUdsClientState?: (index: number, msg?: string) => Promise<unknown>;
  };
  /** Auth mode info for config endpoint */
  authInfo: { mode: string; expose: boolean };
  /** Snapshot support */
  loadSnapshot?: (json: string) => void;
  /** Time-travel command handler */
  onTTCommand?: (cmd: string, arg?: number) => void;
  /** List connected WS clients (read-only view) */
  getWsClients: () => Array<{ ws: WebSocket; meta: TrojanClientInfo }>;
  /** Find WS client by index and send message, returning response promise */
  sendToWsClient: (
    idx: number,
    msg: string,
  ) => { found: true; promise: Promise<Response> } | { found: false };
  /** Recent transpile errors (dev mode) */
  getRecentErrors: () => unknown[];
  /** Find user by ID (trojan ui endpoint) — returns AioUser from users map, or undefined */
  findUserById?: (id: string) => AioUser | undefined;
}

const TROJAN_RATE_LIMIT = 100;
const SNAPSHOT_MAX_SIZE = 10_000_000;
/** Auto-LIMIT applied to trojan SELECTs that don't set their own — bounds
 *  result size and SQLite worker time. Audit F-9. */
const TROJAN_SQL_DEFAULT_LIMIT = 10_000;
/** Hard cap on serialized result bytes to prevent OOM from a wide SELECT
 *  (e.g. millions of small rows still under DEFAULT_LIMIT). Audit F-9. */
const TROJAN_SQL_MAX_RESULT_BYTES = 10_000_000;
let _trojanReqCount = 0;
let _trojanResetTimer: ReturnType<typeof setTimeout> | null = null;

/** Reset rate limit state — called during server shutdown */
export function resetTrojanRateLimit(): void {
  if (_trojanResetTimer) {
    clearTimeout(_trojanResetTimer);
    _trojanResetTimer = null;
  }
  _trojanReqCount = 0;
}

/** Main trojan route handler — returns Response or null if path not matched */
export function handleTrojan(
  pathname: string,
  req: Request | undefined,
  deps: TrojanDeps,
): Response | Promise<Response> | null {
  if (!pathname.startsWith("/__aio/trojan/")) return null;

  const route = pathname.slice("/__aio/trojan/".length);
  const method = req?.method ?? "GET";

  const json = (data: unknown) =>
    new Response(JSON.stringify(data, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  const err = (msg: string, status = 400) =>
    new Response(JSON.stringify({ error: msg }), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  // Rate limiting — 100 requests/sec across all trojan endpoints
  _trojanReqCount++;
  if (!_trojanResetTimer) {
    _trojanResetTimer = setTimeout(() => {
      _trojanReqCount = 0;
      _trojanResetTimer = null;
    }, 1000);
  }
  if (_trojanReqCount > TROJAN_RATE_LIMIT) {
    return err("rate limit exceeded", 429);
  }

  const { trojan } = deps;

  // Helper: send message to client (WS or UDS) and await response
  const sendToClient = async (idx: number, msg: string): Promise<Response> => {
    const wsResult = deps.sendToWsClient(idx, msg);
    if (wsResult.found) return wsResult.promise;
    if (trojan.requestUdsClientState) {
      return json(await trojan.requestUdsClientState(idx, msg));
    }
    return err(`client ${idx} not connected`, 404);
  };

  // GET endpoints — inspect
  if (method === "GET") {
    return handleGet(route, req, deps, json, err, sendToClient);
  }

  // POST endpoints — control (CSRF protected)
  if (method === "POST" && req) {
    return handlePost(route, req, deps, json, err, sendToClient);
  }

  return err("not found", 404);
}

// ── GET routes ──

function handleGet(
  route: string,
  req: Request | undefined,
  deps: TrojanDeps,
  json: (d: unknown) => Response,
  err: (m: string, s?: number) => Response,
  sendToClient: (idx: number, msg: string) => Promise<Response>,
): Response | Promise<Response> {
  const { trojan, prod } = deps;

  if (route === "state") return json(trojan.getState());

  if (route === "ui") {
    const userId = new URL(req!.url).searchParams.get("user") ?? undefined;
    let aioUser: AioUser | undefined;
    if (userId && deps.findUserById) {
      aioUser = deps.findUserById(userId);
    } else if (userId) {
      // resolveUser or no-auth mode: construct synthetic AioUser for trojan inspection
      aioUser = { id: userId, role: "unknown" };
    }
    return json(deps.getUIState(aioUser));
  }

  if (route === "clients") {
    const wsClients = deps.getWsClients().map((c) => ({
      index: c.meta.index,
      id: c.meta.id,
      type: c.meta.clientType,
      transport: "ws" as const,
      user: c.meta.user,
      readyState: c.ws.readyState,
    }));
    const udsClients = (trojan.udsClients?.() ?? []).map((c) => ({
      index: c.index,
      id: c.id,
      type: "electron" as const,
      transport: "uds" as const,
    }));
    return json([...wsClients, ...udsClients]);
  }

  if (route.startsWith("client/") && !prod) {
    const idx = Number(route.slice(7));
    if (!Number.isInteger(idx) || idx < 0) {
      return err("invalid client index", 400);
    }
    return sendToClient(idx, "__getState");
  }

  if (route.startsWith("click/") && !prod) {
    const rest = route.slice(6);
    const slashIdx = rest.indexOf("/");
    if (slashIdx === -1) {
      return err(
        "usage: click/<clientIndex>/<Component>:<index|prop:value>",
        400,
      );
    }
    const idx = Number(rest.slice(0, slashIdx));
    let target: string;
    try {
      target = decodeURIComponent(rest.slice(slashIdx + 1));
    } catch {
      target = rest.slice(slashIdx + 1);
    }
    if (!Number.isInteger(idx) || idx < 0) {
      return err("invalid client index", 400);
    }
    return sendToClient(idx, "__click:" + target);
  }

  if (route.startsWith("dom/") && !prod) {
    const rest = route.slice(4);
    const qIdx = rest.indexOf("?");
    const idxStr = qIdx >= 0 ? rest.slice(0, qIdx) : rest;
    const idx = Number(idxStr);
    if (!Number.isInteger(idx) || idx < 0) {
      return err("invalid client index", 400);
    }
    const url = new URL(req!.url);
    const all = url.searchParams.get("all") === "true";
    const cmd = all ? "__ui:snapshot:all" : "__ui:snapshot";
    return sendToClient(idx, cmd);
  }

  if (route === "history") {
    if (prod) return err("dev-only endpoint", 403);
    return json(
      trojan.getTTHistory?.() ?? { entries: [], index: 0, paused: false },
    );
  }

  if (route === "errors") {
    if (prod) return err("dev-only endpoint", 403);
    return json({ errors: deps.getRecentErrors() });
  }

  if (route === "schedules") return json(trojan.getSchedules());

  if (route === "metrics") {
    return json({
      uptime: Math.round((Date.now() - trojan.startedAt) / 1000),
      connections: deps.getWsClients().length,
      schedules: trojan.getSchedules().length,
    });
  }

  if (route === "config") {
    return json({
      port: deps.port,
      title: deps.title,
      expose: deps.authInfo.expose,
      authMode: deps.authInfo.mode,
      prod: deps.prod,
    });
  }

  return err("not found", 404);
}

// ── POST routes (CSRF-protected) ──

async function handlePost(
  route: string,
  req: Request,
  deps: TrojanDeps,
  json: (d: unknown) => Response,
  err: (m: string, s?: number) => Response,
  sendToClient: (idx: number, msg: string) => Promise<Response>,
): Promise<Response> {
  if (!req.headers.get("x-aio")) {
    return err("Missing X-AIO header", 403);
  }
  deps.debug(`[trojan] POST ${route}`);
  const { trojan, prod } = deps;

  if (route === "dispatch") {
    try {
      const body = await req.text();
      const action = JSON.parse(body);
      if (!action || typeof action.type !== "string") {
        return err("missing type field");
      }
      // Same gate as server-ws — framework-internal actions (__set*, __exec, …)
      // must not enter the dispatch loop from a network-sourced caller.
      if (_isFrameworkInternalActionType(action.type)) {
        return err(
          `framework-internal action type "${action.type}" not dispatchable from trojan`,
          403,
        );
      }
      if (
        action.payload !== undefined &&
        (typeof action.payload !== "object" || action.payload === null ||
          Array.isArray(action.payload))
      ) {
        return err("invalid payload — must be a plain object");
      }
      delete action.user;
      deps.dispatch(action, undefined);
      return json({ ok: true });
    } catch {
      return err("invalid JSON");
    }
  }

  if (route.startsWith("interact/") && !prod) {
    const idx = Number(route.slice(9));
    if (!Number.isInteger(idx) || idx < 0) {
      return err("invalid client index", 400);
    }
    try {
      const body = await req.text();
      const cmd = JSON.parse(body);
      return sendToClient(idx, "__ui:interact:" + JSON.stringify(cmd));
    } catch {
      return err("invalid JSON");
    }
  }

  if (route === "snapshot") {
    if (!deps.loadSnapshot) return err("snapshots not available", 501);
    try {
      const clHeader = req.headers.get("content-length");
      if (clHeader !== null && Number(clHeader) > SNAPSHOT_MAX_SIZE) {
        return err(`snapshot too large (max ${SNAPSHOT_MAX_SIZE} bytes)`, 413);
      }
      if (clHeader === null) {
        return err("Content-Length header required for snapshot upload", 411);
      }
      const body = await req.text();
      if (body.length > SNAPSHOT_MAX_SIZE) {
        return err(`snapshot too large (max ${SNAPSHOT_MAX_SIZE} bytes)`, 413);
      }
      JSON.parse(body); // validate
      deps.loadSnapshot(body);
      return json({ ok: true });
    } catch {
      return err("invalid JSON");
    }
  }

  if (route === "tt") {
    if (prod) return err("dev-only endpoint", 403);
    if (!deps.onTTCommand) return err("time-travel not active", 501);
    try {
      const body = await req.text();
      const { cmd, arg } = JSON.parse(body);
      if (!cmd || typeof cmd !== "string") return err("missing cmd field");
      if (cmd === "goto" && typeof arg === "number") {
        deps.onTTCommand("goto", arg);
      } else deps.onTTCommand(cmd);
      return json({ ok: true });
    } catch {
      return err("invalid JSON");
    }
  }

  if (route === "sql") {
    if (!trojan.sqlQuery) return err("SQLite not configured", 501);
    try {
      const body = await req.text();
      const { query } = JSON.parse(body);
      if (!query || typeof query !== "string") {
        return err("missing query field");
      }
      if (query.includes(";")) {
        return err("multi-statement queries not allowed", 403);
      }
      const normalized = query.trimStart().toUpperCase();
      const startsSelect = normalized.startsWith("SELECT ") ||
        normalized.startsWith("SELECT\n") ||
        normalized.startsWith("SELECT\t") || normalized === "SELECT";
      // Allow `WITH ... SELECT` CTEs (read-only common table expressions).
      const startsWith = normalized.startsWith("WITH ") ||
        normalized.startsWith("WITH\n") || normalized.startsWith("WITH\t");
      if (!startsSelect && !startsWith) {
        return err(
          "trojan SQL is read-only — only SELECT (or WITH ... SELECT) allowed",
          403,
        );
      }
      // Strip single-quoted string literals before the keyword scan so a
      // value like 'DROP TABLE instructions' doesn't trip a false positive.
      // '' inside a literal is an escaped quote — collapse first, then mask.
      const withoutLiterals = query.replace(/'(?:[^']|'')*'/g, "''");
      const upper = withoutLiterals.toUpperCase();
      if (
        /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|DETACH|LOAD_EXTENSION|REINDEX|VACUUM|REPLACE|PRAGMA|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|MERGE)\b/
          .test(upper)
      ) {
        return err(
          "trojan SQL is read-only — write/DDL keywords forbidden",
          403,
        );
      }
      // Audit F-9: enforce row + byte caps so a wide/unbounded SELECT cannot
      // block the SQLite worker or OOM the server.
      const hasLimit = /\bLIMIT\b/.test(upper);
      const effectiveQuery = hasLimit
        ? query
        : `${query.trimEnd()} LIMIT ${TROJAN_SQL_DEFAULT_LIMIT}`;
      const rows = await trojan.sqlQuery(effectiveQuery);
      const serialized = JSON.stringify(rows, null, 2);
      if (serialized.length > TROJAN_SQL_MAX_RESULT_BYTES) {
        return err(
          `result exceeds ${TROJAN_SQL_MAX_RESULT_BYTES} bytes — add a tighter LIMIT or narrower columns`,
          413,
        );
      }
      return new Response(serialized, {
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      return err(String(e instanceof Error ? e.message : e));
    }
  }

  if (route === "persist") {
    if (!trojan.forcePersist) return err("persistence not available", 501);
    trojan.forcePersist();
    return json({ ok: true });
  }

  if (route === "shutdown") {
    if (!trojan.shutdown) return err("shutdown not available", 501);
    deps.debug(`[trojan] shutdown requested`);
    const resp = json({ ok: true, msg: "shutting down" });
    queueMicrotask(() => trojan.shutdown!());
    return resp;
  }

  return err("not found", 404);
}
