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
import { PROD_CHECKS } from "./action-encode.ts";
import { MAX_NODES } from "../protocol/wire-value.ts";
import { isRunningFromSource } from "../diagnostics/logger-types.ts";

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
 *  PATCH value, so the walk is O(change), not O(state).
 *
 *  ITERATIVE, and the path is built only for a hit. The recursive walk threw
 *  `Maximum call stack size exceeded` on a value ~6000 deep — one
 *  `JSON.stringify` carries without complaint — and built a path string for
 *  every node of a value that had nothing wrong with it. `budget.left` is the
 *  number of values it may still look at; it stops, answering null, at zero. */
export function findWireLoss(
  root: unknown,
  path: string,
  seen = new Set<unknown>(),
  budget: { left: number } = { left: Infinity },
): WireLoss | null {
  type Frame = {
    v: Record<string | number, unknown>;
    keys: string[] | null;
    i: number;
    key?: string | number;
  };
  const stack: Frame[] = [];
  const at = (leaf?: string | number): string => {
    let out = path;
    const step = (k: string | number | undefined) => {
      if (k === undefined) return;
      out = typeof k === "number" ? `${out}[${k}]` : out ? `${out}.${k}` : k;
    };
    for (const f of stack) step(f.key);
    step(leaf);
    return out;
  };
  let v = root;
  let key: string | number | undefined;
  for (;;) {
    if (budget.left-- <= 0) return null;
    const kind = KIND(v);
    if (kind) return { path: at(key), kind, lost: LOST[kind]! };
    // A cycle cannot be JSON'd either, but `structuredClone`-shaped state can
    // legitimately share references; skip rather than loop.
    if (v !== null && typeof v === "object" && !seen.has(v)) {
      seen.add(v);
      // A SYMBOL-KEYED property is invisible to `Object.keys` — the walk
      // would step straight past it and report nothing, which is the same
      // silence this module exists to break: `JSON.stringify({ [Symbol("k")]:
      // 1 })` is `{}`, so the property is not "changed on the wire", it is
      // absent.
      const syms = Object.getOwnPropertySymbols(v);
      if (syms.length > 0) {
        return {
          path: `${at(key)}[${String(syms[0])}]`,
          kind: "symbol key",
          lost: LOST["symbol key"]!,
        };
      }
      stack.push({
        v: v as Frame["v"],
        keys: Array.isArray(v) ? null : Object.keys(v),
        i: 0,
        key,
      });
    }
    // The next value: the deepest open container's next child.
    for (;;) {
      const f = stack[stack.length - 1];
      if (!f) return null;
      const n = f.keys ? f.keys.length : (f.v as unknown as unknown[]).length;
      if (f.i < n) {
        key = f.keys ? f.keys[f.i]! : f.i;
        f.i++;
        v = f.v[key];
        break;
      }
      stack.pop();
    }
  }
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
const firstSeen = (key: string): boolean =>
  !_wireLossSeen.has(key) && !!_wireLossSeen.add(key);

/** Commits checked so far, per cell — cleared by `_resetAioRuntime`. @internal */
export const _wireLossChecked = new Map<string, number>();

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
  /** @internal A test's stand-in for "this is a compiled build". */
  fromSource: boolean = isRunningFromSource(),
): void {
  // Dev (`__aioDev`: every harness, the browser shell, the dev server) and a
  // run from source check every commit. A compiled binary used to check
  // NOTHING — "pays one boolean" — so a Map in state was intact on the server
  // and gone in every client and in state.db with no line anywhere, which is
  // the one place nobody is watching a console. It now checks a cell's first
  // commits only (the walk visits every patched value, on the dispatch path)
  // and says what it finds, once per path: observe-only either way.
  const compiled = !(globalThis as Record<string, unknown>).__aioDev &&
    !fromSource;
  if (compiled) {
    const n = _wireLossChecked.get(cellName) ?? 0;
    // A compiled build checks each cell's first commits only.
    if (n >= PROD_CHECKS) return;
    _wireLossChecked.set(cellName, n + 1);
  }
  // Observe-only, whatever the value is. The walk READS it — an own getter
  // that throws, a revoked Proxy — and a throw from here escaped through the
  // reduce: the method failed over a diagnostic about a commit that was fine.
  // A compiled build also looks at no more than `MAX_NODES` values per commit:
  // a first load of a million rows is not where a second is worth spending.
  const budget = { left: compiled ? MAX_NODES : Infinity };
  try {
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
        : findWireLoss(p.value, where, new Set(), budget);
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
  } catch (e) {
    if (!firstSeen(`${cellName}:unreadable`)) return;
    log.warn(
      "cell",
      `${cellName}: the check for values the wire cannot carry stopped on a ` +
        `value it could not read (${
          e instanceof Error ? e.message : String(e)
        }). The commit itself is unaffected; if that value is broadcast, ` +
        `JSON will meet the same thing.`,
    );
  }
}
