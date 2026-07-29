// degraded.ts — escalation for subsystems that are ALLOWED to fail.
//
// Every app has corners that degrade by design: a cache that refetches on
// failure, a sync frame that will be retried, a best-effort write. The failure
// mode nobody plans for is the one where such a corner fails FOREVER: each
// occurrence is individually harmless, so it is logged (or swallowed) and the
// app reports itself healthy while a whole feature is dead. risoto's nft-cache
// did exactly this — hours of stderr, zero in-app signal — and every app that
// hit it invented its own escalation or had none.
//
// The rule here: a failure that repeats stops being routine. After N
// CONSECUTIVE failures of the same named operation, emit exactly ONE structured
// event — not per-occurrence spam, which is what made the original invisible —
// and one more when it recovers. Everything in between is counted, not logged.

import { diagEmit } from "./diagnostic-bus.ts";

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
};

const _registry = new Map<string, Entry>();

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
  let entry = _registry.get(name);
  if (!entry) {
    entry = {
      name,
      after,
      failures: 0,
      escalated: false,
      since: 0,
      lastError: "",
    };
    _registry.set(name, entry);
  }
  const e = entry;

  const fail = (err: unknown): void => {
    e.lastError = err instanceof Error ? err.message : String(err);
    if (e.failures === 0) e.since = Date.now();
    e.failures++;
    if (e.escalated || e.failures < e.after) return;
    e.escalated = true;
    const msg = `${name}: degraded — ${e.failures} consecutive failures, ` +
      `last: ${e.lastError}. This operation is best-effort, so each failure ` +
      `alone is survivable; repeating means the feature behind it is off.`;
    console.error(`[aio] ${msg}`);
    diagEmit({
      // Per-subsystem type: the bus dedups by TYPE, so a shared "degraded" key
      // would let one wedged subsystem hide another's escalation.
      type: `degraded:${name}`,
      severity: "error",
      source: name,
      message: msg,
      detail: { failures: e.failures, since: e.since, lastError: e.lastError },
      hint: "Fix the underlying cause, or stop treating this path as optional.",
    });
  };

  const ok = (): void => {
    if (e.escalated) {
      const held = Date.now() - e.since;
      console.info(
        `[aio] ${name}: recovered after ${e.failures} failures (${held}ms)`,
      );
      diagEmit({
        type: `degraded-recovered:${name}`,
        severity: "info",
        source: name,
        message: `${name}: recovered after ${e.failures} failures`,
        detail: { failures: e.failures, durationMs: held },
      });
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
      return e.failures;
    },
    get isDegraded() {
      return e.escalated;
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

/** Test isolation — drop every tracker. */
export function _resetDegraded(): void {
  _registry.clear();
}
