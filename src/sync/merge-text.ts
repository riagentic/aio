// Three-way text merge — the `merge: { field: "text" }` strategy.
//
// Until alpha72 every string field was `lww`: two people editing the same note
// and one of them loses the whole thing, silently, because the field is one
// value and one value has one winner. That is correct LWW behaviour and it is
// the wrong ANSWER for prose — a description, a note, a README, a comment —
// where the two edits are usually in different places and both should survive.
//
// WHAT THIS IS. A diff3: the base (the last state both sides agreed on), the
// local text and the remote text. Hunks that touch disjoint regions of the base
// are BOTH applied. Hunks that overlap are a real conflict — resolved by HLC,
// exactly like `lww`, and REPORTED, so `onConflict` fires and the app can tell
// someone. Never a silent loss and never a mangled hybrid.
//
// WHAT THIS IS NOT. Not a sequence CRDT (RGA, Yjs, Automerge). Those keep
// per-character identity and metadata that outlives the characters, which buys
// convergence under arbitrary concurrency and costs a different storage model
// than aio's one-value-per-field state. A diff3 over the agreed base is
// convergent for the case that actually happens — edits from a small number of
// peers, arriving in some order, against a base both have seen — and honest
// about the case that does not: it says "conflict" instead of guessing.
//
// If your app is a shared code editor with twelve simultaneous cursors, use a
// sequence CRDT in a `visible: false` field and let aio sync its update blobs.
// This strategy is for the note field on a record.
import type { HLC } from "./types.ts";
import { compareHLC } from "./hlc.ts";

/** The result shape shared with the other strategies. */
export interface TextMergeResult {
  value: string;
  conflict: boolean;
}

/** Above this many tokens per side, an O(n·m) diff is not worth its own cost:
 *  a 200 KB note is not being co-edited character by character, and a
 *  quadratic table on it would stall the merge. Falls back to LWW, reported as
 *  a conflict, which is exactly what `lww` would have done anyway. */
export const MAX_TOKENS = 4000;

/** Split text the way a human edits it.
 *
 *  Lines when there ARE lines: prose and documents are edited a paragraph at a
 *  time, and two people appending different paragraphs must both survive.
 *  Characters when there are none: a one-line field (a title, a name) has no
 *  line structure to exploit, and character granularity is what makes
 *  "Frist Post" → "First Post" merge with someone else's appended "!". */
export function tokenize(s: string): string[] {
  if (s.includes("\n")) {
    // Keep the newline ON its line, so joining is exact and a trailing newline
    // is preserved rather than invented.
    const out = s.split("\n");
    return out.map((l, i) => (i === out.length - 1 ? l : l + "\n"))
      .filter((l, i) => !(i === out.length - 1 && l === ""));
  }
  return [...s];
}

/** Longest common subsequence, as pairs of matched indices.
 *
 *  Classic O(n·m) table. Bounded by `MAX_TOKENS` at the call site, and both
 *  inputs have their common prefix and suffix stripped first, so the table is
 *  built only over what actually differs — for the common edit (one paragraph
 *  in a long document) that is a handful of tokens, not the whole text. */
function lcsMatches(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length, m = b.length;
  if (n === 0 || m === 0) return [];
  // Row-at-a-time to keep the allocation O(m) rather than O(n·m).
  const prev = new Uint32Array(m + 1);
  const rows: Uint32Array[] = [];
  let cur = new Uint32Array(m + 1);
  let last = prev;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? last[j - 1]! + 1
        : Math.max(last[j]!, cur[j - 1]!);
    }
    rows.push(cur);
    last = cur;
    cur = new Uint32Array(m + 1);
  }
  // Walk back for the actual pairs.
  const out: Array<[number, number]> = [];
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      out.push([i - 1, j - 1]);
      i--;
      j--;
    } else if ((rows[i - 2]?.[j] ?? 0) >= (rows[i - 1]![j - 1] ?? 0)) {
      // Prefer the move that keeps the larger LCS; ties go up, which makes the
      // result deterministic (both peers must compute the SAME merge).
      i--;
    } else {
      j--;
    }
  }
  return out.reverse();
}

/** One contiguous edit: replace `base[from, to)` with `insert`. */
interface Hunk {
  from: number;
  to: number;
  insert: string[];
}

/** The edits that turn `base` into `next`, as disjoint hunks over `base`. */
export function hunksOf(base: string[], next: string[]): Hunk[] {
  // Strip the shared ends first — the whole reason a long document merges
  // cheaply is that only the changed middle reaches the LCS table.
  let lo = 0;
  const maxLo = Math.min(base.length, next.length);
  while (lo < maxLo && base[lo] === next[lo]) lo++;
  let hiB = base.length, hiN = next.length;
  while (hiB > lo && hiN > lo && base[hiB - 1] === next[hiN - 1]) {
    hiB--;
    hiN--;
  }
  const a = base.slice(lo, hiB);
  const b = next.slice(lo, hiN);
  if (a.length === 0 && b.length === 0) return [];
  const matches = lcsMatches(a, b);
  const hunks: Hunk[] = [];
  let ai = 0, bi = 0;
  const push = (fromA: number, toA: number, ins: string[]) => {
    if (toA === fromA && ins.length === 0) return;
    hunks.push({ from: lo + fromA, to: lo + toA, insert: ins });
  };
  for (const [ma, mb] of matches) {
    if (ma > ai || mb > bi) push(ai, ma, b.slice(bi, mb));
    ai = ma + 1;
    bi = mb + 1;
  }
  if (ai < a.length || bi < b.length) push(ai, a.length, b.slice(bi));
  return hunks;
}

/** Do two hunks touch the same region of the base?
 *
 *  The hunks are half-open ranges over the BASE, and an insertion is an empty
 *  one at a point. Four cases, and the two empty ones are the interesting
 *  half:
 *
 *   • two replacements   → overlap iff the ranges intersect.
 *   • one insertion, one replacement → conflict only when the insertion point
 *     is STRICTLY inside the replaced range. At either boundary both apply
 *     cleanly (insert, then replace what follows), and calling that a conflict
 *     would refuse the most ordinary merge there is: one peer appending while
 *     another rewrites the paragraph after.
 *   • two insertions     → conflict iff at the same point. Two people typing
 *     at the very same offset have no agreed order, and interleaving them is
 *     the mangled hybrid this merge exists to avoid. */
function overlaps(x: Hunk, y: Hunk): boolean {
  const xIns = x.from === x.to;
  const yIns = y.from === y.to;
  if (xIns && yIns) return x.from === y.from;
  if (xIns) return x.from > y.from && x.from < y.to;
  if (yIns) return y.from > x.from && y.from < x.to;
  return x.from < y.to && y.from < x.to;
}

/**
 * Three-way merge of `local` and `remote` against their agreed `base`.
 *
 * Returns the merged text, and whether any hunk had to be resolved by
 * timestamp rather than merged.
 */
export function mergeText3(
  base: string,
  local: string,
  localHlc: HLC,
  remote: string,
  remoteHlc: HLC,
): TextMergeResult {
  if (local === remote) return { value: local, conflict: false };
  // One side did not move: the other side's text IS the answer, with no
  // conflict — this is the overwhelmingly common case (a peer that only read).
  if (base === local) return { value: remote, conflict: false };
  if (base === remote) return { value: local, conflict: false };

  const bT = tokenize(base);
  const lT = tokenize(local);
  const rT = tokenize(remote);
  const localWins = compareHLC(localHlc, remoteHlc) >= 0;
  if (
    bT.length > MAX_TOKENS || lT.length > MAX_TOKENS || rT.length > MAX_TOKENS
  ) {
    return { value: localWins ? local : remote, conflict: true };
  }

  const lH = hunksOf(bT, lT);
  const rH = hunksOf(bT, rT);

  // Which of the other side's hunks does each hunk collide with?
  let conflict = false;
  type Owned = Hunk & { mine: boolean };
  const all: Owned[] = [];
  for (const h of lH) {
    if (rH.some((o) => overlaps(h, o))) {
      conflict = true;
      // The losing side's hunk is dropped, not interleaved. Reported, so the
      // app can say "your change to this paragraph was replaced" instead of
      // the user discovering it later.
      if (localWins) all.push({ ...h, mine: true });
    } else all.push({ ...h, mine: true });
  }
  for (const h of rH) {
    if (lH.some((o) => overlaps(h, o))) {
      if (!localWins) all.push({ ...h, mine: false });
    } else all.push({ ...h, mine: false });
  }

  // Apply in base order. Deterministic on both peers: the sort key is the
  // base offset, and ties break by side with the HLC winner first — the same
  // comparison both peers compute, so both produce the same string.
  all.sort((x, y) =>
    x.from - y.from ||
    x.to - y.to ||
    (x.mine === y.mine ? 0 : (x.mine === localWins ? -1 : 1))
  );
  const out: string[] = [];
  let at = 0;
  for (const h of all) {
    if (h.from < at) {
      // Two hunks the overlap test let through still cannot be applied out of
      // order. Falling back is safe and honest; silently dropping is not.
      return { value: localWins ? local : remote, conflict: true };
    }
    out.push(...bT.slice(at, h.from), ...h.insert);
    at = h.to;
  }
  out.push(...bT.slice(at));
  return { value: out.join(""), conflict };
}
