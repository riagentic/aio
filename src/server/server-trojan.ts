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
import v8 from "node:v8";
import { measureCellState } from "../diagnostics/memory-monitor.ts";
import { CELL_METHOD_SEP } from "../state/cell-helpers.ts";
import { serializeReturn } from "../protocol/return-value.ts";
import {
  _dispatchRefusal,
  _dispatchUnsaved,
  shortCallSentence,
} from "./action-ack.ts";
import {
  CONTROL_MAX_BODY,
  declaresOverLimit,
  readBounded,
  SNAPSHOT_MAX_BODY,
} from "./read-body.ts";
import { enc, errorCode } from "../protocol/envelope.ts";
import { snapshotShapeError } from "./server-static.ts";
import { findUnserializable, PersistSerializeError } from "./persist-guard.ts";
import { UNSERIALIZABLE_BYTES } from "../diagnostics/fmt.ts";
import type { AioUser } from "./aio.ts";
import {
  _isFrameworkInternalActionType,
  sanitizeClientAction,
} from "./server-ws.ts";
import { disarmLocalControl, TROJAN_PREFIX } from "./server-auth.ts";
import { generatePin, PIN_TTL_MS } from "./pairing.ts";

/** Client info visible to trojan introspection endpoints */
export interface TrojanClientInfo {
  /** The client's own proto hello (its aio / app version), when it said. */
  peer?: { aio?: string; app?: string };
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
  /** Server-origin dispatch — bypasses the cell `access` gate, because server
   *  code always has. Reached ONLY via `?as=server` on this route. */
  dispatchAsServer?: (event: unknown) => Promise<unknown> | void;
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
    /** Has the live ring dropped anything since boot (by count or bytes)? */
    getTimelineRotated?: () => boolean;
    /** Boot migration + shape-drift picture. */
    getMigrations?: () =>
      | import("./aio-boot.ts").MigrationSummary
      | undefined;
    forcePersist?: () => Promise<void>;
    sqlQuery?: (sql: string) => Promise<unknown[]>;
    shutdown?: () => Promise<void>;
    startedAt: number;
    /** Cell id → its method (action) names — powers `am`/amui method buttons. */
    cellMethods?: () => Record<string, string[]>;
    /** Cell id → async method names — the calls a `_callId` can correlate. */
    cellAsyncMethods?: () => Record<string, string[]>;
    /** Cell id → method name → required argument count (methods-form cells). */
    cellMethodArity?: () => Record<string, Record<string, number>>;
    cellFields?: () => import("./aio-types.ts").CellFieldFlags;
    /** Cell id → the running build's `version` and whether it converts
     *  state across versions (declares `onMigrate`) — what `am replay` checks
     *  a journal line's version stamp against. */
    cellVersions?: () => Record<string, { version: number; migrates: boolean }>;
    udsClients?: () => { index: number; id: string }[];
    requestUdsClientState?: (index: number, msg?: string) => Promise<unknown>;
  };
  /** Auth mode info for config endpoint */
  authInfo: { mode: string; expose: boolean };
  /** Snapshot support */
  loadSnapshot?: (json: string, opts?: { force?: boolean }) => void;
  /** Time-travel command handler */
  /** A promise when the jump owes a save (aio.ts `_durableFor`): awaited
   *  before the reply. */
  onTTCommand?: (
    cmd: string,
    arg?: number,
  ) => void | Promise<string | undefined>;
  /** List connected WS clients (read-only view) */
  getWsClients: () => Array<{ ws: WebSocket; meta: TrojanClientInfo }>;
  /** Find WS client by index and send message, returning response promise */
  sendToWsClient: (
    idx: number,
    msg: string,
  ) => { found: true; promise: Promise<Response> } | { found: false };
  /** Recent transpile errors (dev mode) */
  getRecentErrors: () => unknown[];
  /** The persistence verdict as health reads it (no flush) — see
   *  `ServerConfig.lastPersistError`. */
  lastPersistError?: () => Error | null;
  /** The dev server's import-graph verdict — what decides whether `/` is the
   *  app or the diagnostic page. `pending` while the boot validation is still
   *  running (the page is served as the app meanwhile), `null` in prod and
   *  when there is no UI entry. Dev only, like the diagnostic page itself. */
  getGraphStatus?: () => {
    pending: boolean;
    result: import("./graph-validator.ts").GraphResult | null;
  } | null;
  /** Find user by ID (trojan ui endpoint) — returns AioUser from users map, or undefined */
  findUserById?: (id: string) => AioUser | undefined;
  /** Headless server-side surface render (`surface/server`) — lets
   *  `am surface` work with NO connected client (server-only apps, CI). */
  renderServerSurface?: (full?: boolean) => Promise<
    { ok: true; roots: unknown[] } | { ok: false; error: string }
  >;
}

const TROJAN_RATE_LIMIT = 100;
/** Auto-LIMIT applied to trojan SELECTs that don't set their own — bounds
 *  result size and SQLite worker time. Audit F-9. */
const TROJAN_SQL_DEFAULT_LIMIT = 10_000;
/** Hard cap on serialized result bytes to prevent OOM from a wide SELECT
 *  (e.g. millions of small rows still under DEFAULT_LIMIT). Audit F-9. */
const TROJAN_SQL_MAX_RESULT_BYTES = 10_000_000;
/** One rate-limit window PER SERVER, keyed by the server's own `trojan`
 *  capabilities object (built once per `startServer`, shared by its TLS
 *  control listener, so both doors of one app still draw on one budget).
 *
 *  It was one module-level counter, and a process can host several apps
 *  (library mode, `testApps`): 101 `am` calls against app A answered app B's
 *  FIRST request with a 429 that named a count B never received. A WeakMap,
 *  so a closed server's window goes with it; a timestamp window, not a timer,
 *  so nothing is left armed for shutdown to clear. */
const _trojanWindows = new WeakMap<
  object,
  { start: number; count: number; epoch: number }
>();
/** Bumped by an unscoped reset: every window opened before it is stale. */
let _trojanEpoch = 0;

/** Count one request against this server's window; the count so far. */
function _countTrojanRequest(key: object): number {
  const now = Date.now();
  let w = _trojanWindows.get(key);
  if (!w || now - w.start >= 1000 || w.epoch !== _trojanEpoch) {
    w = { start: now, count: 0, epoch: _trojanEpoch };
    _trojanWindows.set(key, w);
  }
  return ++w.count;
}

/** Reset control-plane state — called during server shutdown.
 *
 *  The rate-limit window AND the local control credential: the credential is
 *  per-boot, so the process that minted it is the one that must take it away.
 *  Leaving the file behind would be inert (the app only ever accepts the value
 *  it holds in memory) but it would make the next `am` call fail with a stale
 *  key instead of an honest "the app is not running".
 *
 *  `owner` scopes it to ONE app, which is what a server's shutdown passes. The
 *  unscoped form disarmed EVERY credential in the process, so closing app B in
 *  a two-app process deleted app A's `control.key` from disk and 401'd A's own
 *  operator — `am` locked out of a perfectly healthy app. With an owner and no
 *  appId nothing is disarmed: an app with no appId armed nothing
 *  (`armLocalControl` refuses without one). No argument keeps the old
 *  meaning — everything — for a test that drove `handleTrojan` directly. */
export function resetTrojanRateLimit(owner?: { appId?: string }): void {
  if (owner === undefined) {
    _trojanEpoch++;
    disarmLocalControl();
    return;
  }
  // The window needs no reset: it is keyed by the closing server's own object
  // and dies with it.
  if (owner.appId !== undefined) disarmLocalControl(owner.appId);
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
/** The refusal every bounded control-plane body shares.
 *
 *  Four routes read a bounded body and all four answered "<x> body too large"
 *  — a limit with no number, the same gap the trojan's rate limit had: this is
 *  a message an OPERATOR meets through `am`, and it cannot be acted on. The
 *  request's true size is deliberately NOT known here (the read aborts AT the
 *  cap — that is the point of the bound), but "what may I send?" is
 *  answerable, and it is the half that matters. One sentence, four callers. */
export function tooLargeMessage(what: string): string {
  return `${what} body is over the control plane's ${
    CONTROL_MAX_BODY / 1024 / 1024
  } MB cap — the read stops there, so NOTHING was executed. Send a smaller ` +
    `payload: the control plane carries commands, not bulk data (write the ` +
    `data through the app itself, or point it at a file it can read).`;
}

/** V8's real heap ceiling, cached.
 *
 *  `heapTotal` is lazily allocated, so it sits just above `heapUsed` and always
 *  looks reassuring; the number that says how close an app is to OOM is
 *  `heap_size_limit`. Same source the memory monitor reads
 *  (`aio-cells-bridge.ts`), so the two cannot report different ceilings for one
 *  process. `0` when the runtime cannot say, which the caller reports as `null`
 *  rather than as a plausible-looking zero. */
let _heapLimitCache: number | undefined;
function v8HeapLimit(): number {
  if (_heapLimitCache !== undefined) return _heapLimitCache;
  try {
    _heapLimitCache =
      (v8.getHeapStatistics() as { heap_size_limit: number }).heap_size_limit;
  } catch {
    // aio-ok: a runtime with no V8 statistics. Everything else in the reading
    // is still true; only the percentage is unavailable.
    _heapLimitCache = 0;
  }
  return _heapLimitCache;
}

export function handleTrojan(
  pathname: string,
  req: Request | undefined,
  deps: TrojanDeps,
): Response | Promise<Response> | null {
  if (!pathname.startsWith(TROJAN_PREFIX)) return null;

  const route = pathname.slice(TROJAN_PREFIX.length);
  const method = req?.method ?? "GET";

  // `code` rides beside the message exactly as on the WS/UDS acks
  // (`errorFields`), so a caller branches on it instead of the prose.
  const err = (msg: string, status = 400, code?: string) =>
    new Response(
      JSON.stringify(code ? { error: msg, code } : { error: msg }),
      {
        status,
        headers: { "Content-Type": "application/json" },
      },
    );
  /** Every trojan reply's body.
   *
   *  `JSON.stringify` THROWS on a BigInt or a cycle anywhere in state, and the
   *  throw escaped to the server's generic handler: `am state` and
   *  `am snapshot` answered a bare `Internal Server Error` at exactly the
   *  moment an operator most needs a diagnosis — while the persist log, one
   *  screen away, named the field exactly. `persist-guard` already owns the
   *  walk that finds it; this is the same answer at the other door. */
  const json = (data: unknown) => {
    let body: string;
    try {
      body = JSON.stringify(data, null, 2);
    } catch (e) {
      const at = findUnserializable(data);
      return err(
        at
          ? new PersistSerializeError(at.path, at.kind, e).message
          : `this app's state cannot be serialized: ${
            e instanceof Error ? e.message : String(e)
          }`,
        500,
      );
    }
    return new Response(body, {
      headers: { "Content-Type": "application/json" },
    });
  };

  // Defense-in-depth: the trojan is dev-only. server-static gates it off in
  // prod (single source of truth); this backstop refuses even if it is ever
  // reached directly, so no per-route prod check is load-bearing.
  if (deps.prod) return err("trojan is disabled in production", 404);

  // Rate limiting — 100 requests/sec across all of ONE app's trojan endpoints
  // Per server — see `_trojanWindows`. `deps.trojan` is always supplied by a
  // real server; a hand-built deps without it still gets a window of its own.
  const reqCount = _countTrojanRequest(deps.trojan ?? deps);
  if (reqCount > TROJAN_RATE_LIMIT) {
    // SAY THE LIMIT. The two sibling limiters both do — client-log names
    // `>${MAX_RATE} msg/s`, the WS fuse names the rate, the client count and
    // the cap — and this is the one an OPERATOR meets, through `am`, where a
    // bare "rate limit exceeded" reads as a broken tool: no number, no cause,
    // and no hint that it clears by itself a second later. MEASURED: 700
    // dispatches in a loop, then `am state` answered
    // `{"error":"rate limit exceeded"}` with nothing else to go on.
    return err(
      `rate limit exceeded — the trojan control plane accepts ` +
        `${TROJAN_RATE_LIMIT} requests/sec across ALL of its endpoints, and ` +
        `${reqCount} arrived this second. It clears on its own at the ` +
        `next second; a script calling \`am\` in a tight loop is the usual ` +
        `cause, so space the calls out or do the work in one dispatch.`,
      429,
    );
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

  // The import-graph verdict, for whoever wants to know whether `/` is the
  // app or the diagnostic page WITHOUT fetching `/` and guessing from HTML —
  // `am`, a test, an agent. `pending` is the boot race made visible: the
  // validation is async, and until it lands the page is served as the app.
  if (route === "graph") {
    const g = deps.getGraphStatus?.() ?? null;
    if (!g) return json({ pending: false, valid: true, errors: [] });
    if (g.pending || !g.result) {
      return json({ pending: true, valid: null, errors: [] });
    }
    return json({
      pending: false,
      valid: g.result.valid,
      modules: g.result.modules.size,
      errors: g.result.errors.map((e) => ({
        file: e.file,
        line: e.line,
        category: e.category,
        message: e.message,
        fix: e.fix,
        deferred: e.deferred ?? false,
      })),
    });
  }

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
      // The build each client SAID it runs (its proto hello).
      ...(c.meta.peer?.aio ? { aio: c.meta.peer.aio } : {}),
      ...(c.meta.peer?.app ? { app: c.meta.peer.app } : {}),
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
    // `?rects=1` attaches layout geometry — `am surface --rects`.
    const rects = req ? new URL(req.url).searchParams.has("rects") : false;
    if (route === "surface/server") {
      if (!deps.renderServerSurface) {
        return err("server-side surface unavailable (no UI entry)", 404);
      }
      // REFUSED, not answered with zeroes. A server-side render has no layout
      // engine: every getBoundingClientRect() there answers 0,0 0x0, and a
      // grid of zeroes reads as a real measurement of a collapsed UI — the
      // exact bug someone reaching for --rects is hunting. The refusal names
      // the one thing that can answer.
      if (rects) {
        return err(
          "a server-side render has no layout, so --rects would report 0x0 " +
            "for every element. Open the app (am open) and re-run: --rects " +
            "needs a real client.",
          409,
        );
      }
      return deps.renderServerSurface(full).then((r) =>
        r.ok ? json(r.roots) : err(r.error, 500)
      );
    }
    const idx = Number(route.slice(8));
    if (!Number.isInteger(idx) || idx < 0) {
      return err("invalid client index", 400);
    }
    const d = full || rects
      ? { ...(full ? { full: true } : {}), ...(rects ? { rects: true } : {}) }
      : undefined;
    return sendToClient(idx, enc("ui-surface", d));
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
    // `rotated`: the ring is bounded by retained BYTES as well as by count,
    // so a reader cannot infer "earlier dispatches are gone" from the entry
    // count alone — it is said.
    const rotated = trojan.getTimelineRotated?.();
    return json({
      entries: trojan.getTimeline?.(after.value, limit.value) ?? [],
      ...(rotated !== undefined ? { rotated } : {}),
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
  if (route === "cell-versions") return json(trojan.cellVersions?.() ?? {});

  if (route === "metrics") {
    // Per-cell serialized state size — the "why is it slow / heavy" signal
    // `am top` renders. Cheap: one JSON pass over the authoritative store.
    const cellSizes: Record<string, number> = {};
    // A `-1` in a byte column is not a signal anyone reads — it was printed as
    // a size by `am status`, `am metrics` and `am cost`, sitting next to the
    // one condition that costs an app its data. The sentinel stays (callers
    // depend on the numeric shape) and is NAMED alongside it, so a reader has
    // something to key on that is not a magic number.
    const unserializable: string[] = [];
    const state = trojan.getState();
    if (state && typeof state === "object") {
      for (const [name, slice] of Object.entries(state)) {
        try {
          cellSizes[name] = JSON.stringify(slice)?.length ?? 0;
        } catch {
          cellSizes[name] = UNSERIALIZABLE_BYTES; // flag, don't throw
          unserializable.push(name);
        }
      }
    }
    return json({
      uptime: Math.round((Date.now() - trojan.startedAt) / 1000),
      // BOTH transports. `am status` printed `connections: 0` for a desktop
      // app while `am clients` — twenty lines below, from the same trojan —
      // listed its one live UDS client. Two routes, one running app, two
      // answers, and the operator has no way to tell which is lying. A local
      // Electron app opens no TCP ports at all, so its clients are ALL here.
      connections: deps.getWsClients().length +
        (trojan.udsClients?.() ?? []).length,
      schedules: trojan.getSchedules().length,
      cells: cellSizes,
      // Only when there IS one — an empty array in every reply is noise, and
      // its presence is the whole point.
      ...(unserializable.length ? { unserializable } : {}),
    });
  }

  if (route === "heap") {
    // `am heap` — what the process is HOLDING, as opposed to what it is
    // serving. `am state` answers the second question and nothing answered the
    // first: a field report watched a console peak at 31.8 GB and restart 16
    // times in 24 hours with no way to ask, from outside, how much of that was
    // heap and which cell it was in (report 2 §9.4).
    //
    // The numbers are V8's own, read at the moment of asking — no sampling to
    // start, nothing to enable. `heapLimit` is the real ceiling
    // (`heap_size_limit`), not `heapTotal`, which is lazily allocated and
    // therefore always near `heapUsed` and always reassuring.
    const mem = (Deno as unknown as {
      memoryUsage?: () => {
        rss: number;
        heapTotal: number;
        heapUsed: number;
        external: number;
      };
    }).memoryUsage?.();
    if (!mem) return err("heap statistics unavailable in this runtime", 404);
    // The REAL ceiling, from V8 itself. `heapTotal` is lazily allocated, so it
    // sits just above `heapUsed` and always looks reassuring — the number that
    // says how close the app is to OOM is `heap_size_limit`. Same source the
    // memory monitor uses (aio-cells-bridge), so the two cannot disagree.
    const limit = v8HeapLimit();
    const cells: { name: string; bytes: number; largestField?: unknown }[] = [];
    const st = trojan.getState();
    if (st && typeof st === "object") {
      for (const [name, slice] of Object.entries(st)) {
        try {
          cells.push(measureCellState(name, slice));
        } catch {
          // aio-ok: a slice that cannot be measured is reported as unknown
          // rather than failing the whole reading — the OTHER cells are still
          // the answer, and this route exists precisely for the moment when
          // something is wrong.
          cells.push({ name, bytes: -1 });
        }
      }
    }
    cells.sort((a, b) => b.bytes - a.bytes);
    return json({
      pid: Deno.pid,
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      heapLimit: limit || null,
      heapPct: limit ? Math.round((mem.heapUsed / limit) * 100) : null,
      external: mem.external,
      cells,
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
          sizes[name] = UNSERIALIZABLE_BYTES;
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
  err: (m: string, s?: number, code?: string) => Response,
  sendToClient: (idx: number, msg: string) => Promise<Response>,
): Promise<Response> {
  if (!req.headers.get("x-aio")) {
    return err("Missing X-AIO header", 403);
  }
  deps.debug(`[trojan] POST ${route}`);
  const { trojan } = deps;

  if (route === "dispatch") {
    try {
      const body = await readBounded(req, CONTROL_MAX_BODY);
      if (body === null) return err(tooLargeMessage("action"), 413);
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
      const sepIdx = action.type.search(CELL_METHOD_SEP);
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
      // How many arguments this call is SHORT by, carried to the reply below.
      let _shortBy = 0;
      let _shortRequired = 0;
      if (sepIdx > 0 && Object.keys(methods).length > 0) {
        const cell = action.type.slice(0, sepIdx);
        const method = action.type.slice(sepIdx + 1);
        // `Object.hasOwn` — `cell` is client-controlled, and a bare index
        // reads the prototype chain: `constructor`, `toString`, `valueOf` &
        // co. resolved to a Function, `known.includes` threw, and the
        // route's outer catch reported `400 invalid JSON` for a body that
        // was perfectly valid JSON. Fail loud is only worth having if it
        // fails loud about the right thing.
        const known = Object.hasOwn(methods, cell) ? methods[cell] : undefined;
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
        // A `payload.args` that is present but NOT an array is its own fault,
        // and the reducer's sentence for it is the right one. Checked before
        // the arity gate, which read it as "passes none" — true of nothing
        // the caller wrote.
        {
          const raw = (action.payload as { args?: unknown } | undefined)?.args;
          if (raw !== undefined && raw !== null && !Array.isArray(raw)) {
            return err(
              `[${cell}:${method}] action payload.args must be an ARRAY of ` +
                `positional arguments (got ${
                  typeof raw === "object" ? "an object" : `a ${typeof raw}`
                }: ${JSON.stringify(raw)?.slice(0, 60) ?? String(raw)}). ` +
                `Pass them as JSON (\`am dispatch ${cell}:${method} ` +
                `--args='[…]'\`) or dispatch { type: "${cell}:${method}", ` +
                `payload: { args: [a, b] } }. Dispatch does nothing.`,
              400,
            );
          }
        }
        // ARITY. The route refuses an unknown cell and an unknown method by
        // name; the number of arguments a KNOWN method needs was never
        // checked, though the count is right here. `am dispatch todo:add`
        // (zero args for `add(s, text: string)`) answered `{"ok":true}`, ran
        // `add(s, undefined)`, and put a row whose declared `text` is gone
        // into state and onto the screen — the persist guard names the damage
        // one window later, which is a diagnosis, not a refusal.
        //
        // Required arguments only. A default or a rest parameter ends
        // `fn.length`, so "too many" is not knowably wrong and stays allowed.
        const required = trojan.cellMethodArity?.()[cell]?.[method];
        // Remembered for the REPLY, below. The framework already warns about a
        // short call at `methodArgs` — but it warns into the SERVER LOG, and
        // this route answers `{"ok":true}` to the operator who made it. An
        // agent driving a live app never reads that log, so the one place the
        // fact was needed is the one place it did not reach.
        _shortBy = 0;
        _shortRequired = required ?? 0;
        {
          const p = action.payload as { args?: unknown } | undefined;
          if (
            required !== undefined && required > 0 && Array.isArray(p?.args)
          ) {
            _shortBy = Math.max(0, required - p.args.length);
          }
        }
        if (required !== undefined && required > 0) {
          const p = action.payload as { args?: unknown } | undefined;
          // ONLY a call that supplies NO argument list at all is refused.
          //
          // An `args` ARRAY — even an empty one — is the caller STATING their
          // arguments, and is taken at its word however short it is. That is
          // not laxity, it is the compatibility line: `fn.length` stops at the
          // first parameter with a default, so a method that fills its own in
          // (`reset(s, to) { to ??= 0 }`) reads as requiring an argument it
          // does not, and refusing on count alone would break a call that
          // works today. Absent-versus-stated is a fact about the CALL, not a
          // guess about the method.
          //
          // Both shapes the audit measured are still refused: `am dispatch
          // todo:add` sends no payload at all, and `am dispatch todo:add
          // text=x` sends a NAMED payload, which a methods-form cell reads as
          // zero positional arguments.
          if (!Array.isArray(p?.args)) {
            return err(
              `${cell}:${method} takes ${required} argument${
                required === 1 ? "" : "s"
              } and this call passes none. They would be \`undefined\` inside ` +
                `the method, which writes a broken row rather than failing — ` +
                `so this is refused instead. Dispatch does nothing. Pass them ` +
                `positionally (\`am dispatch ${cell}:${method} <arg>\`) or as ` +
                `JSON (\`--args='[…]'\`); if the method really does fill in ` +
                `its own defaults, say so with an explicit \`--args='[]'\`.` +
                (p !== undefined
                  ? ` (\`key=value\` builds a NAMED payload; a methods-form ` +
                    `cell takes positional arguments.)`
                  : ""),
              400,
            );
          }
        }
        action.type = `${cell}:${method}`; // normalize dot → colon
        // Correlate the call, so the answer below is the METHOD's answer.
        // Without an id, `dispatch` resolves with the early reduce result and
        // an async method that throws after its first `await` — a stale
        // capture, a refused write-set — was logged as EFFECT_ASYNC_ERROR
        // while this route had already answered {"ok":true}. The browser and
        // the CLI client both carry an id; the operator's door did not.
        // The id itself is minted in `dispatchNetwork` (aio-server.ts) now,
        // for every door at once — this route's private stamp was why the
        // operator's door reported honestly while the WS and UDS doors did
        // not, and a client is never trusted with it.
      } else if (sepIdx <= 0 && Object.keys(methods).length > 0) {
        // No separator, and this app is cells: every action a cell handles is
        // `<cell>:<method>`, so a bare type reaches nothing — and it used to
        // do that under {"ok":true}. Name the nearest real one.
        const all = Object.entries(methods)
          .flatMap(([c, ms]) => ms.map((m) => `${c}:${m}`));
        const guess = _nearestMethod(action.type, all);
        return err(
          `"${action.type}" is not an action — every action in this app ` +
            `belongs to a cell, so dispatch takes <cell>:<method> and a bare ` +
            `type would have done nothing.` +
            (guess ? ` Did you mean ${guess}?` : "") +
            (all.length ? ` Known: ${all.join(", ")}.` : ""),
          404,
        );
      }
      // Strip client-set trusted provenance and re-stamp `_source:"UI"` — ONE
      // decider for all three network entry points (sanitizeClientAction,
      // server-ws.ts). `user` (without the underscore) is trojan-specific
      // legacy: the field dispatch consumes is `_user`, and deleting only the
      // wrong key once left the spoof open — drop both.
      delete action.user;
      sanitizeClientAction(action as Record<string, unknown>, "trojan");
      // `?as=server` — dispatch with SERVER provenance, skipping the cell
      // `access` gate.
      //
      // "Public read, server-only write" (`access: false` + `visible: "all"`)
      // is a shape aio actively encourages, and it left the operator with no
      // way to call one method from the CLI: `am dispatch news:add` answered
      // "access denied", correctly, and the fallback was `am snapshot
      // save/load`, which bypasses validation entirely and is the wrong tool
      // for "call this one method".
      //
      // This widens nothing: the whole trojan is dev-only and loopback-only
      // and already reads unfiltered state and runs SQL. What it adds is a
      // NAMED, logged door instead of a bypass through the snapshot file.
      const asServer = new URL(req.url).searchParams.get("as") === "server";
      if (asServer && !deps.dispatchAsServer) {
        return err("as=server is not available on this server", 400);
      }
      let returned: unknown;
      try {
        if (asServer) {
          deps.debug?.(
            `trojan: dispatching "${action.type}" AS SERVER (access gate ` +
              `bypassed — dev-only, loopback-only)`,
          );
          returned = await deps.dispatchAsServer!(action);
        } else {
          returned = await deps.dispatch(action, undefined);
        }
      } catch (e) {
        return err(
          `dispatch of "${action.type}" failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
          400,
          errorCode(e),
        );
      }
      // …UNLESS THE REDUCE REFUSED IT. `dispatch` resolves whether or not
      // anything ran, so this route answered `ok: true` for a method the cell
      // no longer has, a cell that was never booted, a disabled cell and a
      // `validate` refusal alike — the four failures `action-ack.ts` exists
      // for. That file calls itself "ONE decider … shared by every transport
      // that acks a client call (server-ws.ts, uds.ts)", and this is the third
      // such transport: it is what `am dispatch`, amui and any agent reading
      // the JSON believe. Measured: a write the validator refused answered
      // `{"ok":true,"unsaved":null}` with the state unchanged — against this
      // file's own rule, stated in its time-travel arm, that "ok:true must
      // mean EXECUTED".
      const refused = _dispatchRefusal(action);
      if (refused) return err(refused.message, 409, errorCode(refused));
      // The method's return value rides back exactly as it does over the WS
      // ack (`serializeReturn`: JSON round-trip, lossy conversions warned).
      // `{ok:true}` alone told a caller the method RAN and nothing about what
      // it said — `am dispatch` printed "dispatched" for a method that
      // returned an error object (a field report, §6).
      const ret = serializeReturn(returned, action.type);
      // `ok` means APPLIED. Whether the write path is refusing right now is
      // a separate fact, and it is said here — the verdict health reads, no
      // flush forced — so `am dispatch` and an agent reading the JSON get
      // `unsaved` in the same reply instead of guessing from `ok`. `null`
      // spells "consulted, nothing refused"; an older server omits the field
      // and `am` asks health instead.
      const persistErr = deps.lastPersistError
        ? deps.lastPersistError()
        : undefined;
      // What THIS call owed and did not get on disk (its stand-in save, see
      // action-ack.ts) — the same field and sentence the WS/UDS acks carry.
      const owedUnsaved = _dispatchUnsaved(action);
      return json({
        ok: true,
        ...(ret.value !== undefined ? { result: ret.value } : {}),
        ...(ret.dropped ? { resultDropped: true } : {}),
        // The call RAN with arguments missing. Not a refusal — `fn.length`
        // stops at the first defaulted parameter, so a method that fills its
        // own in (`reset(s, to) { to ??= 0 }`) reports as needing one it does
        // not, and refusing would break a call that works today. But the
        // framework KNOWS, and until now it said so only in the server log
        // while this route answered a clean `ok` to the operator who made the
        // call. A field report's exact shape: `am dispatch todo:add` wrote a
        // row whose declared field was simply gone, under `{"ok":true}`.
        // ONE sentence for every door (action-ack.ts) — the WS and UDS acks
        // carry the same `short` for the same frame.
        ...(_shortBy > 0
          ? {
            short: shortCallSentence(
              action.type,
              _shortRequired,
              _shortRequired - _shortBy,
            ),
          }
          : {}),
        ...(owedUnsaved !== undefined
          ? { unsaved: owedUnsaved }
          : persistErr === undefined
          ? {}
          : {
            unsaved: persistErr
              ? `${PERSIST_REFUSED} ${persistErr.message}`
              : null,
          }),
      });
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
      const rawBody = await readBounded(req, CONTROL_MAX_BODY);
      if (rawBody === null) return err(tooLargeMessage("trigger"), 413);
      const body = JSON.parse(rawBody);
      if (typeof body?.path !== "string" || typeof body?.action !== "string") {
        return err("body must be { path, action, text?, key? }", 400);
      }
      // A trigger under PAUSED time travel cannot do anything. The click
      // really happens in the page, and the action it dispatches is DROPPED
      // by `dispatch.ts` — so the client answers "I clicked it" and `am
      // trigger` printed `{"ok":true}` with exit 0, while the app's log said
      // `time travel is PAUSED — 'counter:increment' was not applied` and the
      // state never moved. `am dispatch` refuses the same situation with a
      // message; the two disagreed about one fact, and the one CLAUDE.md
      // tells agents to use for the observe→act→observe loop was the one that
      // lied. Refuse it HERE, where the answer is known, rather than
      // reporting a success nothing backs.
      const hist = trojan.getTTHistory?.() as { paused?: boolean } | undefined;
      if (hist?.paused === true) {
        return err(
          "time travel is paused — the click would be delivered and its " +
            "action dropped, not applied. Resume time travel (`am timetravel " +
            "resume`) to drive the UI again.",
          409,
        );
      }
      return sendToClient(idx, enc("ui-trigger", body));
    } catch {
      return err("invalid JSON");
    }
  }

  // `snapshot/force` is the same door with the cell-set refusal waived — a
  // separate ROUTE rather than a query string so both transports (HTTP and the
  // unix socket, which carries a path and no URL) reach it identically.
  if (route === "snapshot" || route === "snapshot/force") {
    if (!deps.loadSnapshot) return err("snapshots not available", 501);
    try {
      // Bounded by bytes received. The Content-Length requirement that used
      // to stand here bought nothing: `Number("abc") > MAX` is false, so any
      // unparseable value satisfied both the cap and the presence check.
      if (declaresOverLimit(req, SNAPSHOT_MAX_BODY)) {
        return err(`snapshot too large (max ${SNAPSHOT_MAX_BODY} bytes)`, 413);
      }
      const body = await readBounded(req, SNAPSHOT_MAX_BODY);
      if (body === null) {
        return err(`snapshot too large (max ${SNAPSHOT_MAX_BODY} bytes)`, 413);
      }
      // The SAME shape check the HTTP endpoint makes — its doc comment says
      // "shared by every snapshot door", and this one was not calling it.
      // `JSON.parse` alone accepts `{"counter": 1}`: it loads, and the next
      // dispatch on that cell throws `Cannot create property 'count' on
      // number` far away from the POST that caused it.
      const shape = snapshotShapeError(JSON.parse(body));
      if (shape) return err(shape);
      try {
        deps.loadSnapshot(body, { force: route === "snapshot/force" });
      } catch (e) {
        // A REFUSAL is not "invalid JSON". The catch below used to swallow
        // every throw from `loadSnapshot` under that one word, which is how
        // a load that destroys the state had no other reason to give.
        return err(e instanceof Error ? e.message : String(e));
      }
      // The restore is in memory and on every screen by now, so the reply
      // cannot say "no" — but "loaded" used to leave before the write, and a
      // restore is the one write whose whole point is the disk. Close the
      // window here, and carry a refusal as `unsaved` (the field `am stop`
      // already speaks) so `am snapshot load` can say NOT SAVED and exit 1
      // instead of "loaded" over a store still holding the pre-restore rows.
      const unsaved = await _persistVerdict(trojan);
      return json({ ok: true, ...(unsaved ? { unsaved } : {}) });
    } catch {
      return err("invalid JSON");
    }
  }

  if (route === "tt") {
    if (!deps.onTTCommand) return err("time-travel not active", 501);
    try {
      const body = await readBounded(req, CONTROL_MAX_BODY);
      if (body === null) return err(tooLargeMessage("time-travel"), 413);
      const { cmd, arg } = JSON.parse(body);
      if (!cmd || typeof cmd !== "string") return err("missing cmd field");
      // A CLOSED vocabulary, refused by name. This acked any string, so
      // `am tt puase` answered `{"ok":true}` and paused nothing — while the
      // dispatch route in this same file refuses an unknown method precisely
      // because "ok:true must mean EXECUTED".
      const TT_COMMANDS = ["undo", "redo", "goto", "pause", "resume"];
      if (!TT_COMMANDS.includes(cmd)) {
        return err(
          `unknown time-travel command "${cmd}" — ${TT_COMMANDS.join(", ")}`,
          404,
        );
      }
      if (cmd === "goto") {
        if (typeof arg !== "number" || !Number.isInteger(arg) || arg < 0) {
          return err(
            `goto takes a whole history id from 0, got ${
              JSON.stringify(
                arg,
              )
            }`,
          );
        }
        // AND THE ENTRY HAS TO EXIST. `travelTo` matches by entry ID and
        // returns the state unchanged for a miss ("invalid id — no-op"), so
        // this route answered ok:true for a number that moved nothing — the
        // rule stated ten lines above, about a different command, is that
        // "ok:true must mean EXECUTED". Worse, every word of the surface
        // called this number an INDEX (`am help`, the CLI's own range
        // message, docs/clients/app-manager.md) while the lookup is by id:
        // the two agree only until `resume` truncates or the 2000-entry
        // window rolls, and then the same number silently means a different
        // entry — or none.
        const hist = trojan.getTTHistory?.() as
          | { entries?: { id: number }[] }
          | undefined;
        const ids = hist?.entries?.map((e) => e.id) ?? [];
        if (ids.length > 0 && !ids.includes(arg)) {
          return err(
            `no history entry with id ${arg} — \`am actions\` lists the ids ` +
              `this app currently holds (${
                ids.length > 6
                  ? `${ids.slice(0, 3).join(", ")} … ${
                    ids.slice(-3).join(", ")
                  }`
                  : ids.join(", ")
              }). They are IDS, not positions: the window rolls and \`resume\` ` +
              `truncates, so the two stop matching after any real session.`,
            404,
          );
        }
        const owed = await deps.onTTCommand("goto", arg);
        return json({ ok: true, ...(owed ? { unsaved: owed } : {}) });
      }
      // A jump's stand-in save that did not land (see action-ack.ts).
      const owed = await deps.onTTCommand(cmd);
      return json({ ok: true, ...(owed ? { unsaved: owed } : {}) });
    } catch {
      return err("invalid JSON");
    }
  }

  if (route === "sql") {
    if (!trojan.sqlQuery) return err("SQLite not configured", 501);
    try {
      const body = await readBounded(req, CONTROL_MAX_BODY);
      if (body === null) return err(tooLargeMessage("query"), 413);
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
      // One MORE than the cap, so "there were more" is a fact rather than a
      // guess: exactly `N` rows back is indistinguishable from a table that
      // happens to hold `N`.
      const effectiveQuery = hasLimit
        ? query
        : `${query.trimEnd()}\nLIMIT ${TROJAN_SQL_DEFAULT_LIMIT + 1}`;
      const rows = await trojan.sqlQuery(effectiveQuery);
      // REFUSED, not truncated. The byte cap beside this one answers 413 and
      // says what to do; the row cap injected a LIMIT and said nothing, so
      // `am sql "select * from t"` on a 12,000-row table returned 10,000 rows
      // with exit 0 — and anyone (or any agent) reading that concludes the
      // table holds exactly 10,000. A wrong answer delivered confidently is
      // worse than a refusal.
      if (
        !hasLimit && Array.isArray(rows) &&
        rows.length > TROJAN_SQL_DEFAULT_LIMIT
      ) {
        return err(
          `more than ${TROJAN_SQL_DEFAULT_LIMIT} rows — add your own LIMIT ` +
            `(or a WHERE) so the answer is one you asked for. Silently ` +
            `returning the first ${TROJAN_SQL_DEFAULT_LIMIT} would read as ` +
            `the whole table.`,
          413,
        );
      }
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
    // Awaited: `ok: true` is the claim "it is on disk", so the reply waits
    // for the write — and a refused write is a 500, not a "persisted".
    const unsaved = await _persistVerdict(trojan);
    if (unsaved) return err(unsaved, 500);
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
    // THIS app's PIN (keyed by its key) — never another app's in the process.
    const pin = generatePin(deps.token);
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

/** How a refused write is WORDED on the wire — `persist failed: <reason>`.
 *
 *  `am` reads the verdict by this prefix (`finalPersistVerdict` in
 *  am-cmd-process.ts): a 500 that starts with it is "the cycle reported a
 *  failure"; anything else (404, 501, a dead transport) is "the question
 *  could not be put", which is not data loss and is never reported as it.
 *  One spelling, so the two sides cannot drift — a key in two of three
 *  surfaces is the trap this repo names first. */
export const PERSIST_REFUSED = "persist failed:";

/** Close the debounce window NOW and answer for it: `null` when the write
 *  landed — or when there is no persistence to ask — else the refusal, worded
 *  as {@linkcode PERSIST_REFUSED}. ONE reader of the verdict for every door
 *  that promises the disk (`persist`, `snapshot`): `forcePersist` is the
 *  awaited flush and it rejects with `lastCycleError()` (aio.ts), so this is
 *  the one place a rejection becomes words. */
async function _persistVerdict(
  trojan: TrojanDeps["trojan"],
): Promise<string | null> {
  if (!trojan.forcePersist) return null;
  try {
    await trojan.forcePersist();
    return null;
  } catch (e) {
    return `${PERSIST_REFUSED} ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** The `<cell>:<method>` whose METHOD half is closest to a bare type — a
 *  typo'd or unprefixed name — within two edits; `null` when nothing is. */
export function _nearestMethod(bare: string, all: string[]): string | null {
  const want = bare.toLowerCase();
  let best: { key: string; d: number } | null = null;
  for (const key of all) {
    const m = key.slice(key.indexOf(":") + 1).toLowerCase();
    const d = _editDistance(want, m);
    if (d <= 2 && (best === null || d < best.d)) best = { key, d };
  }
  return best?.key ?? null;
}

function _editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(
        prev[j]! + 1,
        prev[j - 1]! + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = tmp;
    }
  }
  return prev[b.length]!;
}
