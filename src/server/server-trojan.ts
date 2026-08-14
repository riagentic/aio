// Trojan admin API — extracted from server.ts serveStatic()
// Control REST API at /__aio/trojan/* — DEV-ONLY (never mounted in prod; see
// the gate in server-static.ts).
//
// It has NO auth of its own, by design — every gate lives in server.ts, where
// the request's peer address and identity are known, so there is one decider
// rather than one per route here:
//   1. same-machine only, always (`_isLocalRequest`; remote gets a bare 404),
//   2. plus the app's own auth when the app has any: the shared key gates it
//      like every other route, and in per-user mode it needs an authenticated
//      admin OR the local operator's control credential
//      (`trojanDenialForUserMode` — `<data>/control.key`, 0600 in a 0700 dir,
//      which is how `am`/amui reach a locally running auth-enabled app) — this
//      endpoint reads unfiltered state, dispatches, runs SQL and replaces the
//      whole state, which is /__aio/snapshot's power and more.
// This header used to claim the auth part was already true under --expose. It
// was not: with the login flows on, the anonymous fall-through reached
// serveStatic — and this file — with no credential at all.
// CSRF-protected (X-AIO header on POST), rate-limited.
import { enc } from "../protocol/envelope.ts";
import type { AioUser } from "./aio.ts";
import {
  _isFrameworkInternalActionType,
  sanitizeClientAction,
} from "./server-ws.ts";
import { disarmLocalControl } from "./server-auth.ts";
import { generatePin, PIN_TTL_MS } from "./pairing.ts";

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
  /** Cost meter for the `cost` route (`am cost`). */
  costMeter?: import("../vitals/cost-meter.ts").CostMeter;
  dispatch: (event: unknown, user?: AioUser) => Promise<unknown> | void;
  getUIState: (user?: AioUser) => unknown;
  debug: (msg: string) => void;
  prod: boolean;
  port: number;
  title: string;
  /** App identity + creds for the discovery profile endpoint. */
  appId?: string;
  token?: string;
  certPem?: string;
  expose?: boolean;
  /** Trojan capabilities from ServerConfig.trojan */
  trojan: {
    getState: () => unknown;
    getSchedules: () => string[];
    getTTHistory?: () => unknown;
    /** Recent dispatches + their state diffs. */
    getTimeline?: (
      after?: number,
      limit?: number,
    ) => import("./timeline.ts").TimelineEntry[];
    /** Boot migration + shape-drift picture. */
    getMigrations?: () =>
      | import("./aio-boot.ts").MigrationSummary
      | undefined;
    forcePersist?: () => void;
    sqlQuery?: (sql: string) => Promise<unknown[]>;
    shutdown?: () => Promise<void>;
    startedAt: number;
    /** Cell id → its method (action) names — powers `am`/amui method buttons. */
    cellMethods?: () => Record<string, string[]>;
    cellFields?: () => import("./aio-types.ts").CellFieldFlags;
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
  /** Headless server-side surface render (`surface/server`) — lets
   *  `am surface` work with NO connected client (server-only apps, CI). */
  renderServerSurface?: (full?: boolean) => Promise<
    { ok: true; roots: unknown[] } | { ok: false; error: string }
  >;
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

/** Reset this process's control-plane state — called during server shutdown.
 *
 *  The rate-limit counters AND the local control credential: the credential is
 *  per-boot, so the process that minted it is the one that must take it away.
 *  Leaving the file behind would be inert (the app only ever accepts the value
 *  it holds in memory) but it would make the next `am` call fail with a stale
 *  key instead of an honest "the app is not running". */
export function resetTrojanRateLimit(): void {
  if (_trojanResetTimer) {
    clearTimeout(_trojanResetTimer);
    _trojanResetTimer = null;
  }
  _trojanReqCount = 0;
  disarmLocalControl();
}

/** THE reader for a numeric query param on the trojan API.
 *
 *  Absent ⇒ `undefined` (the route's own default applies). Present but
 *  unparsable ⇒ an ERROR, never a default: `?after=abc` silently became NaN,
 *  then `undefined`, then "no filter at all" — so a typo answered with the
 *  entire timeline and looked like a query that had simply matched everything.
 *  That is the exact swallow `parseNumArg` exists to prevent on the CLI side of
 *  the same data, and the `cost` route had already grown its own private copy
 *  of the check for its own param. One decider for the whole surface. */
function numParam(
  q: URLSearchParams,
  name: string,
  opts: { min?: number; gt?: number } = {},
): { ok: true; value: number | undefined } | { ok: false; error: string } {
  if (!q.has(name)) return { ok: true, value: undefined };
  const raw = q.get(name) ?? "";
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n)) {
    return { ok: false, error: `${name} must be a number (got "${raw}")` };
  }
  if (opts.min !== undefined && n < opts.min) {
    return { ok: false, error: `${name} must be ≥ ${opts.min} (got ${n})` };
  }
  if (opts.gt !== undefined && n <= opts.gt) {
    return { ok: false, error: `${name} must be > ${opts.gt} (got ${n})` };
  }
  return { ok: true, value: n };
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

  // Defense-in-depth: the trojan is dev-only. server-static gates it off in
  // prod (single source of truth); this backstop refuses even if it is ever
  // reached directly, so no per-route prod check is load-bearing.
  if (deps.prod) return err("trojan is disabled in production", 404);

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

  // Send a message to client `idx` (WS or UDS) and await its response.
  //
  // The ROSTER decides whether that client exists — the same roster the
  // `clients` route serves — and it decides ONCE, before either transport is
  // asked. It used to be decided by `if (trojan.requestUdsClientState)`, a
  // presence check on a function `aio-server.ts` ALWAYS supplies: with no UDS
  // listener it resolves `{error:"UDS not active"}`, which was served as a
  // 200. The `client not connected` 404 below it was therefore unreachable, and
  // every client-addressed route (`client/N`, `surface/N`, `trigger/N`)
  // answered a nonexistent client with a SUCCESS carrying an error string —
  // `am surface 0` printed an empty surface and exited 0, `am trigger 0`
  // reported a click that never happened, and `am surface`'s headless fallback
  // never fired because the reply it falls back from looked fine.
  const sendToClient = async (idx: number, msg: string): Promise<Response> => {
    const wsResult = deps.sendToWsClient(idx, msg);
    if (wsResult.found) return wsResult.promise;
    const uds = trojan.udsClients?.() ?? [];
    if (uds.some((c) => c.index === idx) && trojan.requestUdsClientState) {
      return json(await trojan.requestUdsClientState(idx, msg));
    }
    // Name the indices that DO exist — a miss is usually a stale index, and the
    // caller can correct it without a second round-trip (same reasoning as the
    // `available` paths a trigger miss returns).
    const connected = [
      ...deps.getWsClients().map((c) => c.meta.index),
      ...uds.map((c) => c.index),
    ].sort((a, b) => a - b);
    return err(
      `client ${idx} not connected (connected: ${
        connected.join(", ") || "none"
      })`,
      404,
    );
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
  const { trojan } = deps;

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

  if (route.startsWith("client/")) {
    const idx = Number(route.slice(7));
    if (!Number.isInteger(idx) || idx < 0) {
      return err("invalid client index", 400);
    }
    return sendToClient(idx, enc("get-state"));
  }

  if (route.startsWith("surface/")) {
    // Headless: render the UI on the server against live cell state — no
    // client required.
    // `?full=1` lifts the surface's text cap — `am surface --full`, for reading
    // a long generated string the scannable default would cut.
    const full = req ? new URL(req.url).searchParams.has("full") : false;
    if (route === "surface/server") {
      if (!deps.renderServerSurface) {
        return err("server-side surface unavailable (no UI entry)", 404);
      }
      return deps.renderServerSurface(full).then((r) =>
        r.ok ? json(r.roots) : err(r.error, 500)
      );
    }
    const idx = Number(route.slice(8));
    if (!Number.isInteger(idx) || idx < 0) {
      return err("invalid client index", 400);
    }
    return sendToClient(
      idx,
      enc("ui-surface", full ? { full: true } : undefined),
    );
  }

  if (route === "history") {
    return json(
      trojan.getTTHistory?.() ?? { entries: [], index: 0, paused: false },
    );
  }

  // Recent dispatches + their state diffs. Optional
  // ?after=<seq> (only newer) and ?limit=<n> (last n) query params.
  if (route === "timeline") {
    const q = new URL(req!.url).searchParams;
    // `?after=abc` used to become NaN → `undefined` → "no filter", so a typo
    // answered with the WHOLE timeline and looked like a successful query that
    // simply matched everything. Same swallow `parseNumArg` exists to prevent
    // on the CLI side, and the `cost` route below already refuses its own
    // unparsable `window` — one rule, one helper (numParam).
    const after = numParam(q, "after");
    if (!after.ok) return err(after.error, 400);
    const limit = numParam(q, "limit", { min: 1 });
    if (!limit.ok) return err(limit.error, 400);
    return json({
      entries: trojan.getTimeline?.(after.value, limit.value) ?? [],
    });
  }

  if (route === "errors") {
    return json({ errors: deps.getRecentErrors() });
  }

  // Boot migration + shape-drift picture. Empty
  // when nothing was restored (fresh install / persistence off).
  if (route === "migrations") {
    return json(
      trojan.getMigrations?.() ??
        { declared: {}, stored: {}, report: [], drift: [] },
    );
  }

  if (route === "schedules") return json(trojan.getSchedules());

  // Cell id → method names — the surface for "run a method" buttons.
  if (route === "cells") return json(trojan.cellMethods?.() ?? {});
  if (route === "fields") return json(trojan.cellFields?.() ?? {});

  if (route === "metrics") {
    // Per-cell serialized state size — the "why is it slow / heavy" signal
    // `am top` renders. Cheap: one JSON pass over the authoritative store.
    const cellSizes: Record<string, number> = {};
    const state = trojan.getState();
    if (state && typeof state === "object") {
      for (const [name, slice] of Object.entries(state)) {
        try {
          cellSizes[name] = JSON.stringify(slice)?.length ?? 0;
        } catch {
          cellSizes[name] = -1; // unserializable (cyclic) — flag, don't throw
        }
      }
    }
    return json({
      uptime: Math.round((Date.now() - trojan.startedAt) / 1000),
      connections: deps.getWsClients().length,
      schedules: trojan.getSchedules().length,
      cells: cellSizes,
    });
  }

  if (route === "cost") {
    // `am cost` — what aio moves on this app's behalf, and where it comes from.
    // The meter is always on (bounded rings in the broadcast path), so this
    // route is a pure read: no sampling to start, nothing to enable, and the
    // answer is already there when someone asks it after the fact.
    if (!deps.costMeter) {
      return err("cost metering unavailable in this build", 404);
    }
    const url = req ? new URL(req.url) : undefined;
    const params = url?.searchParams ?? new URLSearchParams();
    const cell = params.get("cell") ?? undefined;
    const win = numParam(params, "window", { gt: 0 });
    if (!win.ok) return err(win.error, 400);
    const windowSec = win.value ?? 60;
    // State size per cell is the other half of "should I act on aiol's hint":
    // the push cost says what MOVES, this says what is THERE.
    const sizes: Record<string, number> = {};
    const state = trojan.getState();
    if (state && typeof state === "object") {
      for (const [name, slice] of Object.entries(state)) {
        try {
          sizes[name] = JSON.stringify(slice)?.length ?? 0;
        } catch {
          sizes[name] = -1;
        }
      }
    }
    // The live state's own keys ARE the cells — a more reliable roster than a
    // list captured at boot, and it makes "this cell did nothing" reportable
    // rather than indistinguishable from "this cell does not exist".
    deps.costMeter.setKnownCells(Object.keys(sizes));
    const report = deps.costMeter.report({ windowSec, cell });
    return json({ ...report, stateBytes: sizes });
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

  // The app's discovery profile (.aioapp) — everything the aio client needs to
  // connect forever: name, port, TLS cert to pin, and the auth key. Localhost
  // only (the trojan is 127.0.0.1-bound), so serving the key here is safe —
  // `am profile` fetches it, the operator hands the file to trusted users.
  if (route === "profile") {
    return json({
      aio: 1,
      name: deps.appId ?? deps.title,
      title: deps.title,
      port: deps.port,
      tls: !!deps.certPem,
      cert: deps.certPem ?? null,
      key: deps.token ?? null, // null = no framework auth (app-level or open)
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
  const { trojan } = deps;

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
      // a field report: `ok:true` must mean EXECUTED, and an unknown method
      // must be an ERROR — the route used to ack ANY type (real or bogus) and
      // fire-and-forget, so a typo or the `cell.method` (dot) form the reducer's
      // `cell:method` (colon) form never matches silently no-op'd under a green
      // "ok". Validate a method-form type against the booted cells, normalize the
      // separator, then AWAIT so a rejecting method surfaces as an error.
      const methods = trojan.cellMethods?.() ?? {};
      const sepIdx = action.type.search(/[:.]/);
      // An ALL-DIGITS type is never a valid action — no cell method and no
      // actions-form creator is named `0` — so it can only ever no-op, and it
      // used to do that under a green "ok". The shape that produces it is
      // predictable rather than exotic: `am trigger` and `am surface` take a
      // CLIENT INDEX as their first positional, so `am dispatch 0
      // counter:increment` is the natural generalization; it dispatched
      // `{type:"0"}` into the void and answered {"ok":true}. A predictable user
      // error that reports success is the silent-wrong-outcome class this
      // project treats as disqualifying.
      //
      // Only the numeric form is refused: a bare `Increment` IS legitimate for
      // an actions-form cell (pinned by the "bare config action" case in
      // tests/trojan-dispatch-validate.test.ts), and the trojan cannot
      // enumerate those creators to tell a typo from a real one.
      if (/^\d+$/.test(action.type)) {
        const valid = Object.entries(methods)
          .flatMap(([c, ms]) => ms.map((m) => `${c}:${m}`))
          .join(", ");
        return err(
          `"${action.type}" is not an action — dispatch takes <cell>:<method>, ` +
            `so this would have done nothing. That looks like a client index: ` +
            `\`am trigger\`/\`am surface\` take one, \`am dispatch\` does not.` +
            (valid ? ` Known: ${valid}.` : ""),
          404,
        );
      }
      if (sepIdx > 0 && Object.keys(methods).length > 0) {
        const cell = action.type.slice(0, sepIdx);
        const method = action.type.slice(sepIdx + 1);
        const known = methods[cell];
        if (!known) {
          return err(
            `unknown cell "${cell}" — not booted (cells: ${
              Object.keys(methods).join(", ") || "none"
            }). Dispatch does nothing.`,
            404,
          );
        }
        if (!known.includes(method)) {
          return err(
            `cell "${cell}" has no method "${method}" (has: ${
              known.join(", ") || "none"
            }). Dispatch does nothing.`,
            404,
          );
        }
        action.type = `${cell}:${method}`; // normalize dot → colon
      }
      // Strip client-set trusted provenance and re-stamp `_source:"UI"` — ONE
      // decider for all three network entry points (sanitizeClientAction,
      // server-ws.ts). `user` (without the underscore) is trojan-specific
      // legacy: the field dispatch consumes is `_user`, and deleting only the
      // wrong key once left the spoof open — drop both.
      delete action.user;
      sanitizeClientAction(action as Record<string, unknown>, "trojan");
      try {
        await deps.dispatch(action, undefined);
      } catch (e) {
        return err(
          `dispatch of "${action.type}" failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
      return json({ ok: true });
    } catch {
      return err("invalid JSON");
    }
  }

  if (route.startsWith("trigger/")) {
    const idx = Number(route.slice(8));
    if (!Number.isInteger(idx) || idx < 0) {
      return err("invalid client index", 400);
    }
    try {
      const body = JSON.parse(await req.text());
      if (typeof body?.path !== "string" || typeof body?.action !== "string") {
        return err("body must be { path, action, text?, key? }", 400);
      }
      return sendToClient(idx, enc("ui-trigger", body));
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
      // Build a scan copy for the guards. Order matters: strip COMMENTS FIRST
      // (line `-- …`, block `/* … */`), THEN mask string literals. Doing it the
      // other way let an unbalanced quote inside a comment make the literal-mask
      // swallow a following `;DROP…` (the quote-run spanned the newline). This
      // copy is only for the guards; the real query still runs verbatim, so
      // over-stripping can at worst cause a conservative rejection, never a
      // bypass. (Guards are defense-in-depth over SQLite's single-statement
      // prepare + the SELECT-only allowlist.)
      const scrubbed = query
        .replace(/--[^\n]*/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/'(?:[^']|'')*'/g, "''");
      // Multi-statement guard: check for ';' AFTER literal+comment stripping so
      // a semicolon inside a string literal (WHERE name='a;b') isn't falsely
      // rejected while a chained ';DROP…' can't hide. SQLite's prepare() runs
      // only one statement anyway; this is defense-in-depth.
      if (scrubbed.includes(";")) {
        return err("multi-statement queries not allowed", 403);
      }
      const upper = scrubbed.toUpperCase();
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
      // `hasLimit` is scanned on the comment-stripped copy so a LIMIT hidden
      // in a comment can't suppress the cap. The LIMIT is appended on a FRESH
      // line so a trailing `-- comment` in the raw query can't swallow it.
      const hasLimit = /\bLIMIT\b/.test(upper);
      const effectiveQuery = hasLimit
        ? query
        : `${query.trimEnd()}\nLIMIT ${TROJAN_SQL_DEFAULT_LIMIT}`;
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

  // `am pair` — issue a FRESH pairing PIN on a running app.
  //
  // A PIN is one-shot and lives 3 minutes, and boot was the only thing that
  // ever generated one: miss that window and pairing was dead until the app was
  // restarted (which, for a keyed app, is downtime for every connected client).
  // The regeneration route could not exist while the control plane was
  // anonymous — handing out a pairing code IS handing out the app key, one
  // remote hop away — but it is exactly right now that reaching this route
  // means an authenticated admin or the machine's owner: the same authority
  // that could already read the key straight out of `/__aio/trojan/profile`.
  if (route === "pair") {
    if (!deps.token) {
      return err(
        "this app has no shared key, so there is nothing to pair — pairing " +
          "hands out `key:`; per-user apps (`auth: true`, `users:`) issue " +
          "credentials through their own login flow, and an open app needs none",
        400,
      );
    }
    const pin = generatePin();
    return json({
      ok: true,
      pin,
      ttlSec: Math.round(PIN_TTL_MS / 1000),
      // A PIN is submitted to the app over the network — on an app that is not
      // exposed, only this machine can reach /__aio/pair at all.
      expose: !!deps.expose,
      hint: deps.expose
        ? `type ${pin} in the aio client within ${
          Math.round(PIN_TTL_MS / 1000)
        }s — single use`
        : `this app is not exposed (--expose), so only this machine can submit ` +
          `the code to /__aio/pair`,
    });
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
