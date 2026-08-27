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

import { diagEmit } from "./diagnostic-bus.ts";
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
};

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

/** Record a client's degradation change (server side). Values are capped —
 *  this arrives off the wire. */
export function _recordClientDegraded(
  clientId: string,
  ev: DegradedChange,
): void {
  let entries = _clientRegistry.get(clientId);
  if (!entries) {
    entries = new Map();
    _clientRegistry.set(clientId, entries);
  }
  const name = ev.name.slice(0, NAME_CAP);
  if (ev.kind === "up") {
    entries.delete(name);
    if (entries.size === 0) _clientRegistry.delete(clientId);
    return;
  }
  if (entries.size >= CLIENT_CAP_PER_CLIENT && !entries.has(name)) return;
  entries.set(name, {
    name,
    kind: "down",
    failures: ev.failures,
    since: ev.since,
    lastError: ev.lastError.slice(0, ERROR_CAP),
  });
}

/** A client disconnected — its degradations are no longer live signal. */
export function _clearClientDegraded(clientId: string): void {
  _clientRegistry.delete(clientId);
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
  for (const entries of _clientRegistry.values()) {
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
        "degraded(`fetch:${url}`), creates one tracker per URL and the " +
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
  for (const e of _registry.values()) {
    if (!e.escalated) continue;
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
  _relay = null;
  _capWarned = false;
}
