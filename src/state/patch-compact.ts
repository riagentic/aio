// Patch compaction — drops Immer ops a later whole-value `replace` overwrites,
// before wire send. That covers same-path last-write-wins AND any op under a
// path replaced wholesale further down the list (see compactPatches: the second
// half is correctness, not thrift — without it the emitted list could fail to
// apply on the client at all).
import type { Patch } from "immer";
import {
  _pathKey as pathKey,
  APPEND_MIN_LENGTH,
  type AppendPatch,
  applyWirePatches,
  type WirePatch,
} from "../protocol/patch-ops.ts";

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

  /** Is `p` a strict descendant of `ancestor`? A `pathKey` prefix is a path
   *  prefix (the root, `""`, prefixes everything). */
  const isUnder = (p: string, ancestor: string): boolean =>
    p.length > ancestor.length && p.startsWith(ancestor);

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

/**
 * Rewrite a string that GREW as the suffix it grew by.
 *
 * A streamed reply is `s.reply += chunk`, which Immer can only describe as
 * "replace the whole string" — so every broadcast window re-sent the entire
 * reply, quadratic in its length (measured: 33 broadcasts/sec against the
 * 30/sec pressure threshold, in three production apps). When the previous
 * value is a prefix of the new one, the op becomes
 * `{ op: "append", path, value: <suffix> }` (see protocol/patch-ops.ts).
 *
 * Decided HERE, at generation, because this is the last place the previous
 * slice is in hand. Conservative by construction:
 *   • only a `replace` whose base is PROVABLY the previous value is rewritten —
 *     any earlier op in the same list at the path, an ancestor or a descendant
 *     leaves the base unknown and the replace stands;
 *   • strings below `APPEND_MIN_LENGTH` stay a replace (the op overhead is
 *     the whole cost at that size);
 *   • a non-suffix change (edit, truncation, unrelated value) stays a replace.
 *
 * Pure; returns the input array itself when nothing changed.
 */
export function narrowStringPatches(
  prev: unknown,
  ops: readonly WirePatch[],
): WirePatch[] {
  let out: WirePatch[] | null = null;
  // Paths an earlier op in this list has touched, as keys. A later op whose
  // path is equal to, under, or above any of them has an unknown base.
  const touched: string[] = [];
  const related = (a: string, b: string): boolean =>
    a.startsWith(b) || b.startsWith(a);
  for (let i = 0; i < ops.length; i++) {
    const p = ops[i]!;
    const key = pathKey(p.path);
    let rewritten: AppendPatch | null = null;
    if (
      p.op === "replace" && typeof p.value === "string" &&
      p.value.length > APPEND_MIN_LENGTH &&
      !touched.some((t) => related(t, key))
    ) {
      const base = valueAt(prev, p.path);
      if (
        typeof base === "string" && base.length >= APPEND_MIN_LENGTH &&
        base.length < p.value.length && p.value.startsWith(base)
      ) {
        rewritten = {
          op: "append",
          path: p.path as (string | number)[],
          value: p.value.slice(base.length),
        };
      }
    }
    touched.push(key);
    if (rewritten === null) {
      out?.push(p);
      continue;
    }
    out ??= ops.slice(0, i);
    out.push(rewritten);
  }
  return out ?? (ops as WirePatch[]);
}

/** The ONE narrowing pass patch generation runs: arrays first (a grown list
 *  travels as its adds), then strings (a grown string as its suffix), then —
 *  when the caller hands over the NEW state too — key order (a key that moved
 *  travels as the move; see `fixKeyOrder`). Both callers in
 *  cell-compose-reduce.ts go through this, so no rewrite can apply to one
 *  code path and not the other. */
export function narrowPatches(
  prev: unknown,
  ops: Patch[],
  next?: unknown,
): WirePatch[] {
  const narrowed = narrowStringPatches(prev, narrowArrayPatches(prev, ops));
  return next === undefined ? narrowed : fixKeyOrder(prev, next, narrowed);
}

/** A canonical array-index key ("0", "7", not "07" or "-1"): JavaScript lists
 *  these first, ascending, on EVERY object regardless of insertion order — so
 *  they can never be out of order between two peers holding the same keys. */
function isIndexKey(k: string): boolean {
  if (k.length === 0) return false;
  const c = k.charCodeAt(0);
  if (c < 48 || c > 57) return false;
  if (k.length > 1 && c === 48) return false;
  for (let i = 1; i < k.length; i++) {
    const d = k.charCodeAt(i);
    if (d < 48 || d > 57) return false;
  }
  return k.length < 10 || Number(k) < 4294967295;
}

/** Key lists of FROZEN objects, which can never change. Committed state is
 *  always frozen (Immer's autoFreeze is never disabled), so the `next` a
 *  commit walked is the `prev` of the commit after it, and `Object.keys` on a
 *  large dictionary — the dominant cost here, ~0.5 ms at 10k keys — runs once
 *  per object rather than twice per commit. Small objects are not cached: the
 *  lookup would cost more than the call. */
const frozenKeys = new WeakMap<object, string[]>();
function keysOf(o: object): string[] {
  const hit = frozenKeys.get(o);
  if (hit !== undefined) return hit;
  const keys = Object.keys(o);
  if (keys.length >= 64 && Object.isFrozen(o)) frozenKeys.set(o, keys);
  return keys;
}

/**
 * Make the patch list reproduce the server's KEY ORDER, not just its keys.
 *
 * Immer describes `delete s.words.apple; s.words.apple = 11` as
 * `replace ["words","apple"]`, and applying that on a client overwrites the
 * key IN PLACE — while the server's object now holds it LAST. So
 * `Object.entries(words)` rendered `apple, banana, cherry` live and
 * `banana, cherry, apple` after a reload (or in SSR), from one state. The
 * move-to-end idiom is common on purpose — an LRU touch, "bump to the bottom"
 * — and its purest form (re-adding the SAME value) emits no patch at all, so
 * the client never learned anything had changed.
 *
 * So the changed spine of `next` is walked (only objects whose identity
 * differs from `prev` — the ones Immer copied; everything else is shared) and
 * each object's order is compared with the order the client will produce:
 * `prev`'s surviving keys in place, then new keys appended in `add` order.
 * Keys the client cannot place are re-sent as `remove` + `add` (the `remove`
 * only where the client holds the key) in the server's order, appended to the
 * list — an `add` of an absent key appends. Ops already under a re-sent key
 * are dropped: the `add` carries the value whole.
 *
 * An array that SHIFTED in the same commit (an add/remove at an index, or a
 * length change) breaks the one assumption the walk leans on — that `prev[i]`
 * and `next[i]` are the same element and an op path's index is its final one.
 * There, indices are mapped through the array's own ops, and an element changed
 * in place is compared against what the client will ACTUALLY hold (the frame
 * applied to `prev`, computed once and only then) rather than reasoned about.
 *
 * Cost: the common case (no key moved) is one lockstep comparison per changed
 * object, the same order of work Immer's own finalize already did on it, and
 * the delta is untouched. A move costs one `remove` op per moved key.
 */
function fixKeyOrder(
  prev: unknown,
  next: unknown,
  ops: WirePatch[],
): WirePatch[] {
  if (prev === next) return ops;
  // Built on first need: most commits never descend past a scalar write.
  let opKeys: string[] | null = null;
  let whole: Set<string> | null = null;
  let shifted: Set<string> | null = null;
  const index = (): void => {
    opKeys = ops.map((p) => pathKey(p.path));
    whole = new Set();
    shifted = new Set();
    for (let i = 0; i < ops.length; i++) {
      const p = ops[i]!;
      if (p.op === "add" || p.op === "replace") whole.add(opKeys[i]!);
      const last = p.path[p.path.length - 1];
      if (
        p.path.length > 0 &&
        (p.op === "add" || p.op === "remove" || last === "length")
      ) shifted.add(pathKey(p.path.slice(0, -1) as (string | number)[]));
    }
  };
  /** What the client holds once the frame (without these fixes) applies. */
  let client: { value: unknown } | null = null;
  const clientAt = (path: readonly (string | number)[]): unknown => {
    if (client === null) {
      try {
        client = { value: applyWirePatches(prev, ops) };
      } catch {
        // The client would fail on this frame too and resync with a full
        // state, which carries the server's order — nothing to fix here.
        client = { value: undefined };
      }
    }
    let cur = client.value;
    for (const k of path) {
      if (cur === null || typeof cur !== "object") return undefined;
      cur = (cur as Record<string | number, unknown>)[k];
    }
    return cur;
  };
  /** Keys (as path keys) whose subtree is re-sent whole by a fix. */
  const resent: string[] = [];
  const fixes: WirePatch[] = [];
  const isObj = (v: unknown): v is object =>
    v !== null && typeof v === "object";

  /** Re-send `tail` (keys of `no`, in order) under `path`; `held` is the
   *  object the client holds there. */
  const resend = (
    path: (string | number)[],
    held: object,
    no: Record<string, unknown>,
    tail: string[],
  ): void => {
    for (const k of tail) {
      const at = [...path, k];
      if (Object.hasOwn(held, k)) fixes.push({ op: "remove", path: at });
      fixes.push({ op: "add", path: at, value: no[k] });
    }
  };

  /** Identity walk, trusted while no enclosing array shifted this commit. */
  const walk = (
    p: unknown,
    n: unknown,
    path: (string | number)[],
    key: string,
  ): void => {
    if (
      p === n || !isObj(p) || !isObj(n) || Array.isArray(p) !== Array.isArray(n)
    ) return;
    if (Array.isArray(p)) {
      const na = n as unknown[];
      let changed = false;
      for (let j = 0; !changed && j < na.length; j++) {
        changed = isObj(na[j]) && (j >= p.length || p[j] !== na[j]);
      }
      if (!changed) return;
      if (opKeys === null) index();
      if (p.length === na.length && !shifted!.has(key)) {
        for (let j = 0; j < na.length; j++) {
          if (p[j] === na[j] || !isObj(na[j])) continue;
          const ck = key + pathKey([j]);
          if (!whole!.has(ck)) walk(p[j], na[j], [...path, j], ck);
        }
        return;
      }
      const origin = originOf(p.length, path, key);
      if (origin === null || origin.length !== na.length) {
        // The ops do not account for the array: trust nothing but the client.
        exact(clientAt(path), na, path);
        return;
      }
      for (let j = 0; j < na.length; j++) {
        const o = origin[j]!;
        // A fresh element (added, or replaced whole) arrived as JSON, in the
        // server's order. Everything else is checked against the client.
        if (o < 0 || !isObj(na[j]) || p[o] === na[j]) continue;
        exact(clientAt([...path, j]), na[j], [...path, j]);
      }
      return;
    }
    const po = p as Record<string, unknown>;
    const no = n as Record<string, unknown>;
    const tail = movedTail(po, no, () => {
      // The keys this commit `add`s under `path`, in op order — the order the
      // client appends them in.
      const keys: string[] = [];
      for (const op of ops) {
        if (op.op !== "add" || op.path.length !== path.length + 1) continue;
        const k = op.path[path.length];
        if (typeof k !== "string") continue;
        if (pathKey(op.path.slice(0, -1) as (string | number)[]) === key) {
          keys.push(k);
        }
      }
      return keys;
    });
    if (tail !== null) {
      for (const k of tail) resent.push(key + pathKey([k]));
      resend(path, po, no, tail);
    }
    const moved = tail === null ? null : new Set(tail);
    for (const k of keysOf(no)) {
      const nv = no[k];
      if (!isObj(nv) || moved?.has(k)) continue;
      if (!Object.hasOwn(po, k) || po[k] === nv) continue;
      if (opKeys === null) index();
      const ck = key + pathKey([k]);
      if (!whole!.has(ck)) walk(po[k], nv, [...path, k], ck);
    }
  };

  /** Final index → `prev` index for an array that shifted, from its own ops
   *  (-1 for an element that arrived whole), or null if they cannot say. */
  const originOf = (
    len: number,
    path: readonly (string | number)[],
    key: string,
  ): number[] | null => {
    const list = Array.from({ length: len }, (_, i) => i);
    for (const p of ops) {
      if (p.path.length !== path.length + 1) continue;
      if (pathKey(p.path.slice(0, -1) as (string | number)[]) !== key) continue;
      const last = p.path[p.path.length - 1];
      if (last === "length") {
        if (typeof p.value !== "number") return null;
        const from = list.length;
        list.length = p.value;
        list.fill(-1, from);
        continue;
      }
      const idx = typeof last === "number" ? last : Number(last);
      if (!Number.isInteger(idx) || idx < 0 || idx > list.length) return null;
      if (p.op === "add") list.splice(idx, 0, -1);
      else if (p.op === "remove") list.splice(idx, 1);
      else list[idx] = -1;
    }
    return list;
  };

  /** Structural walk against the client's actual value: no identity, op-path
   *  or drop shortcuts, because under a shifted array none of them hold. */
  const exact = (
    c: unknown,
    n: unknown,
    path: (string | number)[],
  ): void => {
    if (
      c === n || !isObj(c) || !isObj(n) || Array.isArray(c) !== Array.isArray(n)
    ) return;
    if (Array.isArray(c)) {
      const na = n as unknown[];
      if (c.length !== na.length) return; // not an order question
      for (let j = 0; j < na.length; j++) exact(c[j], na[j], [...path, j]);
      return;
    }
    const co = c as Record<string, unknown>;
    const no = n as Record<string, unknown>;
    const tail = movedTail(co, no);
    if (tail !== null) resend(path, co, no, tail);
    const moved = tail === null ? null : new Set(tail);
    for (const k of keysOf(no)) {
      if (!moved?.has(k) && Object.hasOwn(co, k)) {
        exact(co[k], no[k], [...path, k]);
      }
    }
  };

  walk(prev, next, [], "");

  if (fixes.length === 0) return ops;
  if (opKeys === null) index();
  const kept = resent.length === 0
    ? ops
    : ops.filter((_, i) => !resent.some((r) => opKeys![i]!.startsWith(r)));
  return [...kept, ...fixes];
}

/**
 * The keys of `n` the client cannot place by itself, in `n`'s order — or null
 * when `n`'s order is what the client builds from `p` (its survivors in place,
 * new keys appended in `add` order).
 */
function movedTail(
  p: Record<string, unknown>,
  n: Record<string, unknown>,
  addOrder?: () => string[],
): string[] | null {
  const pk = keysOf(p);
  const nk = keysOf(n);
  let same = pk.length === nk.length;
  for (let x = 0; same && x < pk.length; x++) same = pk[x] === nk[x];
  if (same) return null;
  // Lockstep over the non-index keys: `p`'s survivors, in order, are a prefix
  // of `n`'s unless a key the client already holds was moved. No allocation —
  // this is the path every add/remove to a dict takes.
  let i = 0;
  let j = 0;
  for (;;) {
    while (i < pk.length && (isIndexKey(pk[i]!) || !Object.hasOwn(n, pk[i]!))) {
      i++;
    }
    while (j < nk.length && isIndexKey(nk[j]!)) j++;
    if (i < pk.length && j < nk.length && pk[i] === nk[j]) {
      i++;
      j++;
    } else break;
  }
  // Past the lockstep, only NEW keys is what the client can build by itself.
  // An OLD key there is a move the client cannot see.
  let moved = false;
  let fresh = 0;
  for (let x = j; !moved && x < nk.length; x++) {
    if (isIndexKey(nk[x]!)) continue;
    moved = Object.hasOwn(p, nk[x]!);
    fresh++;
  }
  if (!moved) {
    // …and only if their `add`s arrive in `n`'s order. Usually Immer emits
    // them in insertion order, but not always: a new key whose NAME is
    // inherited (`constructor`, `toString`) that is deleted and re-added keeps
    // its first slot in Immer's bookkeeping (`"constructor" in base` is true),
    // so its `add` precedes keys inserted after it.
    if (fresh < 2 || addOrder === undefined) return null;
    const rest = nk.slice(j).filter((k) => !isIndexKey(k));
    const inRest = new Set(rest);
    const adds = addOrder().filter((k) => inRest.has(k));
    let inOrder = adds.length === rest.length;
    for (let x = 0; inOrder && x < rest.length; x++) {
      inOrder = adds[x] === rest[x];
    }
    return inOrder ? null : rest;
  }
  // `n` is [keys never moved, in `p` order] ++ [appended keys]. The LONGEST
  // prefix of old keys in increasing `p` position is a valid "never moved"
  // part, and the smallest one to leave in place: re-sending the tail after
  // it reproduces `n` exactly. (Cutting at the lockstep instead would re-send
  // every key after the first moved one — a touched first key of a 10k dict
  // re-sent all 10k.)
  const at = new Map<string, number>();
  for (let x = 0; x < pk.length; x++) at.set(pk[x]!, x);
  const order = nk.filter((k) => !isIndexKey(k));
  let t = 0;
  for (let last = -1; t < order.length; t++) {
    const q = at.get(order[t]!);
    if (q === undefined || q < last) break;
    last = q;
  }
  return order.slice(t);
}

// Path identity is `_pathKey` (protocol/patch-ops.ts) — ONE decider for the
// generator and the applier. It used to be a local NUL-joined key here and a
// second NUL-joined key there, and a state key containing NUL collided with a
// deeper path in both: `compactPatches` dropped a live write as "superseded".

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
export function compactPatches(ops: WirePatch[]): WirePatch[] {
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
  // Indexed by PARENT, each list ascending in `at`, so "is there a shift of
  // THIS parent strictly between i and j" is a binary search rather than a
  // walk over every shift in the batch. A flush holding 20 000 pushes and one
  // ancestor replace asked that question 20 000 × 20 000 times — 257 ms per
  // client per flush, and it runs per client.
  const shiftsByParent = new Map<string, number[]>();
  for (let i = 0; i < ops.length; i++) {
    const p = ops[i]!;
    if (p.op === "add" || p.op === "remove") {
      const parent = pathKey(p.path.slice(0, -1) as (string | number)[]);
      let list = shiftsByParent.get(parent);
      if (!list) shiftsByParent.set(parent, list = []);
      list.push(i);
    }
  }
  /** First index in ascending `list` whose value is > `x`. */
  const firstAbove = (list: number[], x: number): number => {
    let lo = 0, hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]! <= x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  /** Is `path` renumbered by anything strictly between ops `i` and `j`, so the
   *  replace at `j` no longer lands where the op at `i` wrote? A shift INSIDE
   *  `path` does not count — that subtree is about to be overwritten wholesale;
   *  only a shift in an array `path` indexes THROUGH moves `path` itself. */
  const movedBetween = (
    i: number,
    j: number,
    path: readonly (string | number)[],
  ): boolean => {
    // Only an array index inside `path` can be renumbered: for each such
    // position, ask whether its parent saw an add/remove in (i, j).
    for (let n = 0; n < path.length; n++) {
      if (typeof path[n] !== "number") continue;
      const list = shiftsByParent.get(
        pathKey(path.slice(0, n) as (string | number)[]),
      );
      if (!list) continue;
      const k = firstAbove(list, i);
      if (k < list.length && list[k]! < j) return true;
    }
    return false;
  };

  /** Is op `i` overwritten by a later replace at its path or an ancestor? */
  const superseded = (i: number, p: WirePatch): boolean => {
    const path = p.path as (string | number)[];
    // Same path — last-write-wins, but only between POSITIONAL ops. An
    // `add`/`remove` here is a shift the later replace does not undo. An
    // `append` is a value write like `replace`: a later whole-value replace
    // at its path overwrites it, and it can never be the superseding op
    // itself (it extends, it does not re-establish).
    if (p.op === "replace" || p.op === "append") {
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

  const result: WirePatch[] = [];
  for (let i = 0; i < ops.length; i++) {
    const p = ops[i]!;
    if (!superseded(i, p)) result.push(p);
  }

  return result;
}
