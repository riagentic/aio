// persist-guard.ts — refuse to persist state JSON cannot round-trip.
//
// Persistence serializes with `JSON.stringify` and restores with `JSON.parse`,
// and JSON silently mangles values a JS app legitimately holds:
//
//   undefined  → the KEY DISAPPEARS
//   NaN / ±Infinity → null
//   Date       → an ISO string (a string, not a Date, on reload)
//   Map / Set  → {}
//
// None of that surfaces at write time; it surfaces as corrupt state on the
// NEXT BOOT, far from the code that caused it. The framework already refuses
// this class for effects — `dispatch.ts` clones with `structuredClone` and
// REPORTS + DROPS anything non-cloneable, explicitly "never silently coerced
// via JSON round-trip" — but the state persist path was still raw JSON.
//
// This closes it at the one place state is written, using the SAME stringify
// pass persistence already performs (the scan is a replacer, so it costs one
// traversal, not two).
//
// It behaves IDENTICALLY in dev and prod: it reports and the write still
// happens. There is no `isDev`/`__aioDev` here or in `persistence.ts`, and
// there should not be — refusing the write would turn one corrupted field
// into total data loss, and killing a running app over a `Date` in state is
// not a service to anyone. (This header used to claim "dev throws, prod
// reports and continues", on the project's most load-bearing rule, for a
// tripwire that has never existed. A reader auditing dev/prod parity would
// have taken this file as already settled. 50audits §12.)
//
// The half that IS a verdict lives next door: a value JSON refuses outright (a
// BigInt, a cycle) throws `PersistSerializeError`, because then nothing is
// written and saying "persisted" would be the lie. Round-trip LOSS is
// observe-only; a REFUSED write is reported on every cycle it happens.

/** One value in a state tree that JSON cannot faithfully round-trip. */

import { count } from "../diagnostics/fmt.ts";
export interface PersistIssue {
  /** Dotted path from the state root, e.g. `cart.items.0.addedAt`. */
  path: string;
  /** What it is: "undefined" | "NaN" | "Infinity" | "Date" | "Map" | "Set" | "function" | "symbol" | "bigint" | "circular" */
  kind: string;
  /** What JSON would store instead. */
  becomes: string;
}

const LOSSY: Record<string, string> = {
  bigint: "nothing — JSON refuses it and the whole write is REFUSED",
  circular: "nothing — JSON refuses it and the whole write is REFUSED",
  undefined: "the key is dropped entirely",
  NaN: "null",
  Infinity: "null",
  Date: "an ISO string (not a Date)",
  Map: "{} — every entry lost",
  Set: "{} — every member lost",
  function: "the key is dropped entirely",
  symbol: "the key is dropped entirely",
  RegExp: "{} — the pattern is lost",
  Error: "{} — message, stack and cause are all lost",
  ArrayBuffer: "{} — the bytes are lost",
  toJSON: "whatever its toJSON() returned, which JSON then dropped or nulled",
};

/** What a value BECOMES, for a class the list above does not name. */
function lossyNote(kind: string): string {
  if (LOSSY[kind]) return LOSSY[kind];
  if (/Array$/.test(kind)) {
    return `{"0":…,"1":…} — a plain object, not a ${kind}`;
  }
  return `a plain object — the ${kind} prototype (and every method on it) is lost`;
}

/** True for the two shapes JSON reproduces exactly: a plain object and an
 *  array. Everything else with a prototype — Map, Set, RegExp, Error, a typed
 *  array, an app's own class — serializes to something that is NOT what comes
 *  back, which is the whole point of this file. */
function isPlainData(raw: object): boolean {
  if (Array.isArray(raw)) return true;
  const proto = Object.getPrototypeOf(raw);
  return proto === Object.prototype || proto === null;
}

/** Classify a raw value, or null when JSON handles it faithfully.
 *
 *  A structural test, not a list of the four built-ins someone thought of:
 *  `classify` used to name Date/Map/Set and miss RegExp, Error, every typed
 *  array and ArrayBuffer — all of which land as `{}` or as an object with
 *  numeric keys, exactly the failure the Map/Set entries describe. Storing an
 *  Error (`s.lastError = e`) or a Uint8Array of file bytes is ordinary; both
 *  came back as plain objects on the next boot with nothing said at write
 *  time. */
function classify(raw: unknown): string | null {
  if (raw === undefined) return "undefined";
  if (typeof raw === "number") {
    if (Number.isNaN(raw)) return "NaN";
    if (!Number.isFinite(raw)) return "Infinity";
    return null;
  }
  if (typeof raw === "function") return "function";
  if (typeof raw === "symbol") return "symbol";
  // Named, even though JSON THROWS on it rather than mangling it: the throw
  // reaches the caller with no path in it, and "which field" is the whole
  // question a guard exists to answer.
  if (typeof raw === "bigint") return "bigint";
  if (raw === null || typeof raw !== "object") return null;
  if (isPlainData(raw)) return null;
  return raw.constructor?.name || "object";
}

/** The loss a `toJSON()` creates rather than reveals.
 *
 *  `classify` reads the ORIGINAL value off the holder (a Date must be named a
 *  Date, not "string"), which means a `toJSON()` that itself returns something
 *  JSON drops — `undefined`, `NaN` — was invisible: the key vanished and the
 *  guard said nothing. `val` is the post-`toJSON` value, so this sees it. */
function classifySerialized(raw: unknown, val: unknown): string | null {
  if (raw === val) return null;
  if (val === undefined) return "toJSON";
  if (typeof val === "number" && !Number.isFinite(val)) return "toJSON";
  return null;
}

// ── Values JSON REFUSES (as opposed to mangles) ──────────────────────
//
// A `BigInt` and a cyclic reference are different from everything above: JSON
// does not corrupt them, it throws — `Do not know how to serialize a BigInt` /
// `Converting circular structure to JSON` — with NO path in the message. That
// throw used to escape the guard entirely and land in the persistence
// manager's outer catch, where it was reported as "getDBState threw" and took
// EVERY cell's write down with it, on every window, forever.
//
// So the throw is caught here and re-thrown as this error, which knows exactly
// which field it was. Finding the field costs one extra walk, and that walk
// only ever runs on the failure path.

/** A value JSON refuses outright, located by path. */
export class PersistSerializeError extends Error {
  /** Dotted path from the value's own root, e.g. `settings.limit`. `""` when
   *  the offending value IS the root. */
  readonly path: string;
  /** "bigint" | "circular" | "threw" (a getter/toJSON that threw) | "unknown" */
  readonly kind: string;
  constructor(path: string, kind: string, cause: unknown) {
    super(
      `${path || "the value itself"} is ${
        kind === "bigint"
          ? "a BigInt"
          : kind === "circular"
          ? "a circular reference"
          : kind === "threw"
          ? "a value whose toJSON()/getter threw"
          : "a value"
      }, which JSON cannot represent at all — so nothing is written, not even ` +
        `a mangled version. fix: ${FIX[kind] ?? FIX.unknown}`,
      { cause },
    );
    this.name = "PersistSerializeError";
    this.path = path;
    this.kind = kind;
  }

  /** The same failure located from a PARENT's root. This error knows the path
   *  inside the value it was thrown for; the caller knows what that value is
   *  called (a cell name), and the operator needs both in one path. */
  withPrefix(prefix: string): PersistSerializeError {
    return new PersistSerializeError(
      this.path ? `${prefix}.${this.path}` : prefix,
      this.kind,
      this.cause,
    );
  }
}

const FIX: Record<string, string> = {
  bigint:
    `store it as a string (\`String(n)\`) or, when it fits, a number — and ` +
    `convert back on read`,
  circular:
    `state is a data tree, not an object graph: replace the back-reference ` +
    `with the id it points at, and look the parent up when you need it`,
  threw: `make the getter/toJSON total, or keep the value out of state`,
  unknown: `keep the value out of persisted state (\`persist: { exclude: ` +
    `[...] }\`) or store a JSON-shaped stand-in`,
};

/** Locate the first value JSON refuses, mirroring JSON.stringify's own walk
 *  (own enumerable keys, `toJSON` first, ancestors only for the cycle check).
 *  Returns null when nothing here explains a throw. */
export function findUnserializable(
  value: unknown,
): { path: string; kind: string } | null {
  const ancestors = new Set<object>();
  const walk = (
    v: unknown,
    path: string,
  ): { path: string; kind: string } | null => {
    if (typeof v === "bigint") return { path, kind: "bigint" };
    if (v === null || typeof v !== "object") return null;
    let val: unknown = v;
    const maybe = v as { toJSON?: (k?: string) => unknown };
    if (typeof maybe.toJSON === "function") {
      try {
        val = maybe.toJSON();
      } catch {
        return { path, kind: "threw" };
      }
      if (typeof val === "bigint") return { path, kind: "bigint" };
      if (val === null || typeof val !== "object") return null;
    }
    const obj = val as object;
    if (ancestors.has(obj)) return { path, kind: "circular" };
    ancestors.add(obj);
    try {
      const entries: [string, unknown][] = Array.isArray(obj)
        ? (obj as unknown[]).map((x, i) => [String(i), x])
        : Object.entries(obj as Record<string, unknown>);
      for (const [k, child] of entries) {
        const hit = walk(child, path ? `${path}.${k}` : k);
        if (hit) return hit;
      }
    } catch {
      return { path, kind: "threw" };
    } finally {
      ancestors.delete(obj);
    }
    return null;
  };
  return walk(value, "");
}

/**
 * Serialize `value` and report every field JSON would corrupt.
 *
 * Returns the JSON text (so the caller reuses this pass rather than
 * stringifying twice) plus the issues found. A value JSON REFUSES (a `BigInt`,
 * a cycle) is not an issue in that list — nothing is written at all — so it
 * throws {@linkcode PersistSerializeError}, which names the exact path.
 */
export function stringifyWithIssues(
  value: unknown,
): { json: string; issues: PersistIssue[] } {
  const issues: PersistIssue[] = [];
  // Path reconstruction: JSON.stringify calls the replacer with the holder as
  // `this`, so remember which object each holder was reached by. Depth-first
  // order makes the parent's path known before any of its children are seen.
  const pathOf = new WeakMap<object, string>();
  const replacer = function (this: unknown, key: string, val: unknown) {
    const holder = this as Record<string, unknown>;
    const base = (holder && typeof holder === "object")
      ? pathOf.get(holder as object) ?? ""
      : "";
    const here = key === "" ? "" : (base ? `${base}.${key}` : key);
    // `val` has already been through `toJSON` (a Date arrives as a string), so
    // classify the ORIGINAL value off the holder.
    const raw = key === "" ? val : holder?.[key];
    const kind = classify(raw) ?? classifySerialized(raw, val);
    if (kind && here) {
      // An array HOLE is not a dropped key — it becomes `null`, and telling
      // someone their key vanished sends them looking for the wrong thing.
      const becomes = kind === "undefined" && Array.isArray(holder)
        ? "null (an array hole, not a dropped key)"
        : lossyNote(kind);
      issues.push({ path: here, kind, becomes });
    }
    if (val !== null && typeof val === "object") {
      pathOf.set(val as object, here);
    }
    return val;
  };
  let json: string;
  try {
    json = JSON.stringify(value, replacer);
  } catch (e) {
    // JSON refused the value outright. The native message names no field, so
    // find it: without a path this reaches the operator as "Do not know how to
    // serialize a BigInt" with nothing to act on.
    const at = findUnserializable(value) ??
      { path: "", kind: e instanceof RangeError ? "threw" : "unknown" };
    throw new PersistSerializeError(at.path, at.kind, e);
  }
  return { json: json ?? "null", issues };
}

/** Format the issues as one teachable message. */
export function describeIssues(issues: PersistIssue[]): string {
  const shown = issues.slice(0, 8);
  const lines = shown.map((i) =>
    `  • ${i.path}: ${i.kind} → persisted as ${i.becomes}`
  );
  const more = issues.length > shown.length
    ? `\n  …and ${issues.length - shown.length} more`
    : "";
  return `state contains ${count(issues.length, "value")} that JSON cannot ` +
    `round-trip, so they would come back WRONG (or missing) on the next ` +
    `boot:\n${lines.join("\n")}${more}\n` +
    `  fix: store JSON-shaped data — a Date as \`.toISOString()\` or epoch ms, ` +
    `a Map/Set as an object/array, and use null (not undefined/NaN) for ` +
    `"no value". Fields you don't want persisted can be excluded with ` +
    `\`persist: { exclude: [...] }\`.`;
}
