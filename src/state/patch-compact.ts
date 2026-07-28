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
 * Rewrite whole-array replacements as appends when the array only GREW.
 *
 * `s.items.push(x)` already patches as one `add`, but the equally idiomatic
 * `s.items = [...s.items, ...batch]` is a `replace` carrying the entire array —
 * so a list that grows to 10k items re-ships all 10k on every commit, and the
 * cost is quadratic over a scan. That is not hypothetical: a hardware-wallet
 * scan had to hand-throttle its own state writes to stay under vitals PRESSURE,
 * and the fix belonged here rather than in every app that appends to a list.
 *
 * Only the unambiguous case is touched: the previous array is a prefix of the
 * new one BY IDENTITY (`===` per element, which spread preserves), and the tail
 * is smaller than the prefix it saves re-sending. Anything else — a reorder, an
 * in-place edit, a shrink, a fresh array of equal-looking objects — falls
 * through as the original `replace`, because a wrong guess here corrupts state
 * rather than merely costing bytes.
 *
 * Pure; returns a new array only when something changed.
 */
export function narrowArrayAppends(prev: unknown, ops: Patch[]): Patch[] {
  let out: Patch[] | null = null;
  for (let i = 0; i < ops.length; i++) {
    const p = ops[i]!;
    const appended = p.op === "replace" && Array.isArray(p.value)
      ? appendsOf(valueAt(prev, p.path), p.value)
      : null;
    if (appended === null) {
      out?.push(p);
      continue;
    }
    // First rewrite: copy the ops seen so far, then diverge.
    out ??= ops.slice(0, i);
    const from = (p.value as unknown[]).length - appended.length;
    for (let k = 0; k < appended.length; k++) {
      out.push({ op: "add", path: [...p.path, from + k], value: appended[k] });
    }
  }
  return out ?? ops;
}

/** The appended tail, or null if `next` is not `before` plus a cheaper tail. */
function appendsOf(before: unknown, next: unknown[]): unknown[] | null {
  if (!Array.isArray(before)) return null;
  const added = next.length - before.length;
  // Must have grown, and the appends must be cheaper than the array they
  // replace — appending 900 items to 10 is not worth 900 separate ops.
  if (added <= 0 || added >= before.length) return null;
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== next[i]) return null;
  }
  return next.slice(before.length);
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
