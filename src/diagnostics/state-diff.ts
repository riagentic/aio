// src/diagnostics/state-diff.ts — Key-level state diff detection + formatting

/** A single key change within a cell */
export type KeyChange = { key: string; from: unknown; to: unknown };

/** Diff result for one cell */
export type CellDiff = { cell: string; changes: KeyChange[] };

/** Compare prev and next app state, return per-cell key-level diffs.
 *  Skips cells where the slice is referentially identical (cheap). */
export function computeDiffs(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): CellDiff[] {
  if (prev === next) return [];
  const diffs: CellDiff[] = [];
  for (const cell of Object.keys(next)) {
    const prevSlice = prev[cell];
    const nextSlice = next[cell];
    if (prevSlice === nextSlice) continue;
    if (
      !prevSlice || typeof prevSlice !== "object" || !nextSlice ||
      typeof nextSlice !== "object"
    ) {
      diffs.push({
        cell,
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
    if (changes.length) diffs.push({ cell, changes });
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

/** Format a cell's changes into a single log line */
export function formatDiff(cell: string, changes: KeyChange[]): string {
  const parts = changes.map((c) =>
    `${c.key} ${truncate(c.from)}→${truncate(c.to)}`
  );
  return `${cell}: ${parts.join(", ")}`;
}
