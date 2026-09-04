// In-memory dispatch timeline.
//
// A bounded ring of the most recent committed, state-changing dispatches, each
// with the compact state diff it produced. This is the live "what just
// happened + what it changed" view behind `am timeline`; the durable crash-
// recovery log is the separate journal (journal.ts), which stores actions only.
//
// Always-on and cheap: the diff is computed once at record time using Immer's
// structural sharing — unchanged subtrees are reference-equal, so recursion
// prunes at the first `===`, making the cost proportional to what actually
// changed (usually a handful of leaves), not to state size. Only the compact
// diff is retained, so `prev`/`next` are free to GC — memory stays bounded to
// the ring capacity regardless of state size.

import {
  isRedactedAction,
  noRedaction,
  REDACTED,
} from "../diagnostics/redact.ts";
import type { Redactor } from "../diagnostics/redact.ts";

/** One changed leaf: a dotted path and its before/after values. */
export type DiffEntry = { path: string; before: unknown; after: unknown };

/** One recorded dispatch. `seq` matches the journal seq when journaling is on. */
export type TimelineEntry = {
  seq: number;
  ts: number;
  type: string;
  payload?: unknown;
  diff: DiffEntry[];
  /** For a write-set commit (`cell:__setFoo`), the action that produced it
   *  (`cell:foo`). `type` stays the action that really ran — a timeline that
   *  renames what happened is a timeline that lies — and `origin` says who is
   *  responsible for it, so `am timeline` can show "the async method `foo`
   *  wrote this" instead of an opaque framework symbol. */
  origin?: string;
};

/** Safety caps so a pathological action (e.g. replacing a 10k-row array) can't
 *  produce an unbounded diff or run away recursing. Truncation is flagged. */
const MAX_DIFF_ENTRIES = 200;
const MAX_DEPTH = 12;

/** A container the diff may RECURSE into: a plain object (or a null-prototype
 *  one). Anything else with `typeof === "object"` — Date, Map, Set, RegExp, a
 *  class instance — is a LEAF.
 *
 *  This is not a nicety. `Object.keys(new Date())` is `[]`, so treating every
 *  object as a plain container made the walker descend into a changed Date,
 *  find no keys, and emit NOTHING: `am timeline` reported `"diff": []` for an
 *  action that moved a timestamp. Silence is the one output a diff must never
 *  produce for a real change, so an un-traversable object is reported whole. */
const isPlainObj = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== "object" || v === null) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
};

/** Compute the compact leaf-diff between two immutable states. Relies on
 *  reference equality (Immer structural sharing) to skip unchanged subtrees.
 *  Result is capped at MAX_DIFF_ENTRIES; a final `{path:"…", …}` marker is
 *  appended when truncated so callers never mistake a cap for completeness. */
export function diffState(prev: unknown, next: unknown): DiffEntry[] {
  const out: DiffEntry[] = [];
  let truncated = false;

  const walk = (a: unknown, b: unknown, path: string, depth: number): void => {
    if (a === b) return; // structural-sharing fast path — whole subtree unchanged
    if (out.length >= MAX_DIFF_ENTRIES) {
      truncated = true;
      return;
    }
    // Recurse only when BOTH sides are same-kind TRAVERSABLE containers;
    // otherwise it's a leaf change (type changes, null↔object, array↔object,
    // and every non-plain object — Date, Map, Set, class instances).
    const bothArr = Array.isArray(a) && Array.isArray(b);
    const bothObj = !bothArr && isPlainObj(a) && isPlainObj(b);
    if (depth < MAX_DEPTH && (bothArr || bothObj)) {
      const keys = new Set<string>([
        ...Object.keys(a as object),
        ...Object.keys(b as object),
      ]);
      for (const k of keys) {
        if (out.length >= MAX_DIFF_ENTRIES) {
          truncated = true;
          break;
        }
        walk(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
          path ? `${path}.${k}` : k,
          depth + 1,
        );
      }
      return;
    }
    out.push({ path, before: a, after: b });
  };

  walk(prev, next, "", 0);
  if (truncated) {
    out.push({
      path: "…",
      before: `(diff truncated at ${MAX_DIFF_ENTRIES} changes)`,
      after: undefined,
    });
  }
  return out;
}

/** A bounded dispatch timeline. */
export type Timeline = {
  /** Record a committed, state-changing dispatch. Computes + stores its diff. */
  record(
    seq: number,
    type: string,
    payload: unknown,
    prev: unknown,
    next: unknown,
    ts: number,
    /** Originating action type, for a write-set commit. Redaction honours it. */
    origin?: string,
  ): void;
  /** Entries with seq > `after` (default all), newest last, capped at `limit`. */
  entries(after?: number, limit?: number): TimelineEntry[];
  /** Highest seq recorded (0 if empty) — for a self-sequencing counter. */
  lastSeq(): number;
  /** Drop everything (test isolation / manual reset). */
  clear(): void;
  /** Current retained count. */
  size(): number;
};

/** Create a ring-buffer timeline holding the last `cap` dispatches.
 *
 *  `redact` is the SAME predicate the journal and action log use (built once at
 *  boot by `makeRedactor`). A redacted action still occupies its slot — seq,
 *  type, timestamp and the *paths* it changed are all kept, so the timeline
 *  still answers "what happened and what did it touch" — but no value it
 *  carried is retained: not the payload, and not the before/after of the state
 *  it wrote. Redacting the payload alone would have been theatre here: an
 *  `unlock` that stores its passphrase leaves the same secret in the diff, in
 *  the same ring, reachable by the same `am timeline`. */
/** How many dispatches the live ring retains. Named because a READER has to be
 *  able to say "this is the whole ring, not the whole history": `am timeline
 *  --lines=20000` can only ever be answered with the last {@linkcode
 *  TIMELINE_RING} of them, and silently returning 500 rows to a request for
 *  20000 is indistinguishable from "there were only 500". */
export const TIMELINE_RING = 500;

export function createTimeline(
  cap = TIMELINE_RING,
  redact: Redactor = noRedaction,
): Timeline {
  let ring: TimelineEntry[] = [];
  let last = 0;

  return {
    record(seq, type, payload, prev, next, ts, origin) {
      last = Math.max(last, seq);
      const hide = isRedactedAction(redact, type, origin);
      const diff = diffState(prev, next);
      // A redacted CELL's values, not just a redacted ACTION's. `hide` was
      // decided per action, so the obvious companion method leaked what the
      // redacted one stored: `unlockWith(secret)` is redacted and `lock()` is
      // not, and `lock()`'s diff printed `before: "hunter2-SUPERSECRET"` in
      // cleartext to `am timeline` and the `tt`/`diag` frames. `unlock`/`lock`
      // is the canonical pair, so that is the DEFAULT shape of the leak.
      //
      // The two sibling sinks already withhold by cell for exactly this reason
      // (`checkpoint.ts`'s `_redactCheckpointState`, and the state-diff in
      // `diagnostics/mod.ts`), and this file's own header promises the
      // stronger thing: "no value it carried is retained: not the payload, and
      // not the before/after of the state it wrote".
      const hidePath = (path: string): boolean => {
        if (hide) return true;
        const dot = path.indexOf(".");
        return redact.cells.has(dot === -1 ? path : path.slice(0, dot));
      };
      ring.push({
        seq,
        ts,
        type,
        ...(origin !== undefined ? { origin } : {}),
        payload: hide ? REDACTED : payload,
        diff: redact.cells.size === 0 && !hide
          ? diff
          : diff.map((d) =>
            hidePath(d.path)
              ? { path: d.path, before: REDACTED, after: REDACTED }
              : d
          ),
      });
      if (ring.length > cap) ring = ring.slice(ring.length - cap);
    },
    entries(after = -Infinity, limit = Infinity) {
      const sel = ring.filter((e) => e.seq > after);
      return limit === Infinity || sel.length <= limit
        ? sel
        : sel.slice(sel.length - limit);
    },
    lastSeq() {
      return last;
    },
    clear() {
      ring = [];
      last = 0;
    },
    size() {
      return ring.length;
    },
  };
}
