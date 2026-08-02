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
};

/** Classify a raw value, or null when JSON handles it faithfully. */
function classify(raw: unknown): string | null {
  if (raw === undefined) return "undefined";
  if (typeof raw === "number") {
    if (Number.isNaN(raw)) return "NaN";
    if (!Number.isFinite(raw)) return "Infinity";
    return null;
  }
  if (typeof raw === "function") return "function";
  if (typeof raw === "symbol") return "symbol";
  if (raw instanceof Date) return "Date";
  if (raw instanceof Map) return "Map";
  if (raw instanceof Set) return "Set";
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
    const kind = classify(raw);
    if (kind && here) {
      issues.push({
        path: here,
        kind,
        becomes: LOSSY[kind] ?? "a wrong value",
      });
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
