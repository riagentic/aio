// Patch compaction — deduplicates redundant Immer ops before wire send.
// Only collapses "replace" ops on identical paths (last-write-wins).
// "add"/"remove" ops are never collapsed — order and count matter for arrays.
import type { Patch } from "immer";

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
