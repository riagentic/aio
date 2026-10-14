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
  // BOTH key sets. Iterating `next` alone meant a cell that existed in `prev`
  // and is gone in `next` produced no diff at all — a removal is a change, and
  // the one it is most important not to report as "nothing happened".
  for (const cell of new Set([...Object.keys(prev), ...Object.keys(next)])) {
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

/** JSON replacer: BigInt has no JSON form, and its absence is a THROW. */
function bigintSafe(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? `${value}n` : value;
}

/** Is a property holding `v` certain to be WRITTEN by `JSON.stringify` (at
 *  least one character)? Not `undefined`, a function or a symbol (left out
 *  of an object), and nothing whose `toJSON` could answer one of those. */
function surelyWritten(v: unknown): boolean {
  if (v === null) return true;
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return true;
  if (t !== "object" && t !== "bigint") return false;
  return typeof (v as { toJSON?: unknown }).toJSON !== "function";
}

/** A `JSON.stringify` replacer that writes the same first `MAX_VAL`
 *  characters as `inner` alone would, without serializing what comes after
 *  them: this line shows 80 characters of a value, and it was made by
 *  serializing the WHOLE value, twice per changed key — 14 ms of a 20 ms
 *  dispatch for one flag flipped in a 50 000-row array.
 *
 *  It only ever CUTS a container, and only where the cut cannot be seen:
 *  - an array or a plain object with more entries than it takes to fill the
 *    line by themselves (`MAX_VAL + 1` written entries, each at least one
 *    character and a comma) keeps those entries and drops the rest;
 *  - once more than `MAX_VAL` characters are certainly written BEFORE a
 *    value, a container there is emptied.
 *  Everything kept is serialized by `JSON.stringify` itself (its `toJSON`,
 *  its holes, its escapes), so the text up to the cut is its own.
 *
 *  A cut container is a COPY, which `JSON.stringify` would not know as its
 *  own ancestor, so a cycle is refused here, as it refuses one (the caller's
 *  fallback then reads it). One beyond what the line shows is never met. */
function headOnly(
  inner: (this: unknown, key: string, value: unknown) => unknown,
): (this: unknown, key: string, value: unknown) => unknown {
  /** Characters certainly written so far (a lower bound). */
  let written = 0;
  /** The containers being written, outermost first: `as` is what stands in
   *  the text for `value` (and is `this` for its entries). */
  const open: { value: object; as: object }[] = [];
  const cut = (value: object, full: boolean): object => {
    if (Array.isArray(value)) {
      if (full) return value.length === 0 ? value : [];
      return value.length > MAX_VAL + 1 ? value.slice(0, MAX_VAL + 1) : value;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    // The keys that fill the line, in the order they are written. Read once
    // here and written from this copy (no prototype: `__proto__` is a key).
    const head: Record<string, unknown> = Object.create(null);
    let sure = 0;
    for (const k in value) {
      if (!Object.hasOwn(value, k)) continue;
      if (full || sure > MAX_VAL) break;
      const v = (value as Record<string, unknown>)[k];
      head[k] = v;
      if (surelyWritten(v)) sure++;
    }
    return head;
  };
  return function (key, raw) {
    while (open.length > 0 && open[open.length - 1]!.as !== this) open.pop();
    const value = inner.call(this, key, raw);
    const full = written > MAX_VAL;
    // An array always writes its element (`null` for what an object omits).
    if (Array.isArray(this) || surelyWritten(value)) written++;
    if (value === null || typeof value !== "object") return value;
    if (open.some((o) => o.value === value)) {
      throw new TypeError("Converting circular structure to JSON");
    }
    const as = cut(value, full);
    open.push({ value, as });
    return as;
  };
}

function truncate(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (typeof v === "string") {
    // QUOTED. Unquoted, `"1"→1` and `1→1` render identically, and so do
    // `"null"→x` and `null→x` — a reader cannot tell a string from the value it
    // looks like, which is precisely the diff you are staring at when a type
    // coercion is the bug.
    const s = v.length > MAX_VAL ? v.slice(0, MAX_VAL) + "…" : v;
    return JSON.stringify(s);
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "bigint") return `${v}n`;
  // A DIAGNOSTIC may not be the thing that kills the app. JSON.stringify throws
  // on BigInt, on a cycle, and on anything with a throwing toJSON — all of
  // which are legal in state. Serialize what can be serialized (BigInt as
  // `123n`, a cycle as `[Circular]`) and degrade to a label if even that fails.
  let s: string;
  try {
    s = JSON.stringify(v, headOnly(bigintSafe)) ?? String(v);
  } catch {
    try {
      const seen = new WeakSet<object>();
      s = JSON.stringify(
        v,
        headOnly(function (k, val) {
          if (typeof val === "object" && val !== null) {
            if (seen.has(val)) return "[Circular]";
            seen.add(val);
          }
          return bigintSafe(k, val);
        }),
      ) ?? String(v);
    } catch {
      s = `[unserializable ${typeof v}]`;
    }
  }
  return s.length > MAX_VAL ? s.slice(0, MAX_VAL) + "…" : s;
}

/** Format a cell's changes into a single log line */
export function formatDiff(cell: string, changes: KeyChange[]): string {
  const parts = changes.map((c) =>
    `${c.key} ${truncate(c.from)}→${truncate(c.to)}`
  );
  return `${cell}: ${parts.join(", ")}`;
}
