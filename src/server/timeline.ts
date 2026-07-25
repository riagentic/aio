// In-memory dispatch timeline (risoto #4 — time travel).
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

/** One changed leaf: a dotted path and its before/after values. */
export type DiffEntry = { path: string; before: unknown; after: unknown };

/** One recorded dispatch. `seq` matches the journal seq when journaling is on. */
export type TimelineEntry = {
  seq: number;
  ts: number;
  type: string;
  payload?: unknown;
  diff: DiffEntry[];
};

/** Safety caps so a pathological action (e.g. replacing a 10k-row array) can't
 *  produce an unbounded diff or run away recursing. Truncation is flagged. */
const MAX_DIFF_ENTRIES = 200;
const MAX_DEPTH = 12;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

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
    // Recurse only when BOTH sides are same-kind containers; otherwise it's a
    // leaf change (including type changes, null↔object, array↔object).
    const bothArr = Array.isArray(a) && Array.isArray(b);
    const bothObj = !bothArr && isObj(a) && isObj(b) && !Array.isArray(a) &&
      !Array.isArray(b);
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

/** Create a ring-buffer timeline holding the last `cap` dispatches. */
export function createTimeline(cap = 500): Timeline {
  let ring: TimelineEntry[] = [];
  let last = 0;

  return {
    record(seq, type, payload, prev, next, ts) {
      last = Math.max(last, seq);
      ring.push({ seq, ts, type, payload, diff: diffState(prev, next) });
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
