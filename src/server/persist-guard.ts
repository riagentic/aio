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
// traversal, not two). Dev throws, prod reports and continues — the sanctioned
// direction for a dev/prod difference: dev is stricter, never more lenient.

/** One value in a state tree that JSON cannot faithfully round-trip. */
export interface PersistIssue {
  /** Dotted path from the state root, e.g. `cart.items.0.addedAt`. */
  path: string;
  /** What it is: "undefined" | "NaN" | "Infinity" | "Date" | "Map" | "Set" | "function" | "symbol" | "bigint" */
  kind: string;
  /** What JSON would store instead. */
  becomes: string;
}

const LOSSY: Record<string, string> = {
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

/**
 * Serialize `value` and report every field JSON would corrupt.
 *
 * Returns the JSON text (so the caller reuses this pass rather than
 * stringifying twice) plus the issues found. `BigInt` is not listed: JSON
 * THROWS on it, which is already loud, and the throw propagates.
 */
export function stringifyWithIssues(
  value: unknown,
): { json: string; issues: PersistIssue[] } {
  const issues: PersistIssue[] = [];
  // Path reconstruction: JSON.stringify calls the replacer with the holder as
  // `this`, so remember which object each holder was reached by. Depth-first
  // order makes the parent's path known before any of its children are seen.
  const pathOf = new WeakMap<object, string>();
  const json = JSON.stringify(value, function (this: unknown, key, val) {
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
  });
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
  return `state contains ${issues.length} value(s) that JSON cannot ` +
    `round-trip, so they would come back WRONG (or missing) on the next ` +
    `boot:\n${lines.join("\n")}${more}\n` +
    `  fix: store JSON-shaped data — a Date as \`.toISOString()\` or epoch ms, ` +
    `a Map/Set as an object/array, and use null (not undefined/NaN) for ` +
    `"no value". Fields you don't want persisted can be excluded with ` +
    `\`persist: { exclude: [...] }\`.`;
}
