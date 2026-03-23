// src/diagnostics/state-diff.ts — Key-level state diff detection + formatting

/** A single key change within a feature */
export type KeyChange = { key: string; from: unknown; to: unknown };

/** Diff result for one feature */
export type FeatureDiff = { feature: string; changes: KeyChange[] };

/** Compare prev and next app state, return per-feature key-level diffs.
 *  Skips features where the slice is referentially identical (cheap). */
export function computeDiffs(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): FeatureDiff[] {
  if (prev === next) return [];
  const diffs: FeatureDiff[] = [];
  for (const feature of Object.keys(next)) {
    const prevSlice = prev[feature];
    const nextSlice = next[feature];
    if (prevSlice === nextSlice) continue;
    if (
      !prevSlice || typeof prevSlice !== "object" || !nextSlice ||
      typeof nextSlice !== "object"
    ) {
      diffs.push({
        feature,
        changes: [{ key: "_root", from: prevSlice, to: nextSlice }],
      });
      continue;
    }
    const changes: KeyChange[] = [];
    const ps = prevSlice as Record<string, unknown>;
    const ns = nextSlice as Record<string, unknown>;
    const allKeys = new Set([...Object.keys(ps), ...Object.keys(ns)]);
    for (const key of allKeys) {
      if (ps[key] !== ns[key]) {
        changes.push({ key, from: ps[key], to: ns[key] });
      }
    }
    if (changes.length) diffs.push({ feature, changes });
  }
  return diffs;
}

const MAX_VAL = 80;

function truncate(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (typeof v === "string") {
    return v.length > MAX_VAL ? v.slice(0, MAX_VAL) + "…" : v;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = JSON.stringify(v);
  return s.length > MAX_VAL ? s.slice(0, MAX_VAL) + "…" : s;
}

/** Format a feature's changes into a single log line */
export function formatDiff(feature: string, changes: KeyChange[]): string {
  const parts = changes.map((c) =>
    `${c.key} ${truncate(c.from)}→${truncate(c.to)}`
  );
  return `${feature}: ${parts.join(", ")}`;
}
