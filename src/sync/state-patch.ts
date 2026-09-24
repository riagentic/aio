// src/sync/state-patch.ts — the delta a pushed server write travels as.
//
// A server-origin write to a sync cell (an effect, cron, a serverFn,
// `am dispatch`, an async method) produces no op, so the server PUSHES it to
// every live client (server-handler.ts `pushServerState`). It used to push the
// whole cell: one price tick on a 2000-note cell was ~105 KB to every client,
// per write. This module is what lets it push only what changed:
//
//  - `diffState(base, next)` — the changed leaves between the state last
//    pushed and the state now, as path operations.
//  - `applyStatePatch(state, ops)` — the same operations on a client's
//    confirmed state, copy-on-write (committed state is frozen).
//  - `stateDigest(state)` — a digest of the state's JSON value, so the client
//    can PROVE the patched state is the server's.
//
// The digest is what makes a patch safe rather than hopeful. The server diffs
// against what it last pushed, and a client's confirmed state is that PLUS the
// ops it folded since, replayed through the method on a state that lacked the
// write. Two shapes make the patched result differ from the server's: an op
// that changed a field the write then set back (the diff sees no change), and
// an op whose result depended on the field the write changed. Neither is
// visible to either side alone. So the client patches, digests, and on a
// mismatch keeps its state and asks the server for the cell (a re-sync) — a
// full snapshot to that ONE client, in the one case that needs it.
//
// Pure functions, isomorphic, no imports: the browser bundle and the server
// run the same code, and the digest must be bit-identical on both.

/** A path into a state tree: object keys and array indices. */
export type StatePath = (string | number)[];

/** One patch operation.
 *  - `{ p, v }` — set the value at `p`.
 *  - `{ p, d: 1 }` — delete the object key at `p`.
 *  - `{ p, n }` — the array at `p` now has `n` elements (followed by `v` ops
 *    for every index past its old length).
 *  @internal Engine/framework wiring — not public API. */
export type StatePatchOp =
  | { p: StatePath; v: unknown }
  | { p: StatePath; d: 1 }
  | { p: StatePath; n: number };

const isPlainObject = (x: unknown): x is Record<string, unknown> => {
  if (x === null || typeof x !== "object" || Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
};

/** A value JSON does not carry: `undefined`, a function, a symbol. Dropped
 *  from an object, `null` in an array — exactly what `JSON.stringify` (and
 *  `stateDigest`) make of it. A patch that carried one as a value lost it on
 *  the wire or in the journal, and the op no longer applied (review rev8). */
const absent = (v: unknown): boolean =>
  v === undefined || typeof v === "function" || typeof v === "symbol";

/** A value as JSON carries it inside an array: an absent one becomes `null`. */
const inArray = (v: unknown): unknown => absent(v) ? null : v;

/**
 * The operations that turn `base` into `next`, by value.
 *
 * Objects are walked key by key and arrays index by index, so a changed field
 * costs the field, and an appended element costs the element. Anything else
 * (a primitive, a class instance) is a leaf, replaced when it is not the same
 * value. `undefined`, function and symbol values count as absent, as JSON
 * has them: dropped from an object, `null` in an array.
 *
 * @internal Engine/framework wiring — not public API.
 */
export function diffState(base: unknown, next: unknown): StatePatchOp[] {
  const out: StatePatchOp[] = [];
  walk(base, next, [], out);
  return out;
}

function walk(
  a: unknown,
  b: unknown,
  path: StatePath,
  out: StatePatchOp[],
): void {
  if (a === b) return;
  // Both `null` in an array's JSON (an object never walks into one).
  if (absent(a) && absent(b)) return;
  if (isPlainObject(a) && isPlainObject(b)) {
    for (const k of Object.keys(b)) {
      const bv = b[k];
      if (absent(bv)) continue;
      const av = Object.hasOwn(a, k) ? a[k] : undefined;
      // Identity BEFORE the path: an unchanged key costs one `===`, not a
      // path array (the walk would return at once anyway — same output).
      if (av === bv) continue;
      if (absent(av)) out.push({ p: [...path, k], v: bv });
      else walk(av, bv, [...path, k], out);
    }
    for (const k of Object.keys(a)) {
      if (absent(a[k])) continue;
      if (!Object.hasOwn(b, k) || absent(b[k])) {
        out.push({ p: [...path, k], d: 1 });
      }
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push({ p: path, n: b.length });
    const shared = Math.min(a.length, b.length);
    // Identity BEFORE the path. This runs per commit when the journal is on
    // (aio.ts reaction deltas) and per server push: `[...path, i]` for every
    // index made a one-row edit in a 131k-row array allocate 131k paths to
    // find the one row that moved. An identical element (or a hole on both
    // sides) is exactly what `walk` returns on at once, so skipping it here
    // changes nothing but the cost — pinned against the old walker by
    // tests/state-patch-diff-oracle.test.ts.
    for (let i = 0; i < shared; i++) {
      const x = a[i], y = b[i];
      if (x !== y) walk(x, y, [...path, i], out);
    }
    for (let i = a.length; i < b.length; i++) {
      out.push({ p: [...path, i], v: inArray(b[i]) });
    }
    return;
  }
  // NaN is the one value unequal to itself — not a change.
  if (Number.isNaN(a) && Number.isNaN(b)) return;
  if (path.length === 0) {
    // The root is always an object on both sides; a root that is not is not
    // patchable, and the caller falls back to the whole state.
    throw new TypeError(
      "diffState: the root of a cell state must be a plain object",
    );
  }
  // Inside an object both sides are defined (see above); inside an array an
  // `undefined` element is JSON's `null`.
  out.push({ p: path, v: typeof path.at(-1) === "number" ? inArray(b) : b });
}

/**
 * `ops` applied to `state`, copy-on-write — the input is never touched (it is
 * usually frozen). `null` when an operation does not fit the state (a path
 * through something that is not a container, a malformed op): the caller
 * treats that exactly like a digest mismatch.
 *
 * @internal Engine/framework wiring — not public API.
 */
export function applyStatePatch(
  state: Record<string, unknown>,
  ops: readonly unknown[],
): Record<string, unknown> | null {
  // Containers already copied by THIS apply — a burst of ops under one array
  // copies it once, not once per op.
  const owned = new WeakSet<object>();
  const own = <T extends object>(x: T): T => {
    if (owned.has(x)) return x;
    const copy = (Array.isArray(x) ? x.slice() : { ...x }) as T;
    owned.add(copy);
    return copy;
  };
  const put = (parent: object, key: string | number, value: unknown): void => {
    // defineProperty, not assignment: an own "__proto__" key is data here,
    // and must stay data.
    Object.defineProperty(parent, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  };
  const fits = (parent: object, key: unknown): key is string | number =>
    Array.isArray(parent)
      ? Number.isInteger(key) && (key as number) >= 0 &&
        (key as number) < parent.length
      : typeof key === "string";

  if (!isPlainObject(state)) return null;
  const root = own(state);
  for (const raw of ops) {
    if (raw === null || typeof raw !== "object") return null;
    const op = raw as Record<string, unknown>;
    const p = op.p;
    if (!Array.isArray(p) || p.length === 0) return null;
    let parent: object = root;
    for (let i = 0; i < p.length - 1; i++) {
      const k = p[i];
      if (!fits(parent, k)) return null;
      const child = (parent as Record<string | number, unknown>)[k];
      if (!Array.isArray(child) && !isPlainObject(child)) return null;
      const mine = own(child);
      if (mine !== child) put(parent, k, mine);
      parent = mine;
    }
    const last = p[p.length - 1];
    if ("v" in op) {
      // Setting one past the end of an array is how an `n` op's new slots
      // are filled; anything further out would leave a hole.
      const ok = Array.isArray(parent)
        ? Number.isInteger(last) && last >= 0 && last < parent.length
        : typeof last === "string";
      if (!ok) return null;
      put(parent, last, op.v);
    } else if (op.d === 1) {
      if (Array.isArray(parent) || typeof last !== "string") return null;
      delete (parent as Record<string, unknown>)[last];
    } else if (typeof op.n === "number") {
      if (!fits(parent, last) || !Number.isInteger(op.n) || op.n < 0) {
        return null;
      }
      const arr = (parent as Record<string | number, unknown>)[last];
      if (!Array.isArray(arr)) return null;
      const mine = own(arr);
      // Grown slots are filled by the `v` ops that follow; one left empty is
      // a hole, which the digest (holes serialize as null) then catches.
      mine.length = op.n;
      if (mine !== arr) put(parent, last, mine);
    } else {
      return null;
    }
  }
  return root;
}

/**
 * A digest of `state`'s JSON value, and that JSON's length in bytes.
 *
 * Canonical: object keys are sorted, so two states holding the same data in a
 * different key order digest the same. Same value rules as `JSON.stringify`
 * (`toJSON`, `undefined` dropped from objects and `null` in arrays, non-finite
 * numbers `null`), because the wire is JSON and the client's state came off
 * it. `null` for a state JSON cannot carry (a BigInt, a cycle) — such a state
 * is never patched.
 *
 * The algorithm is part of the wire contract: server and client compare the
 * strings. Change it only together with the field name it travels under.
 *
 * @internal Engine/framework wiring — not public API.
 */
export function stateDigest(
  state: unknown,
): { digest: string; bytes: number } | null {
  let text: string;
  try {
    text = canonical(state, new Set()) ?? "null";
  } catch {
    return null;
  }
  return { digest: cyrb53(text), bytes: text.length };
}

function canonical(v: unknown, seen: Set<object>): string | undefined {
  if (
    v !== null && typeof v === "object" &&
    typeof (v as { toJSON?: unknown }).toJSON === "function"
  ) {
    v = (v as { toJSON: () => unknown }).toJSON();
  }
  switch (typeof v) {
    case "string":
    case "number":
    case "boolean":
      return JSON.stringify(v);
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
    case "bigint":
      throw new TypeError("a BigInt is not JSON");
  }
  if (v === null) return "null";
  const obj = v as object;
  if (seen.has(obj)) throw new TypeError("a cycle is not JSON");
  seen.add(obj);
  let s: string;
  if (Array.isArray(obj)) {
    const parts: string[] = [];
    for (let i = 0; i < obj.length; i++) {
      parts.push(canonical(obj[i], seen) ?? "null");
    }
    s = `[${parts.join(",")}]`;
  } else {
    const rec = obj as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of Object.keys(rec).sort()) {
      const c = canonical(rec[k], seen);
      if (c !== undefined) parts.push(`${JSON.stringify(k)}:${c}`);
    }
    s = `{${parts.join(",")}}`;
  }
  seen.delete(obj);
  return s;
}

/** cyrb53 — a fast 53-bit string hash, as 14 hex digits. Not cryptographic:
 *  it detects accidental divergence between a server and its own client, which
 *  is all it is asked to do. */
function cyrb53(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, "0");
}
