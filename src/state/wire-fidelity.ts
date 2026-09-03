// State that the wire cannot carry — caught where it is written, not where it
// vanishes.
//
// Cell state is broadcast as JSON and persisted as JSON. A `Map` in state is a
// real `Map` to the method that wrote it and to any in-process test that reads
// it back — and `{}` to every client and to `state.db`. The contents are gone,
// with no error anywhere:
//
//   in-process : m: Map(1) { "k" => 1 }
//   over wire  : {"m":{}}
//
// So a `testCell` test asserting `state.m.get("k") === 1` passes while the same
// app is broken in a browser. That is green-test-broken-prod by construction,
// which the dev==prod doctrine names as the thing never to allow.
//
// The identical hazard for EFFECTS has been guarded since alpha-something
// (`cloneEffects`, cell-compose-reduce.ts) with the reasoning spelled out —
// "JSON loses undefined/NaN/Infinity/Date/Map/Set and silently corrupted the
// executor's payload contract". State is the surface that never got the same
// check, and state is the one that gets persisted.
//
// SCOPE — only values whose DATA is destroyed:
//
//   Map, Set          → `{}`; every entry lost
//   RegExp            → `{}`; the pattern is lost
//   ArrayBuffer/View  → `{}` / `{"0":…}`; the bytes are lost or unrecognisable
//   function, symbol  → the key disappears entirely
//   a SYMBOL KEY      → gone from full state; a patch for it addresses `null`
//   bigint            → JSON.stringify THROWS
//
// `Date`, `NaN` and `Infinity` change form (a Date becomes its ISO string, the
// others become `null`) but do not destroy data, and dates in state are far too
// common for a warning about them to stay readable. They are deliberately out
// of scope; the doc says so rather than leaving the omission to be discovered.
// The OTHER hazard those types carry — an in-place mutation (`s.when.setTime`,
// `s.bytes[0] = 1`) that Immer cannot see, so it commits no patch and reaches
// no client — is named where state is frozen instead (`deepFreeze`,
// immutable.ts), because that is the site that knows the value is unfreezable
// and it is the MUTATION, not the assignment, that is lossy.

import { log } from "../diagnostics/logger-api.ts";
import { isDevMode } from "../diagnostics/logger-types.ts";

/** What JSON would do to this value, or null when it survives intact. */
export type WireLoss = { path: string; kind: string; lost: string };

const KIND = (v: unknown): string | null => {
  if (v instanceof Map) return "Map";
  if (v instanceof Set) return "Set";
  if (v instanceof RegExp) return "RegExp";
  if (v instanceof ArrayBuffer) return "ArrayBuffer";
  if (ArrayBuffer.isView(v)) {
    return v instanceof DataView ? "DataView" : "typed array";
  }
  if (typeof v === "function") return "function";
  if (typeof v === "symbol") return "symbol";
  if (typeof v === "bigint") return "bigint";
  return null;
};

const LOST: Record<string, string> = {
  Map: "becomes {} — every entry is lost",
  Set: "becomes {} — every member is lost",
  RegExp: "becomes {} — the pattern and flags are lost",
  ArrayBuffer: "becomes {} — every byte is lost",
  DataView: "becomes {} — every byte is lost",
  "typed array":
    'becomes a plain object ({"0":…}) — length/set/subarray and the type are lost',
  function: "the key disappears entirely",
  symbol: "the key disappears entirely",
  "symbol key":
    "the property vanishes from broadcast state entirely, and its PATCH " +
    "arrives at every client with a null key instead",
  bigint: "JSON.stringify throws on it",
};

/** The first value under `root` that JSON cannot carry, or null.
 *
 *  Depth-first and short-circuiting: one report per commit is enough to send
 *  someone to the line, and walking a whole state tree on every dispatch is
 *  the kind of cost this codebase measures before paying. Callers pass a
 *  PATCH value, so the walk is O(change), not O(state). */
export function findWireLoss(
  root: unknown,
  path: string,
  seen = new Set<unknown>(),
): WireLoss | null {
  const kind = KIND(root);
  if (kind) return { path, kind, lost: LOST[kind]! };
  if (root === null || typeof root !== "object") return null;
  // A cycle cannot be JSON'd either, but `structuredClone`-shaped state can
  // legitimately share references; bail rather than loop.
  if (seen.has(root)) return null;
  seen.add(root);
  // A SYMBOL-KEYED property is invisible to `Object.entries` — the walk below
  // would step straight past it and report nothing, which is the same silence
  // this module exists to break: `JSON.stringify({ [Symbol("k")]: 1 })` is
  // `{}`, so the property is not "changed on the wire", it is absent.
  const syms = Object.getOwnPropertySymbols(root);
  if (syms.length > 0) {
    return {
      path: `${path}[${String(syms[0])}]`,
      kind: "symbol key",
      lost: LOST["symbol key"]!,
    };
  }
  if (Array.isArray(root)) {
    for (let i = 0; i < root.length; i++) {
      const hit = findWireLoss(root[i], `${path}[${i}]`, seen);
      if (hit) return hit;
    }
    return null;
  }
  for (const [k, v] of Object.entries(root as Record<string, unknown>)) {
    const hit = findWireLoss(v, path ? `${path}.${k}` : k, seen);
    if (hit) return hit;
  }
  return null;
}

/** The fix sentence for each kind. One generic "store plain data instead
 *  (Object.fromEntries(map), [...set])" was printed for every kind, including
 *  the ones it does not apply to — a symbol key has no `fromEntries` to reach
 *  for, and a byte buffer is not a Map. */
const FIX: Record<string, string> = {
  Map: "Store plain data instead: Object.fromEntries(map).",
  Set: "Store plain data instead: [...set].",
  RegExp: "Store the source string (and flags) and rebuild the RegExp on use.",
  ArrayBuffer:
    "Store bytes as a base64 string, or keep them out of cell state.",
  DataView: "Store bytes as a base64 string, or keep them out of cell state.",
  "typed array":
    "Store [...bytes] (a plain array) or a base64 string, and rebuild the view on use.",
  function: "Move behaviour to a method; keep state to plain data.",
  symbol: "Store a string instead — a symbol has no wire form.",
  "symbol key":
    "Key state by a STRING — a symbol key exists only in this process.",
  bigint: "Store the number, or the digits as a string.",
  default: "Store plain data instead.",
};

/** Once per cell+path+kind — a Map written every tick must not fill the log
 *  with the same line. Keyed by code positions, of which an app has finitely
 *  many. Exported for the test that proves the de-duplication. @internal */
export const _wireLossSeen = new Set<string>();

/** Warn about any patch value the wire cannot carry.
 *
 *  Called from BOTH commit paths in cell-compose-reduce (the state-machine one
 *  and the plain one) — the first version of this lived inline after one of
 *  them and silently covered half the cells, which is the "two deciders" shape
 *  this codebase keeps paying for. */
export function warnWireLoss(
  cellName: string,
  patches: readonly {
    path: readonly (string | number | symbol)[];
    value?: unknown;
  }[],
): void {
  // Where a developer can act on it: the test harness and the browser set
  // `__aioDev`; a dev server running from source does not, and that is exactly
  // the person most able to fix a Map in their own state. A compiled binary
  // matches neither and pays one boolean. The message is observe-only, so
  // showing it in both is the allowed half of the dev/prod split.
  if (
    !(globalThis as Record<string, unknown>).__aioDev && !isDevMode()
  ) return;
  for (const p of patches) {
    // `String(seg)`, never `join` — an Immer patch path carries the KEY, and a
    // symbol key made `join(".")` throw "Cannot convert a Symbol value to a
    // string" from inside the reporter. That throw escaped through the reduce,
    // so the method failed with `REDUCE_ERROR … check action payload shape` —
    // the wire-loss reporter killing the very write whose loss it exists to
    // describe, under a message about something else entirely.
    const where = p.path.map((seg) => String(seg)).join(".");
    const symKey = p.path.find((seg) => typeof seg === "symbol");
    const loss = symKey !== undefined
      ? { path: where, kind: "symbol key", lost: LOST["symbol key"]! }
      : findWireLoss(p.value, where);
    if (!loss) continue;
    const key = `${cellName}.${loss.path}:${loss.kind}`;
    if (_wireLossSeen.has(key)) continue;
    _wireLossSeen.add(key);
    log.warn(
      "cell",
      `${cellName}: state.${loss.path} ${
        loss.kind === "symbol key"
          ? "is keyed by a symbol"
          : `holds a ${loss.kind}`
      }, which the wire ` +
        `cannot carry — ${loss.lost}. State is broadcast and persisted as ` +
        `JSON, so this value is intact here and gone in every client and in ` +
        `state.db. ${FIX[loss.kind] ?? FIX.default}`,
    );
  }
}
