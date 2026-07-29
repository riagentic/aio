// Patch compaction — deduplicates redundant Immer ops before wire send.
// Only collapses "replace" ops on identical paths (last-write-wins).
// "add"/"remove" ops are never collapsed — order and count matter for arrays.
import type { Patch } from "immer";

/** Resolve `path` in `root`, or undefined if any hop is missing. */
function valueAt(root: unknown, path: readonly (string | number)[]): unknown {
  let cur = root;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return cur;
}

/**
 * Rewrite a whole-array replacement as the edit it actually was.
 *
 * `s.items.push(x)` already patches as one `add`, but the equally idiomatic
 * `s.items = [...s.items, ...batch]` is a `replace` carrying the entire array —
 * so a list that grows to 10k items re-ships all 10k on every commit, and the
 * cost is quadratic over a scan. That is not hypothetical: a hardware-wallet
 * scan had to hand-throttle its own state writes to stay under vitals PRESSURE,
 * and the fix belonged here rather than in every app that rebuilds a list.
 *
 * The same shape covers `filter` and `slice`, which are how lists SHRINK, and
 * an insert or removal in the middle — all of them keep most elements and are
 * described by a common prefix and suffix with a small edit between.
 *
 * Identity (`===`), never equality, decides what "kept" means. Spreading,
 * `filter`, `slice` and `map`-that-returns-the-same-object all preserve it;
 * objects rebuilt from scratch do not, and those correctly fall through as the
 * original `replace`. A wrong guess here corrupts state rather than merely
 * costing bytes, so every ambiguous case keeps the whole-array replacement.
 *
 * Pure; returns a new array only when something changed.
 */
export function narrowArrayPatches(prev: unknown, ops: Patch[]): Patch[] {
  let out: Patch[] | null = null;
  // What each array path holds AS THE OPS APPLY. A batch may carry more than
  // one op for the same path, and every op after the first is relative to its
  // predecessor's RESULT — diffing them all against `prev` appended the same
  // element twice and left the array corrupt. Immer emits one op per path per
  // commit, so neither caller can produce that today; this is a guard on the
  // function's own contract, not on the current callers, because a merged or
  // replayed patch list is an obvious thing to hand it later.
  const current = new Map<string, unknown>();
  // Paths whose base is no longer known: something other than a whole-array
  // replacement moved them, so neither `prev` nor `current` can be trusted.
  const untracked = new Set<string>();

  for (let i = 0; i < ops.length; i++) {
    const p = ops[i]!;
    const key = pathKey(p.path);
    let narrowed: Patch[] | null = null;

    if (p.op === "replace" && Array.isArray(p.value)) {
      // A replacement re-establishes the value, whatever happened before it.
      if (!untracked.has(key)) {
        const base = current.has(key)
          ? current.get(key)
          : valueAt(prev, p.path);
        narrowed = diffArray(base, p.value, p.path);
      }
      current.set(key, p.value);
      untracked.delete(key);
    } else {
      // Anything else — an add, a remove, a scalar write inside an element —
      // changes what the enclosing arrays hold. Give up on every path it could
      // reach: its own, its ancestors, and anything tracked beneath it.
      for (let n = p.path.length; n >= 0; n--) {
        const ancestor = pathKey(p.path.slice(0, n));
        current.delete(ancestor);
        untracked.add(ancestor);
      }
      for (const tracked of [...current.keys()]) {
        if (tracked.startsWith(key + "\0")) {
          current.delete(tracked);
          untracked.add(tracked);
        }
      }
    }

    if (narrowed === null) {
      out?.push(p);
      continue;
    }
    // First rewrite: copy the ops seen so far, then diverge.
    out ??= ops.slice(0, i);
    for (const op of narrowed) out.push(op);
  }
  return out ?? ops;
}

/**
 * The ops that turn `before` into `next`, or null to keep the replacement.
 *
 * Walks both arrays once, matching elements BY IDENTITY. An element that is
 * only in the old array is a removal, one only in the new array is an
 * insertion, and everything else is kept in place — so scattered removals (the
 * usual `filter`) narrow just as well as a contiguous block, which the earlier
 * prefix/suffix-only version could not do: dropping three items from a 500-item
 * list still re-sent all 500.
 *
 * Indices are emitted against the array AS IT EVOLVES (`pos` tracks that), so
 * applying the ops in the order returned reproduces `next` exactly. Two cases
 * bail to the whole-array replacement rather than guess:
 *   • a REORDER — both elements exist on the other side, just moved. Immer's
 *     patch format has no `move`, so expressing it costs a remove plus an add
 *     per element, which is never cheaper than the array itself.
 *   • DUPLICATE identities in either array (including repeated primitives),
 *     where "is this element still needed later" stops having one answer.
 */
function diffArray(
  before: unknown,
  next: unknown[],
  path: readonly (string | number)[],
): Patch[] | null {
  if (!Array.isArray(before)) return null;
  const b = before as unknown[];
  const bSet = new Set(b);
  const nSet = new Set(next);
  if (bSet.size !== b.length || nSet.size !== next.length) return null;

  const outOps: Patch[] = [];
  let removed = 0;
  let added = 0;
  let i = 0; // index in `before`
  let j = 0; // index in `next`
  let pos = 0; // index in the array as the ops apply

  while (i < b.length && j < next.length) {
    if (b[i] === next[j]) {
      i++;
      j++;
      pos++;
    } else if (!nSet.has(b[i])) {
      outOps.push({ op: "remove", path: [...path, pos] });
      removed++;
      i++;
    } else if (!bSet.has(next[j])) {
      outOps.push({ op: "add", path: [...path, pos], value: next[j] });
      added++;
      pos++;
      j++;
    } else {
      return null; // both sides still hold it — a reorder
    }
  }
  for (; i < b.length; i++) {
    outOps.push({ op: "remove", path: [...path, pos] });
    removed++;
  }
  for (; j < next.length; j++, pos++) {
    outOps.push({ op: "add", path: [...path, pos], value: next[j] });
    added++;
  }

  if (removed === 0 && added === 0) return null; // nothing actually moved

  // Cost, not op count: an `add` carries an element, a `remove` carries only an
  // index. Counting them alike declined `items.slice(0, 2)` on a 4-item list —
  // two index-sized removes, rejected as "not cheaper" than re-sending both
  // elements. So the two are weighed separately:
  //   • if the insertions alone carry as much as the whole new array, the
  //     replacement is already the cheaper description;
  //   • and a patch LIST far longer than the array it rebuilds is a loss even
  //     when every op is tiny — truncating 10k items to one should just send
  //     the one, not 9,999 removes.
  if (added >= next.length) return null;
  if (removed + added > next.length + 8) return null;

  return outOps;
}

/** Key for path identity — joined with NUL to avoid ambiguity */
function pathKey(path: (string | number)[]): string {
  return path.join("\0");
}

/**
 * Compact an array of Immer patches by collapsing redundant same-path
 * "replace" operations to last-write-wins. Non-replace ops pass through
 * unchanged. Cross-path ordering is preserved.
 *
 * Returns a new array (never mutates input).
 */
export function compactPatches(ops: Patch[]): Patch[] {
  if (ops.length <= 1) return ops;

  // Find last index of each replace-path — O(n)
  const lastReplace = new Map<string, number>();
  for (let i = 0; i < ops.length; i++) {
    const p = ops[i]!;
    if (p.op === "replace") {
      lastReplace.set(pathKey(p.path), i);
    }
  }

  // No replace ops at all — nothing to compact
  if (lastReplace.size === 0) return ops;

  // Forward pass: keep non-replace ops always, keep replace only if it's the last for its path
  const result: Patch[] = [];
  for (let i = 0; i < ops.length; i++) {
    const p = ops[i]!;
    if (p.op !== "replace") {
      result.push(p);
      continue;
    }
    // Only keep the last replace for this path
    if (lastReplace.get(pathKey(p.path)) === i) {
      result.push(p);
    }
  }

  return result;
}
