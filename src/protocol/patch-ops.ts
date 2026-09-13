// patch-ops.ts — the wire patch vocabulary: Immer's three ops plus `append`.
//
// A streamed reply is a string that GROWS. Immer can only describe growth as
// `replace` carrying the whole string, so every broadcast window re-sent the
// entire reply — quadratic in the reply's length, and measured at 33
// broadcasts/sec against aio's own 30/sec pressure threshold in three
// production apps. `append` carries the suffix instead: applying it is
// `base[path] = base[path] + value`.
//
// ONE decider, every consumer:
//   • decided in src/state/patch-compact.ts (`narrowStringPatches`) at patch
//     GENERATION — the last place the previous slice is in hand;
//   • applied by every peer that applies a `patches` frame through
//     `applyWirePatches` below: the browser (state-message.ts), the CLI/UDS
//     client (cli-client.ts) and the worker-cell host (cell-compose-reduce.ts).
//     A consumer that hands `append` to Immer directly throws — the op is
//     unknown to it — so a forgotten consumer fails loud, never silent.
//
// Protocol v3 (protocol-version.ts): a v2 peer cannot apply `append` and is
// refused at the handshake with the reason named.
//
// Browser-safe: pure functions, imports only immer.
import { applyPatches, type Patch } from "immer";

/** `append`: the string at `path` grew by `value` (old value is a prefix of
 *  the new one). Never emitted below `APPEND_MIN_LENGTH`. */
export type AppendPatch = {
  op: "append";
  path: (string | number)[];
  value: string;
};

/** Everything a `patches` frame may carry. */
export type WirePatch = Patch | AppendPatch;

/** A string shorter than this stays a `replace`: below it the op's own
 *  overhead outweighs the saving, and a tiny value is cheaper to overwrite
 *  than to reason about. Measured in UTF-16 code units (`String.length`) —
 *  the unit JSON.stringify's output length is compared in downstream. */
export const APPEND_MIN_LENGTH = 256;

/** Resolve `path` in `root`, or undefined if any hop is missing. */
function valueAt(root: unknown, path: readonly (string | number)[]): unknown {
  let cur = root;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return cur;
}

/** Identity key for a patch path: every segment LENGTH-PREFIXED, never joined
 *  with a separator.
 *
 *  A separator is a character, and a state key may contain any character. The
 *  NUL this used to join with made `["files", "a\0b"]` and
 *  `["files", "a", "b"]` the same key, so `compactPatches` read a write to one
 *  as superseded by a write to the other and dropped it: the client kept the
 *  old value, no error on either side. A length prefix cannot collide — the
 *  digits run to a `:` that no digit is, so reading a key back is
 *  unambiguous — and it keeps the one property every caller leans on:
 *  `pathKey(a)` is a string PREFIX of `pathKey(b)` exactly when `a` is a path
 *  prefix of `b` (the root, `[]`, is `""` and prefixes everything).
 *
 *  `String(seg)`, never a template on the raw segment: an Immer patch path
 *  carries the KEY it was written under, and a SYMBOL key throws on implicit
 *  conversion — see patch-compact.ts, where that surfaced as a bogus
 *  REDUCE_ERROR. It also keeps `0` and `"0"` one key, as `join` did: they are
 *  the same property.
 *
 *  @internal Shared by patch-compact.ts — the one path-identity decider. */
export function _pathKey(
  path: readonly (string | number | symbol)[],
): string {
  let k = "";
  for (const seg of path) {
    const s = String(seg);
    k += s.length + ":" + s;
  }
  return k;
}

/** The one path segment no applier may walk or write, anywhere in a path.
 *
 *  `__proto__` is the only key whose READ on a plain object yields an object
 *  that is not the object's own data (the prototype), so it is the only one a
 *  crafted path can use to reach shared state. It is refused outright, at
 *  every position: even a final `__proto__` write would re-prototype the
 *  object it lands on.
 *
 *  `constructor` and `prototype` are NOT refused, because they are ordinary
 *  state keys (a word list, a glossary) and refusing them turned every delta
 *  touching one into a dropped frame plus a full resync. They are safe here
 *  for concrete reasons, not by hope:
 *    • a FINAL `constructor`/`prototype` write is a plain own-property
 *      assignment on the parent;
 *    • a non-final `prototype` on a plain object resolves to OWN data or to
 *      nothing (`Object.prototype` has no `prototype` property), and a
 *      function — the one thing with a real `prototype` — is unreachable
 *      without walking an inherited `constructor`;
 *    • a non-final `constructor` is the dangerous one (`{}.constructor` is
 *      `Object`, whose `prototype` is `Object.prototype`). Immer refuses it
 *      outright, even when the key is the object's OWN data, so
 *      `expandAppends` rewrites it — only after proving the key is own and
 *      holds an object. An inherited `constructor` is a throw.
 *
 *  @internal Shared with state-message.ts, which refuses the frame up front. */
export const RESERVED_PATH_SEGMENT = "__proto__";

/** The first op in `ops` whose path walks `__proto__`, or null. */
export function _reservedPathOp(ops: readonly WirePatch[]): WirePatch | null {
  for (const p of ops) {
    for (const seg of p.path) {
      if (seg === RESERVED_PATH_SEGMENT) return p;
    }
  }
  return null;
}

/** Index of the first NON-FINAL `constructor` segment in `path`, or -1. */
function nestedConstructorAt(path: readonly (string | number)[]): number {
  for (let i = 0; i < path.length - 1; i++) {
    if (path[i] === "constructor") return i;
  }
  return -1;
}

/**
 * Rewrite every `append` in `ops` as the `replace` it stands for, against the
 * value the state holds at that path AS THE OPS APPLY — not against `base`
 * alone. A coalesced frame carries several dispatches: `remove items[0]` from
 * one and `append items[0].text` from the next. Resolved against `base`, that
 * append would extend the DELETED row's text — a plausible string, silently
 * wrong. So the Immer ops before each append are applied first (structurally
 * shared, so this is cheap) and the append reads the result.
 *
 * Throws when the value there is not a string: an append onto something else
 * means the two sides disagree about the state, which is a desync — every
 * caller already treats a throw here as "request a full resync".
 *
 * The same pass also rewrites a path through a non-final `constructor`: a
 * `replace` of that `constructor` key with the result of applying the rest of
 * the path inside it. Immer refuses such a path outright ("Patching reserved
 * attributes"), yet the server's own Immer PRODUCES it for
 * `s.words.constructor.count++` — so the one delta was refused by every client
 * and the worker-cell host, forever, while the server was fine. Rewritten only
 * when `constructor` is the container's OWN key holding an object; anything
 * else is inherited (`Object`) or a desync, and throws.
 */
export function expandAppends(
  base: unknown,
  ops: readonly WirePatch[],
): Patch[] {
  let out: Patch[] | null = null;
  let state = base;
  let applied = 0; // ops[0..applied) are folded into `state`
  for (let i = 0; i < ops.length; i++) {
    const p = ops[i]!;
    const c = nestedConstructorAt(p.path);
    if (p.op !== "append" && c < 0) {
      out?.push(p);
      continue;
    }
    out ??= ops.slice(0, i) as Patch[];
    if (applied < i) {
      state = applyPatches(state as object, out.slice(applied, i));
      applied = i;
    }
    if (c >= 0) {
      const at = p.path.slice(0, c + 1);
      const container = valueAt(state, p.path.slice(0, c));
      const own = container !== null && typeof container === "object" &&
          Object.hasOwn(container, "constructor")
        ? (container as { constructor: unknown }).constructor
        : undefined;
      if (own === null || typeof own !== "object") {
        throw new Error(
          `Cannot apply ${p.op} at /${p.path.join("/")}: /${
            at.join("/")
          } is not an own object key in the state — refusing to walk an ` +
            `inherited constructor`,
        );
      }
      // The rest of the path, applied INSIDE the own value — recursively, so a
      // second `constructor` or an `append` further down is handled the same.
      out.push({
        op: "replace",
        path: at,
        value: applyWirePatches(own, [
          { ...p, path: p.path.slice(c + 1) } as WirePatch,
        ]),
      });
      continue;
    }
    const cur = valueAt(state, p.path);
    if (typeof cur !== "string") {
      throw new Error(
        `Cannot apply append at /${p.path.join("/")}: the state holds ${
          cur === undefined ? "nothing" : typeof cur
        }, not a string`,
      );
    }
    if (typeof p.value !== "string") {
      throw new Error(
        `Cannot apply append at /${p.path.join("/")}: value is ${typeof p
          .value}`,
      );
    }
    out.push({ op: "replace", path: p.path, value: cur + p.value });
  }
  return out ?? (ops as Patch[]);
}

/** The first op in `ops` that cannot describe `base`, or null when they all
 *  can. ARRAY INDICES only — the one place Immer answers an impossible op with
 *  a plausible wrong one instead of a throw.
 *
 *  `applyPatches` SPLICES an out-of-range array `add` at the end rather than
 *  refusing it, so a peer that lost a round applies the next one and ends up
 *  with a list that is merely wrong: server `["one","two","three"]`, client
 *  `["one","three"]`, no error anywhere, forever. Every other desync already
 *  ends in a throw, and every caller of `applyWirePatches` treats a throw as
 *  "request a full resync" — so this makes the one silent case join them.
 *
 *  Sound by construction: a length is only ever CHECKED while it is known
 *  exactly. It is seeded from `base`, updated across the ops that shift it,
 *  and set to "unknown" (never checked again) the moment an op writes at or
 *  above the container it describes. A correct patch stream can therefore
 *  never trip it — Immer emits `add` at most at `length`. */
function _impossibleOp(
  base: unknown,
  ops: readonly WirePatch[],
): string | null {
  const key = _pathKey;
  // Lengths we know EXACTLY, and the containers we no longer know anything
  // under. A length is seeded lazily from `base`, so it is only trustworthy
  // while nothing has written at or above it — `dirty` is what makes that
  // lazy read sound.
  const lens = new Map<string, number>();
  const dirty = new Set<string>();

  const isDirty = (k: string) => {
    // `_pathKey` prefixes are path prefixes, the root `""` included.
    for (const d of dirty) if (k.startsWith(d)) return true;
    return false;
  };
  const lengthOf = (parent: readonly (string | number)[]): number | null => {
    const k = key(parent);
    const known = lens.get(k);
    if (known !== undefined) return known;
    if (isDirty(k)) return null;
    const v = valueAt(base, parent);
    if (!Array.isArray(v)) return null;
    lens.set(k, v.length);
    return v.length;
  };
  /** Everything under `path` is no longer knowable — its own length included
   *  unless the caller re-states it. */
  const soil = (path: readonly (string | number)[]) => {
    const k = key(path);
    dirty.add(k);
    for (const t of [...lens.keys()]) {
      if (t.startsWith(k)) lens.delete(t);
    }
  };

  for (const p of ops) {
    if (p.path.length === 0) {
      lens.clear();
      dirty.clear();
      dirty.add("");
      continue;
    }
    const parent = p.path.slice(0, -1);
    const last = p.path[p.path.length - 1];
    const idx = typeof last === "number"
      ? last
      : /^\d+$/.test(String(last))
      ? Number(last)
      : null;
    const len = idx === null ? null : lengthOf(parent);

    if (idx !== null && len !== null) {
      const held = `the array at /${parent.join("/")} holds ${len} item(s)`;
      // An index write shifts (add/remove) or replaces the rows below it, so
      // nothing under this array survives as knowledge — but its LENGTH does,
      // and it is the only thing being checked.
      if (p.op === "add") {
        if (idx < 0 || idx > len) return `add at index ${idx} — ${held}`;
        soil(parent);
        lens.set(key(parent), len + 1);
        continue;
      }
      if (p.op === "remove") {
        if (idx < 0 || idx >= len) return `remove at index ${idx} — ${held}`;
        soil(parent);
        lens.set(key(parent), len - 1);
        continue;
      }
      if (p.op === "replace") {
        // `replace` AT `len` is a legal extend-by-one and the compactor emits
        // it, so only an index past the end is impossible.
        if (idx < 0 || idx > len) return `replace at index ${idx} — ${held}`;
        soil(p.path);
        if (idx === len) lens.set(key(parent), len + 1);
        continue;
      }
    }
    // A write at this path replaces whatever was under it.
    soil(p.path);
    if (Array.isArray(p.value)) lens.set(key(p.path), p.value.length);
  }
  return null;
}

/** Apply a `patches` frame — Immer ops and `append` alike — to `base`.
 *  The one function every consumer of a delta goes through. */
export function applyWirePatches<T>(base: T, ops: readonly WirePatch[]): T {
  // Checked HERE, not only by the browser's handleMessage: the CLI client and
  // the worker-cell host apply frames through this same function.
  const reserved = _reservedPathOp(ops);
  if (reserved) {
    throw new Error(
      `Cannot apply ${reserved.op} at /${
        reserved.path.join("/")
      }: "${RESERVED_PATH_SEGMENT}" is never a state key a patch may walk`,
    );
  }
  const impossible = _impossibleOp(base, ops);
  if (impossible) {
    throw new Error(
      `Cannot apply patches: ${impossible}. The two sides disagree about the ` +
        `state — a delta was lost. Requesting full state.`,
    );
  }
  return applyPatches(base as object, expandAppends(base, ops)) as T;
}
