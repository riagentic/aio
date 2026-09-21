// A randomized differential over the SECRET boundary: nothing a bug report
// carries may be absent from the frame the wire would send.
//
// The report screens state and timeline through the cell's `visible` filter —
// the same declaration the broadcast applies. "Same declaration" is not "same
// reading": the report used to flatten a dot path to its top-level key (every
// row's ciphertext), and the path-level screen re-nests a diff path into a
// slice, where `"0"` is an object key while the frame walks an ARRAY
// element-wise. Reading code found neither. Generating state (records by id,
// arrays, dotted keys, `__proto__`/`constructor`/`toString`, numeric and empty
// keys), generating filters over it and comparing the two answers finds both,
// and keeps finding the next one.
//
// The invariant, per seed: every unique token reachable in the report is
// reachable in `applyCellFieldFilter(filter, slice)` — the projection
// `getUIState` builds a client's frame from (aio-composition.ts). Showing
// LESS is always allowed; showing one token more is a leak.
import { assert } from "@std/assert";
import { applyCellFieldFilter } from "../src/state/state-filter.ts";
import type { CellFieldFilter } from "../src/state/cell-types.ts";
import { buildReport } from "../src/server/report.ts";
import type { DiffEntry, TimelineEntry } from "../src/server/timeline.ts";

/** Deterministic PRNG — a failing seed is a reproducible case. */
function rng(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Every shape a key has ever been ambiguous in. */
const KEYS = [
  "a",
  "b",
  "rows",
  "secret",
  "a.b",
  "__proto__",
  "constructor",
  "toString",
  "valueOf",
  "0",
  "1",
  "",
  "id",
];

const pick = <T>(r: () => number, xs: readonly T[]): T =>
  xs[Math.floor(r() * xs.length)]!;

function genValue(r: () => number, depth: number, tok: () => string): unknown {
  const n = r();
  if (depth <= 0 || n < 0.28) return tok();
  if (n < 0.33) return null;
  if (n < 0.37) return 7;
  if (n < 0.41) return true;
  if (n < 0.45) return new Date(0);
  if (n < 0.49) return new Map([["k", tok()]]);
  if (n < 0.62) {
    return Array.from(
      { length: Math.floor(r() * 3) },
      () => genValue(r, depth - 1, tok),
    );
  }
  const obj: Record<string, unknown> = {};
  for (let i = 0, c = 1 + Math.floor(r() * 3); i < c; i++) {
    // `defineProperty`: a plain `obj["__proto__"] = v` sets the PROTOTYPE.
    Object.defineProperty(obj, pick(r, KEYS), {
      value: genValue(r, depth - 1, tok),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return obj;
}

/** Cell state is frozen (Immer autoFreeze) in dev AND prod — so is this. */
function deepFreeze<T>(v: T): T {
  if (v === null || typeof v !== "object" || Object.isFrozen(v)) return v;
  for (const k of Object.keys(v as Record<string, unknown>)) {
    deepFreeze((v as Record<string, unknown>)[k]);
  }
  return Object.freeze(v);
}

function genSlice(r: () => number, tok: () => string): Record<string, unknown> {
  const v = genValue(r, 3, tok);
  const slice = v !== null && typeof v === "object" && !Array.isArray(v)
    ? v as Record<string, unknown>
    : { a: v };
  return deepFreeze(slice);
}

function genFilter(
  r: () => number,
  slice: Record<string, unknown>,
): CellFieldFilter {
  const n = r();
  if (n < 0.06) return "all";
  if (n < 0.12) return "none";
  const keys = Object.keys(slice);
  const path = () => {
    const head = keys.length ? pick(r, keys) : "a";
    if (r() < 0.5) return head;
    if (r() < 0.6) return `${head}.${pick(r, KEYS)}`;
    return `${head}.${pick(r, KEYS)}.${pick(r, KEYS)}`;
  };
  const list = Array.from({ length: 1 + Math.floor(r() * 2) }, path);
  return r() < 0.5 ? { exclude: list } : { include: list };
}

/** Every path in the slice, as a timeline diff spells them. */
function diffLeaves(slice: Record<string, unknown>): DiffEntry[] {
  const out: DiffEntry[] = [];
  const walk = (v: unknown, segs: string[], depth: number) => {
    if (segs.length) {
      out.push({
        path: segs.join("."),
        before: undefined,
        after: v,
        ...(segs.some((s) => s.includes(".")) ? { segments: [...segs] } : {}),
      });
    }
    if (depth <= 0 || v === null || typeof v !== "object") return;
    const keys = Array.isArray(v)
      ? v.map((_, i) => String(i))
      : Object.keys(v as Record<string, unknown>);
    for (const k of keys) {
      walk((v as Record<string, unknown>)[k], [...segs, k], depth - 1);
    }
  };
  walk(slice, [], 4);
  // …and the whole-slice leaf (a root replacement).
  out.push({ path: "", before: undefined, after: slice });
  return out;
}

function tokensOf(v: unknown, into: Set<string>): Set<string> {
  if (typeof v === "string") {
    if (v.startsWith("TOK")) into.add(v);
    return into;
  }
  if (v === null || typeof v !== "object") return into;
  if (v instanceof Map) {
    for (const x of v.values()) tokensOf(x, into);
    return into;
  }
  if (Array.isArray(v)) {
    for (const x of v) tokensOf(x, into);
    return into;
  }
  for (const k of Object.keys(v as Record<string, unknown>)) {
    tokensOf((v as Record<string, unknown>)[k], into);
  }
  return into;
}

function sources(
  filter: CellFieldFilter,
  over: Record<string, unknown>,
): Parameters<typeof buildReport>[1] {
  return {
    appId: "fuzz",
    appVersion: "1",
    aioVersion: "1",
    dataDir: "/nonexistent",
    logsDir: "/nonexistent",
    exposed: false,
    persist: false,
    cells: ["c"],
    visibleFilters: { c: filter },
    ...over,
    // deno-lint-ignore no-explicit-any
  } as any;
}

Deno.test("report differential: state carries no token the wire frame lacks", async () => {
  for (let seed = 1; seed <= 250; seed++) {
    const r = rng(seed);
    let n = 0;
    const tok = () => `TOK${seed}_${n++}`;
    const slice = genSlice(r, tok);
    const filter = genFilter(r, slice);
    const frame = tokensOf(applyCellFieldFilter(filter, slice), new Set());
    const report = await buildReport(
      { kind: "user", title: "t" },
      sources(filter, { getState: () => ({ c: slice }) }),
    );
    const shown = tokensOf(report.state, new Set());
    const leaked = [...shown].filter((t) => !frame.has(t));
    assert(
      leaked.length === 0,
      `seed ${seed}: the report shows ${leaked.join(", ")}, which the wire ` +
        `frame does not carry\n  filter ${JSON.stringify(filter)}\n  slice  ${
          JSON.stringify(slice)
        }\n  frame  ${JSON.stringify(applyCellFieldFilter(filter, slice))}\n` +
        `  state  ${JSON.stringify(report.state)}`,
    );
  }
});

Deno.test("report differential: no timeline diff leaf carries one either", async () => {
  for (let seed = 1; seed <= 250; seed++) {
    const r = rng(seed);
    let n = 0;
    const tok = () => `TOK${seed}_${n++}`;
    const slice = genSlice(r, tok);
    const filter = genFilter(r, slice);
    const frame = tokensOf(applyCellFieldFilter(filter, slice), new Set());
    // One entry per leaf: the diff paths a run of actions over this slice
    // produces, each carrying the value that lives there.
    const entries: TimelineEntry[] = diffLeaves(slice).map((d, i) => ({
      seq: i + 1,
      ts: i + 1,
      type: "c:write",
      payload: { args: [] },
      diff: [{ ...d, path: d.path ? `c.${d.path}` : "c" }],
      ...(d.segments
        ? {
          diff: [{ ...d, path: `c.${d.path}`, segments: ["c", ...d.segments] }],
        }
        : {}),
    }));
    const report = await buildReport(
      { kind: "user", title: "t" },
      sources(filter, { getTimeline: () => entries }),
    );
    const shown = tokensOf(report.timeline, new Set());
    const leaked = [...shown].filter((t) => !frame.has(t));
    assert(
      leaked.length === 0,
      `seed ${seed}: a timeline leaf shows ${
        leaked.join(", ")
      }, which the wire frame does not carry\n  filter ${
        JSON.stringify(filter)
      }\n  slice  ${JSON.stringify(slice)}\n  frame  ${
        JSON.stringify(applyCellFieldFilter(filter, slice))
      }\n  timeline ${JSON.stringify(report.timeline)}`,
    );
  }
});
