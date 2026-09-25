// AIO VDOM — a component's output that RE-PLACES a vnode it already rendered.
//
// A vnode carries its own mount state (`_dom`, `_instance`, `_anchor`,
// `_unbind`), so one vnode OBJECT can be mounted in one place at a time. A
// component that re-renders on its own signal hands the SAME `children` (and
// any memoized vnode) to its new output, and that is fine while they stay where
// they were: the diff pairs each with itself and skips it. When the output
// moves one — a wrapper that changes tag (`open ? <section>{children}</section>
// : <div>{children}</div>`), a child moved into or out of an element, a
// reorder — the diff builds it in its new place while its old mount is still
// live, and then tears the old place down THROUGH THE SAME OBJECT: the new
// mount's component instance ran `onUnmount` while on screen, its signal text
// froze, a portal left its old region behind in the target.
//
// So before the diff, every already-mounted vnode the new output puts at a
// DIFFERENT position than the old output had it is swapped for a fresh copy.
// A fresh copy is exactly what a parent re-render would have handed over, so
// from there on it is the ordinary, well-trodden path: paired with the old
// one it patches it, unpaired it is created while the old one is removed.

import { _hasRawHtml, _SignalText } from "./vdom-types.ts";
import type { VNode } from "./vdom-types.ts";
import { _holdsMounted, _isMountedVNode as _isMounted } from "./vdom-create.ts";

type Child = VNode | string | number | null | undefined;

const _tagIds = new Map<unknown, number>();
function _tagId(tag: unknown): number {
  let n = _tagIds.get(tag);
  if (n === undefined) {
    n = _tagIds.size;
    _tagIds.set(tag, n);
  }
  return n;
}

/** Whether `v`'s children are realized under it (raw html owns its content;
 *  a boundary showing its fallback does not hold its children). */
function _holdsChildren(v: VNode): boolean {
  if (typeof v.tag === "string") return !_hasRawHtml(v.props);
  return v._rendered === undefined || typeof v.tag === "function";
}

/** Record where each reused vnode sits: a path of (parent tag, slot) pairs,
 *  where the slot is the child's key when it has one and otherwise its ordinal
 *  among its unkeyed siblings — the two things the child reconciler pairs by.
 *  Equal paths mean the diff pairs the vnode with itself. `null` marks a vnode
 *  that occurs more than once. */
function _paths(
  v: Child,
  path: string,
  out: Map<VNode, string | null>,
  only: Map<VNode, string | null> | null,
): void {
  if (v == null || typeof v !== "object") return;
  if (only ? only.has(v) : _isMounted(v)) {
    out.set(v, out.has(v) ? null : path);
    return;
  }
  // In the NEW output, a subtree built around nothing mounted holds no reused
  // vnode (`h()` marked the ones that do), so the walk follows the marks only.
  if (!only && !_holdsMounted(v)) return;
  if (!Array.isArray(v.children) || !_holdsChildren(v)) return;
  const at = path + "/" + _tagId(v.tag);
  let unkeyed = 0;
  for (const c of v.children) {
    const slot = typeof c === "object" && c !== null && c.key !== undefined
      ? `k${typeof c.key}:${String(c.key)}`
      : `u${unkeyed++}`;
    _paths(c, `${at}.${slot}`, out, only);
  }
}

/** A never-mounted copy of `v` and its subtree, as `h()` would have built it. */
function _fresh(v: VNode): VNode {
  const copy: VNode = {
    tag: v.tag,
    props: v.props,
    children: v.children.map((c) => typeof c === "object" ? _fresh(c) : c),
    key: v.key,
  };
  if (v._static) copy._static = true;
  if (v.tag === _SignalText) copy._sig = v._sig;
  return copy;
}

function _replace(v: Child, moved: Set<VNode>): Child {
  if (v == null || typeof v !== "object") return v;
  if (moved.has(v)) return _fresh(v);
  // Stop where the path walk stopped: a mounted vnode that stays is kept as
  // is, and a subtree built around nothing mounted holds nothing to replace.
  if (_isMounted(v) || !_holdsMounted(v) || !Array.isArray(v.children)) {
    return v;
  }
  let changed: (VNode | string | number)[] | null = null;
  for (let i = 0; i < v.children.length; i++) {
    const c = v.children[i]!;
    const r = _replace(c, moved) as VNode | string | number;
    if (r !== c) {
      changed ??= v.children.slice();
      changed[i] = r;
    }
  }
  // `v` was built by THIS render (it is not mounted), so it is nobody else's.
  if (changed) v.children = changed;
  return v;
}

/** The key a slot pairs by, or `undefined` for an unkeyed (ordinal) slot —
 *  the same test {@linkcode _paths} makes. */
function _slotKey(c: Child): unknown {
  return typeof c === "object" && c !== null ? c.key : undefined;
}

/** A cheap, allocation-free PROOF that nothing moved — the common case of a
 *  component re-rendering on its own signal around memoized/cached vnodes that
 *  stay where they were. Walks `n` (this render's, not mounted) in lockstep
 *  with `o` (the old node the diff pairs it with) and answers true only when
 *  every already-mounted vnode sits at the SAME index of a sibling list whose
 *  slots (key, or unkeyed ordinal) line up one-for-one with the old list, and
 *  occurs once. Then every such vnode has an equal path in {@linkcode _paths}
 *  terms, so the exact walk would find nothing to move. Anything else —
 *  a length or tag change, a slot mismatch, a duplicate, a shape `_paths`
 *  treats specially — answers false, and the exact walk decides. It never
 *  answers true where the exact walk would move something. */
function _provablyInPlace(
  n: VNode,
  o: Child,
  seen: Set<VNode>,
  via: VNode[],
): boolean {
  if (
    o == null || typeof o !== "object" || o.tag !== n.tag ||
    !Array.isArray(n.children) || !Array.isArray(o.children) ||
    !_holdsChildren(n) || !_holdsChildren(o) ||
    n.children.length !== o.children.length
  ) return false;
  via.push(o);
  const nc = n.children, oc = o.children;
  for (let i = 0; i < nc.length; i++) {
    const c = nc[i], d = oc[i];
    // Slots line up: keyed with the same key, or both unkeyed (so each
    // unkeyed child keeps its ordinal).
    if (_slotKey(c) !== _slotKey(d)) return false;
    if (c == null || typeof c !== "object") continue;
    if (_isMounted(c)) {
      if (c !== d || seen.has(c)) return false;
      seen.add(c);
    } else if (
      _holdsMounted(c) && !_provablyInPlace(c, d, seen, via)
    ) return false;
  }
  return true;
}

/** The output to diff against `oldRendered`, with every already-mounted vnode
 *  it MOVES replaced by a fresh copy. Returns `rendered` itself (untouched)
 *  in the common cases: a fresh output, or reused vnodes that stay put. */
export function _detachReused<T extends Child>(
  rendered: T,
  oldRendered: Child,
): T {
  if (
    rendered === oldRendered || rendered == null ||
    typeof rendered !== "object" || !_holdsMounted(rendered)
  ) return rendered;
  if (!_isMounted(rendered)) {
    const seen = new Set<VNode>();
    const via: VNode[] = [];
    // `via` are the old nodes the proof walked THROUGH; the exact walk stops
    // at a reused vnode, so one of them reused elsewhere is not provable.
    if (
      _provablyInPlace(rendered, oldRendered, seen, via) &&
      !via.some((o) => seen.has(o))
    ) return rendered;
  }
  const now = new Map<VNode, string | null>();
  _paths(rendered, "", now, null);
  const before = new Map<VNode, string | null>();
  _paths(oldRendered, "", before, now);
  const moved = new Set<VNode>();
  for (const [v, p] of now) {
    if (p === null || before.get(v) !== p) moved.add(v);
  }
  if (moved.size === 0) return rendered;
  return _replace(rendered, moved) as T;
}
