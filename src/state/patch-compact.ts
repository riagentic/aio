// Patch compaction — drops Immer ops a later whole-value `replace` overwrites,
// before wire send. That covers same-path last-write-wins AND any op under a
// path replaced wholesale further down the list (see compactPatches: the second
// half is correctness, not thrift — without it the emitted list could fail to
// apply on the client at all).
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

  /** Is `p` a strict descendant of `ancestor`? The root key is `""`, which a
   *  bare prefix test can never match (`"" + NUL` prefixes nothing). */
  const isUnder = (p: string, ancestor: string): boolean =>
    ancestor.length === 0 ? p.length > 0 : p.startsWith(ancestor + "\0");

  // The base a later op at `path` diffs against: the value the PREVIOUS ops in
  // this batch left there. An op invalidates its whole neighborhood — its own
  // path, every ancestor, every descendant — so trust is decided by the
  // NEAREST marked ancestor-or-self: an `untracked` mark means unknown, a
  // `current` entry means resolve inside that (re-established) value, and only
  // a path with no marks anywhere above it may fall back to `prev`.
  const NOT_TRUSTED = Symbol();
  const baseFor = (
    key: string,
    path: readonly (string | number)[],
  ): unknown => {
    if (untracked.has(key)) return NOT_TRUSTED;
    if (current.has(key)) return current.get(key);
    for (let n = path.length - 1; n >= 0; n--) {
      const ak = pathKey(path.slice(0, n));
      if (untracked.has(ak)) return NOT_TRUSTED;
      if (current.has(ak)) return valueAt(current.get(ak), path.slice(n));
    }
    return valueAt(prev, path);
  };

  for (let i = 0; i < ops.length; i++) {
    const p = ops[i]!;
    const key = pathKey(p.path);
    let narrowed: Patch[] | null = null;

    if (p.op === "replace" && Array.isArray(p.value)) {
      // A replacement re-establishes the value, whatever happened before it.
      const base = baseFor(key, p.path);
      if (base !== NOT_TRUSTED) narrowed = diffArray(base, p.value, p.path);
      // Its ancestors now hold a different array…
      for (let n = p.path.length - 1; n >= 0; n--) {
        const ancestor = pathKey(p.path.slice(0, n));
        current.delete(ancestor);
        untracked.add(ancestor);
      }
      // …and the subtree below it IS the new value: stale per-descendant marks
      // of either kind would only shadow it, so they are cleared, not added —
      // `baseFor` resolves descendants inside this entry from here on.
      for (const t of [...current.keys()]) {
        if (isUnder(t, key)) current.delete(t);
      }
      for (const t of [...untracked]) {
        if (isUnder(t, key)) untracked.delete(t);
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
        if (isUnder(tracked, key)) {
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

  // Cost, not op count: an `add` carries an element, a `remove` carries only an
  // index. Counting them alike declined `items.slice(0, 2)` on a 4-item list —
  // two index-sized removes, rejected as "not cheaper" than re-sending both
  // elements. So the two are weighed separately:
  //   • if the insertions alone carry as much as the whole new array, the
  //     replacement is already the cheaper description;
  //   • and a patch LIST far longer than the array it rebuilds is a loss even
  //     when every op is tiny — truncating 10k items to one should just send
  //     the one, not 9,999 removes.
  // Checked as the ops accrue, so a hopeless diff (those 9,999 removes) bails
  // before materializing its op list, not after.
  const overBudget = () =>
    added >= next.length || removed + added > next.length + 8;

  while (i < b.length && j < next.length) {
    if (b[i] === next[j]) {
      i++;
      j++;
      pos++;
    } else if (!nSet.has(b[i])) {
      outOps.push({ op: "remove", path: [...path, pos] });
      removed++;
      i++;
      if (overBudget()) return null;
    } else if (!bSet.has(next[j])) {
      outOps.push({ op: "add", path: [...path, pos], value: next[j] });
      added++;
      pos++;
      j++;
      if (overBudget()) return null;
    } else {
      return null; // both sides still hold it — a reorder
    }
  }
  for (; i < b.length; i++) {
    outOps.push({ op: "remove", path: [...path, pos] });
    removed++;
    if (overBudget()) return null;
  }
  for (; j < next.length; j++, pos++) {
    outOps.push({ op: "add", path: [...path, pos], value: next[j] });
    added++;
    if (overBudget()) return null;
  }

  if (removed === 0 && added === 0) return null; // nothing actually moved

  return outOps;
}

/** Key for path identity — joined with NUL to avoid ambiguity */
function pathKey(path: (string | number)[]): string {
  return path.join("\0");
}

/**
 * Compact an array of Immer patches: drop every op whose effect a LATER
 * whole-value `replace` overwrites. Cross-path ordering is preserved.
 *
 * The rule is one sentence — an op is redundant iff some later op replaces the
 * path it writes to, or any ANCESTOR of that path — and both halves are
 * load-bearing:
 *
 *   • same path: classic last-write-wins for repeated `replace`s;
 *   • ancestor: `replace ["items"]` later in the list supersedes an earlier
 *     `add ["items", 0]`, `remove ["items", 2]` or `replace ["items",0,"tag"]`,
 *     because the whole array is about to be overwritten.
 *
 * The ancestor half is not an optimization, it is CORRECTNESS. This function
 * used to drop only same-path replaces and pass everything else through, which
 * could emit a patch list that does not apply at all: coalescing three
 * dispatches (`s.items = […]`, `s.items[0].tag = 7`, `s.items = […]` — ordinary
 * app code, and the broadcast is throttled so they travel as ONE frame)
 * produced `replace items` / `replace items[0].tag` / `replace items`. Dropping
 * the first replace left the middle op pointing into an array the client's base
 * did not have, so Immer threw "Cannot apply patch, path doesn't resolve", the
 * client discarded the entire frame and had to be resynced with a full state.
 * Found by tests/wire-patch-differential.test.ts.
 *
 * Note the direction: only ops BEFORE the replace are dropped. An op after it
 * writes into the value the replace just installed and is never redundant.
 *
 * POSITION is the other half of the rule, and it is correctness too. `add` and
 * `remove` do not merely write a slot, they RENUMBER every sibling after it. So
 * two things a purely path-based supersede got wrong, both silently:
 *
 *   • a later `replace` at the SAME path never cancels an `add`/`remove` at
 *     that path — it overwrites one slot and leaves the shift undone. Dropping
 *     the `remove` from `remove items[0]` + `replace items[0]` yields a list
 *     that applies CLEANLY to an array one element too long;
 *   • an `add`/`remove` sitting BETWEEN an op and the replace meant to
 *     supersede it moves the path the replace lands on, so the replace no
 *     longer overwrites what that op wrote.
 *
 * Both are reachable from ordinary app code, because the broadcast is throttled
 * and coalesces several dispatches into one frame: `s.items = s.items.filter(…)`
 * (narrowed to a `remove`) followed by `s.items[0] = x` (a `replace`) is all it
 * takes. Neither side notices — the client just keeps the deleted row.
 *
 * Returns a new array (never mutates input).
 */
export function compactPatches(ops: Patch[]): Patch[] {
  if (ops.length <= 1) return ops;

  // Last index at which each path is replaced wholesale — O(n).
  const lastReplace = new Map<string, number>();
  for (let i = 0; i < ops.length; i++) {
    const p = ops[i]!;
    if (p.op === "replace") lastReplace.set(pathKey(p.path), i);
  }

  // No replace ops at all — nothing can be superseded.
  if (lastReplace.size === 0) return ops;

  // Index-shifting ops, ascending. Each renumbers the SIBLINGS of its own path,
  // i.e. the children of `parent`, from `parentLen` deep.
  const shifts: { at: number; parent: string; parentLen: number }[] = [];
  for (let i = 0; i < ops.length; i++) {
    const p = ops[i]!;
    if (p.op === "add" || p.op === "remove") {
      shifts.push({
        at: i,
        parent: pathKey(p.path.slice(0, -1) as (string | number)[]),
        parentLen: p.path.length - 1,
      });
    }
  }

  /** Is `path` renumbered by anything strictly between ops `i` and `j`, so the
   *  replace at `j` no longer lands where the op at `i` wrote? A shift INSIDE
   *  `path` does not count — that subtree is about to be overwritten wholesale;
   *  only a shift in an array `path` indexes THROUGH moves `path` itself. */
  const movedBetween = (
    i: number,
    j: number,
    path: readonly (string | number)[],
  ): boolean => {
    for (const s of shifts) {
      if (s.at <= i) continue;
      if (s.at >= j) break;
      if (s.parentLen >= path.length) continue;
      if (typeof path[s.parentLen] !== "number") continue;
      if (
        pathKey(path.slice(0, s.parentLen) as (string | number)[]) === s.parent
      ) {
        return true;
      }
    }
    return false;
  };

  /** Is op `i` overwritten by a later replace at its path or an ancestor? */
  const superseded = (i: number, p: Patch): boolean => {
    const path = p.path as (string | number)[];
    // Same path — last-write-wins, but only between POSITIONAL ops. An
    // `add`/`remove` here is a shift the later replace does not undo.
    if (p.op === "replace") {
      const at = lastReplace.get(pathKey(path));
      if (at !== undefined && at > i && !movedBetween(i, at, path)) return true;
    }
    // Strict ancestor — the whole value above this op is replaced later.
    for (let n = path.length - 1; n >= 0; n--) {
      const anc = path.slice(0, n);
      const at = lastReplace.get(pathKey(anc));
      if (at !== undefined && at > i && !movedBetween(i, at, anc)) return true;
    }
    return false;
  };

  const result: Patch[] = [];
  for (let i = 0; i < ops.length; i++) {
    const p = ops[i]!;
    if (!superseded(i, p)) result.push(p);
  }

  return result;
}
