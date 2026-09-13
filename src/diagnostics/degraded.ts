// degraded.ts — escalation for subsystems that are ALLOWED to fail.
//
// Every app has corners that degrade by design: a cache that refetches on
// failure, a sync frame that will be retried, a best-effort write. The failure
// mode nobody plans for is the one where such a corner fails FOREVER: each
// occurrence is individually harmless, so it is logged (or swallowed) and the
// app reports itself healthy while a whole feature is dead. one app's nft-cache
// did exactly this — hours of stderr, zero in-app signal — and every app that
// hit it invented its own escalation or had none.
//
// The rule here: a failure that repeats stops being routine. After N
// CONSECUTIVE failures of the same named operation, emit exactly ONE structured
// event — not per-occurrence spam, which is what made the original invisible —
// and one more when it recovers. Everything in between is counted, not logged.

import { _diagScopeNow, diagEmit } from "./diagnostic-bus.ts";
import { log } from "./logger-api.ts";

// Console, not `log` — this module is reachable from the BROWSER bundle (the
// sync engine escalates through it), and the structured logger pulls in
// @std/path for file rotation, which no browser import map provides. The
// browser-deps gate caught that as a blank screen; the escalation is a rare,
// single line either way, and the diagnostic event below is the structured
// half. One sink, both runtimes — no fork.

/** How many consecutive failures make a subsystem "degraded" rather than
 *  "unlucky". Small enough to catch a wedged subsystem early, large enough that
 *  an ordinary retry never trips it. */
const DEFAULT_AFTER = 5;

/** A named best-effort operation being watched for permanent failure. */
export type Degraded = {
  /** Record a failure. Escalates once, on the Nth consecutive one. */
  fail(err: unknown): void;
  /** Record a success — ends the episode (and reports recovery if it had
   *  escalated). Call it on every success, not only the first. */
  ok(): void;
  /** Run `fn`, recording the outcome. Failures resolve to `undefined` — the
   *  caller keeps its best-effort control flow, without the silence. */
  guard<T>(fn: () => T | Promise<T>): Promise<T | undefined>;
  /** Consecutive failures right now. */
  readonly failures: number;
  /** Has this operation escalated and not yet recovered? */
  readonly isDegraded: boolean;
};

type Entry = {
  name: string;
  after: number;
  failures: number;
  escalated: boolean;
  since: number;
  lastError: string;
  /** Last time this tracker was resolved — the eviction order below. */
  touched: number;
  /** The apps whose code failed in this episode (see "Per app" below). */
  scopes: Set<object>;
};

// ── Per app ──────────────────────────────────────────────────────────
// One process can host several apps, and every registry here is one per
// process — so app B's `/health` listed a tracker only app A's code had been
// failing, and a client only A served. The public API cannot change (a name
// is still one tracker, as `degraded()` documents), so each failure and each
// client record remembers WHICH app's code produced it (`_diagScopeNow` — the
// same answer the diagnostic bus and the logger use), and a report asked from
// inside an app shows that app's rows plus the unattributed ones. A report
// asked from outside any app (a test, the browser) still shows everything.

/** Does a row recorded by `scopes` belong in a report asked by `now`? */
function _visibleTo(now: object | undefined, scopes: Set<object>): boolean {
  return now === undefined || scopes.size === 0 || scopes.has(now);
}

/** How many distinct names may be watched at once.
 *
 *  `degraded()` is PUBLIC API and its natural use is per-resource —
 *  ``degraded(`fetch:${url}`)`` — so an uncapped registry is a leak with an
 *  app-controlled key. Every sibling registry in this module already bounds
 *  itself (`_clientRegistry`: 16 per client, names 64 chars, errors 200), and
 *  the diagnostic bus prunes its dedup map; this one did not, in the module
 *  whose whole job is noticing that something has been failing forever. */
const REGISTRY_CAP = 512;

const _registry = new Map<string, Entry>();
/** Said once per episode: a cap that evicts silently is the same defect one
 *  level down from the one this module exists to fix. */
let _capWarned = false;

/** One escalation/recovery event, as relayed across a transport. */
export type DegradedChange = {
  name: string;
  kind: "down" | "up";
  failures: number;
  since: number;
  lastError: string;
};

// ── Cross-runtime relay ──────────────────────────────────────────────
// Each runtime keeps its own registry; a BROWSER escalation is invisible to
// the server's /__aio/health unless it travels. The transport registers a
// sender here (browser-transport-ws), and the server records what arrives in
// the client registry below. Deliberately not the diagnostic bus: that bus is
// dev-only, and a health signal must work identically in prod.
let _relay: ((ev: DegradedChange) => void) | null = null;

/** Point escalation/recovery events at a transport (browser side). Replaces
 *  any previous relay — one live transport per client runtime. */
export function _setDegradedRelay(
  fn: ((ev: DegradedChange) => void) | null,
): void {
  _relay = fn;
}

function relayChange(e: Entry, kind: "down" | "up"): void {
  try {
    _relay?.({
      name: e.name,
      kind,
      failures: e.failures,
      since: e.since,
      lastError: e.lastError,
    });
  } catch { /* transport gone — the next connect re-registers */ }
}

// ── Server-side registry of CLIENT degradations (fed by "cdiag" frames) ──
const CLIENT_CAP_PER_CLIENT = 16;
const NAME_CAP = 64;
const ERROR_CAP = 200;
const _clientRegistry = new Map<string, Map<string, DegradedChange>>();
/** Which app's server recorded each client — see "Per app". */
const _clientScope = new Map<string, object>();

/** Who sent a `cdiag` frame — supplied by the transport that received it
 *  (this module cannot know a socket or a user; `diagnostics` never imports
 *  `server`). */
export type ClientDegradedOrigin = {
  /** The receiving transport — also the log category ("ws", "uds"). */
  transport: string;
  /** The server's client counter, as `am clients` shows it. */
  index: number;
  /** The signed-in user's id; absent for an anonymous or local peer. */
  user?: string;
};

/** Names each client has already been attributed for, so a report is named
 *  once per client per name — not once per frame, and not again after a
 *  recovery. Lives until the client disconnects (`_clearClientDegraded`). */
const _clientSaid = new Map<string, Set<string>>();

/** Record a client's degradation change (server side). THE one definition of
 *  what a `cdiag` frame may claim, for every transport that carries it — WS
 *  and UDS each had their own copy, and only one of them learned the rules
 *  below.
 *
 *  It is a CLIENT's claim, and handled as one. Any connected peer can send it
 *  (the r3 auth hunt forged `failures: 999, lastError: "FORGED by bob"` and
 *  health turned degraded), so:
 *  • malformed frames are dropped, and values are capped — this is off the
 *    wire;
 *  • the numbers are checked — a failure count or start time no client can
 *    truthfully have (negative, fractional, infinite, in the future) is not
 *    stored as fact;
 *  • the report is ATTRIBUTED in the server log, once per client per name, so
 *    a "degraded" on /__aio/health is traceable to the peer that said so. */
export function _recordClientDegraded(
  clientId: string,
  raw: unknown,
  origin: ClientDegradedOrigin,
): void {
  const d = raw as Partial<DegradedChange> | null | undefined;
  if (
    !d || typeof d !== "object" || typeof d.name !== "string" ||
    d.name.length === 0 || (d.kind !== "down" && d.kind !== "up")
  ) return;
  const now = Date.now();
  const f = d.failures, t = d.since;
  const failures = typeof f === "number" && Number.isFinite(f) && f > 0
    ? Math.min(Math.floor(f), Number.MAX_SAFE_INTEGER)
    : 0;
  const since = typeof t === "number" && Number.isFinite(t) && t > 0 &&
      t <= now
    ? t
    : now;
  const lastError = typeof d.lastError === "string"
    ? d.lastError.slice(0, ERROR_CAP)
    : "";
  let entries = _clientRegistry.get(clientId);
  if (!entries) {
    entries = new Map();
    _clientRegistry.set(clientId, entries);
  }
  const scope = _diagScopeNow();
  if (scope !== undefined) _clientScope.set(clientId, scope);
  const name = d.name.slice(0, NAME_CAP);
  if (d.kind === "up") {
    entries.delete(name);
    if (entries.size === 0) {
      _clientRegistry.delete(clientId);
      _clientScope.delete(clientId);
    }
    return;
  }
  if (entries.size >= CLIENT_CAP_PER_CLIENT && !entries.has(name)) return;
  entries.set(name, { name, kind: "down", failures, since, lastError });
  let said = _clientSaid.get(clientId);
  if (!said) _clientSaid.set(clientId, said = new Set());
  // Capped like the registry: once the peer has been named for 16 names it
  // is identified, and a peer cycling names cannot grow this set.
  if (said.has(name) || said.size >= CLIENT_CAP_PER_CLIENT) return;
  said.add(name);
  log.warn(
    origin.transport,
    `client #${origin.index} over ${origin.transport} (${
      origin.user !== undefined ? `user=${origin.user}` : "anonymous"
    }) reports its "${name}" degraded (${failures} failures): ${
      JSON.stringify(lastError)
    } — a CLIENT's report (cdiag), shown on /__aio/health under ` +
      `clientDegraded until it recovers or disconnects`,
  );
}

/** A client disconnected — its degradations are no longer live signal. */
export function _clearClientDegraded(clientId: string): void {
  _clientRegistry.delete(clientId);
  _clientScope.delete(clientId);
  _clientSaid.delete(clientId);
}

/** Aggregated client-side degradations for health output: one row per
 *  operation name, with how many connected clients report it. */
export function clientDegradedReport(): {
  name: string;
  clients: number;
  failures: number;
  lastError: string;
}[] {
  const byName = new Map<
    string,
    { name: string; clients: number; failures: number; lastError: string }
  >();
  const now = _diagScopeNow();
  for (const [clientId, entries] of _clientRegistry) {
    const scope = _clientScope.get(clientId);
    if (now !== undefined && scope !== undefined && scope !== now) continue;
    for (const ev of entries.values()) {
      const row = byName.get(ev.name);
      if (row) {
        row.clients++;
        row.failures = Math.max(row.failures, ev.failures);
        row.lastError = ev.lastError || row.lastError;
      } else {
        byName.set(ev.name, {
          name: ev.name,
          clients: 1,
          failures: ev.failures,
          lastError: ev.lastError,
        });
      }
    }
  }
  return [...byName.values()];
}

/** Make room for one more name. Least-recently-used first, and an operation
 *  currently IN a degraded episode is live signal — evicted only when there is
 *  nothing else left to drop. */
function _evictForNewName(incoming: string): void {
  if (_registry.size < REGISTRY_CAP) return;
  let victim: Entry | undefined;
  for (const e of _registry.values()) {
    if (victim === undefined) {
      victim = e;
      continue;
    }
    // Prefer a non-escalated entry; among equals, the oldest touch.
    if (victim.escalated !== e.escalated) {
      if (victim.escalated) victim = e;
      continue;
    }
    if (e.touched < victim.touched) victim = e;
  }
  if (!victim) return;
  _registry.delete(victim.name);
  if (!_capWarned) {
    _capWarned = true;
    log.warn(
      `[aio] degraded(): more than ${REGISTRY_CAP} distinct names are being ` +
        `watched at once — evicting the least recently used ("${victim.name}"` +
        `${victim.escalated ? ", which was still degraded" : ""}) to make ` +
        `room for "${incoming}". Cause: a name built per resource, e.g. ` +
        "degraded(`fetch:${url}`), creates one tracker per URL and the " + // aio-ok: example code shown TO the user, quoted as they would write it
        `registry is what remembers "this has been failing for hours". ` +
        `Fix: use a stable name — degraded("fetch") — and put the resource ` +
        `in the error passed to fail(), which is what the report shows.`,
    );
  }
}

/** Watch a best-effort operation. Same name ⇒ same tracker, so a module-level
 *  `const cache = degraded("nft-cache")` and a per-call lookup agree.
 *
 *  ```ts
 *  const cache = degraded("nft-cache");
 *  const hit = await cache.guard(() => db.query(sql));   // undefined on failure
 *  ```
 */
export function degraded(
  name: string,
  opts: { after?: number } = {},
): Degraded {
  const after = Math.max(1, opts.after ?? DEFAULT_AFTER);
  // Capped like the client-side twin: the KEY too, not just the reported
  // field — an uncapped key is an uncapped allocation, and `degraded()` names
  // come from app code. Two names identical for their first 64 characters
  // share a tracker, which is the right trade for a vocabulary that is
  // supposed to be small and fixed.
  const key = name.slice(0, NAME_CAP);
  // Resolved PER CALL, not captured: a handle held across `_resetDegraded()`
  // (test teardown) must re-register instead of counting on an orphaned entry
  // the report can no longer see.
  const resolve = (): Entry => {
    let entry = _registry.get(key);
    if (!entry) {
      _evictForNewName(key);
      entry = {
        name: key,
        after,
        failures: 0,
        escalated: false,
        since: 0,
        lastError: "",
        touched: Date.now(),
        scopes: new Set(),
      };
      _registry.set(key, entry);
    } else {
      entry.touched = Date.now();
    }
    return entry;
  };
  const first = resolve();
  if (opts.after !== undefined && first.after !== after) {
    // Two sites watching one name with different thresholds would silently
    // race for whichever registered first — in the module whose whole point
    // is that nothing diverges silently.
    log.warn(
      `[aio] degraded("${key}"): after=${after} requested, but this name ` +
        `was created with after=${first.after} — keeping ${first.after}. ` +
        `Use one threshold per name.`,
    );
  }

  const fail = (err: unknown): void => {
    const e = resolve();
    e.lastError = (err instanceof Error ? err.message : String(err))
      .slice(0, ERROR_CAP);
    if (e.failures === 0) e.since = Date.now();
    e.failures++;
    const scope = _diagScopeNow();
    if (scope !== undefined) e.scopes.add(scope);
    if (e.escalated || e.failures < e.after) return;
    e.escalated = true;
    const msg = `${key}: degraded — ${e.failures} consecutive failures, ` +
      `last: ${e.lastError}. This operation is best-effort, so each failure ` +
      `alone is survivable; repeating means the feature behind it is off.`;
    log.error(`[aio] ${msg}`);
    diagEmit({
      // Per-subsystem type: the bus dedups by TYPE, so a shared "degraded" key
      // would let one wedged subsystem hide another's escalation.
      type: `degraded:${key}`,
      severity: "error",
      source: key,
      message: msg,
      detail: { failures: e.failures, since: e.since, lastError: e.lastError },
      hint: "Fix the underlying cause, or stop treating this path as optional.",
    });
    relayChange(e, "down");
  };

  const ok = (): void => {
    const e = resolve();
    if (e.escalated) {
      const held = Date.now() - e.since;
      log.info(
        `[aio] ${key}: recovered after ${e.failures} failures (${held}ms)`,
      );
      diagEmit({
        type: `degraded-recovered:${key}`,
        severity: "info",
        source: key,
        message: `${key}: recovered after ${e.failures} failures`,
        detail: { failures: e.failures, durationMs: held },
      });
      relayChange(e, "up");
    }
    e.failures = 0;
    e.escalated = false;
    e.lastError = "";
    e.scopes.clear();
  };

  return {
    fail,
    ok,
    async guard<T>(fn: () => T | Promise<T>): Promise<T | undefined> {
      try {
        const v = await fn();
        ok();
        return v;
      } catch (err) {
        fail(err);
        return undefined;
      }
    },
    get failures() {
      return resolve().failures;
    },
    get isDegraded() {
      return resolve().escalated;
    },
  };
}

/** One line per operation currently in a degraded episode — for health output,
 *  `am`, and tests. An app that looks healthy while a subsystem is dead is the
 *  thing this whole module exists to prevent, so it must be inspectable. */
export function degradedReport(): {
  name: string;
  failures: number;
  since: number;
  lastError: string;
}[] {
  const out = [];
  const now = _diagScopeNow();
  for (const e of _registry.values()) {
    if (!e.escalated || !_visibleTo(now, e.scopes)) continue;
    out.push({
      name: e.name,
      failures: e.failures,
      since: e.since,
      lastError: e.lastError,
    });
  }
  return out;
}

/** Test hook: how many trackers are live right now. A long-running server
 *  must not accumulate one per resource ever touched. */
export function _degradedRegistrySize(): number {
  return _registry.size;
}

/** Test isolation — drop every tracker, relay, and client record. */
export function _resetDegraded(): void {
  _registry.clear();
  _clientRegistry.clear();
  _clientScope.clear();
  _clientSaid.clear();
  _relay = null;
  _capWarned = false;
}
