import { assertEquals } from "jsr:@std/assert@1";

// Self-contained types matching immer Patch shape
type Patch = {
  op: "replace" | "add" | "remove";
  path: (string | number)[];
  value?: unknown;
};
type PatchEntry = { cell: string; ops: Patch[] };
type CellPatchStrategy = "raw" | "skip" | "filter" | "full";
type FilterFields = { mode: "include" | "exclude"; fields: Set<string> };

/** Filter patch entries per-cell based on strategy map.
 *  Returns undefined → full-state fallback needed,
 *  [] → nothing to send, PatchEntry[] → filtered patches. */
function filterPatchesByStrategy(
  patches: PatchEntry[],
  strategies: Map<string, CellPatchStrategy>,
  filterFields: Map<string, FilterFields>,
): PatchEntry[] | undefined {
  // Pass 1: any patch targeting a "full" strategy cell → full fallback
  for (const entry of patches) {
    if (strategies.get(entry.cell) === "full") return undefined;
  }
  // Pass 2: filter per-cell
  const result: PatchEntry[] = [];
  for (const entry of patches) {
    const strategy = strategies.get(entry.cell);
    if (strategy === undefined) return undefined; // unknown cell → safety fallback
    if (strategy === "skip") continue;
    if (strategy === "raw") {
      result.push(entry);
      continue;
    }
    // strategy === "filter"
    const ff = filterFields.get(entry.cell);
    if (!ff) return undefined; // filter strategy but no field config → safety
    const kept: Patch[] = [];
    for (const op of entry.ops) {
      if (op.path.length === 0) return undefined; // root replacement → full fallback
      const seg = String(op.path[0]);
      if (ff.mode === "include" && ff.fields.has(seg)) kept.push(op);
      if (ff.mode === "exclude" && !ff.fields.has(seg)) kept.push(op);
    }
    if (kept.length > 0) result.push({ cell: entry.cell, ops: kept });
  }
  return result;
}

// ── Tests ──────────────────────────────────────────────────────────

Deno.test("raw strategy passes patches through", () => {
  const patches: PatchEntry[] = [
    { cell: "counter", ops: [{ op: "replace", path: ["count"], value: 1 }] },
  ];
  const strategies = new Map<string, CellPatchStrategy>([["counter", "raw"]]);
  const result = filterPatchesByStrategy(patches, strategies, new Map());
  assertEquals(result, [
    { cell: "counter", ops: [{ op: "replace", path: ["count"], value: 1 }] },
  ]);
});

Deno.test("skip strategy discards patches → empty array", () => {
  const patches: PatchEntry[] = [
    { cell: "debug", ops: [{ op: "replace", path: ["log"], value: "x" }] },
  ];
  const strategies = new Map<string, CellPatchStrategy>([["debug", "skip"]]);
  const result = filterPatchesByStrategy(patches, strategies, new Map());
  assertEquals(result, []);
});

Deno.test("filter+include keeps matching, drops non-matching", () => {
  const patches: PatchEntry[] = [
    {
      cell: "user",
      ops: [
        { op: "replace", path: ["name"], value: "Ada" },
        { op: "replace", path: ["secret"], value: "hidden" },
      ],
    },
  ];
  const strategies = new Map<string, CellPatchStrategy>([["user", "filter"]]);
  const ff = new Map<string, FilterFields>([
    ["user", { mode: "include", fields: new Set(["name"]) }],
  ]);
  const result = filterPatchesByStrategy(patches, strategies, ff);
  assertEquals(result, [
    { cell: "user", ops: [{ op: "replace", path: ["name"], value: "Ada" }] },
  ]);
});

Deno.test("filter+exclude drops excluded, keeps rest", () => {
  const patches: PatchEntry[] = [
    {
      cell: "user",
      ops: [
        { op: "replace", path: ["name"], value: "Ada" },
        { op: "replace", path: ["secret"], value: "hidden" },
      ],
    },
  ];
  const strategies = new Map<string, CellPatchStrategy>([["user", "filter"]]);
  const ff = new Map<string, FilterFields>([
    ["user", { mode: "exclude", fields: new Set(["secret"]) }],
  ]);
  const result = filterPatchesByStrategy(patches, strategies, ff);
  assertEquals(result, [
    { cell: "user", ops: [{ op: "replace", path: ["name"], value: "Ada" }] },
  ]);
});

Deno.test("full strategy cell with patches → undefined", () => {
  const patches: PatchEntry[] = [
    { cell: "big", ops: [{ op: "replace", path: ["x"], value: 1 }] },
  ];
  const strategies = new Map<string, CellPatchStrategy>([["big", "full"]]);
  const result = filterPatchesByStrategy(patches, strategies, new Map());
  assertEquals(result, undefined);
});

Deno.test("full cell exists but no patches this tick → other cells pass", () => {
  const patches: PatchEntry[] = [
    { cell: "counter", ops: [{ op: "replace", path: ["n"], value: 5 }] },
  ];
  // "big" is full but has no patches this tick — only counter is in patches
  const strategies = new Map<string, CellPatchStrategy>([
    ["big", "full"],
    ["counter", "raw"],
  ]);
  const result = filterPatchesByStrategy(patches, strategies, new Map());
  assertEquals(result, [
    { cell: "counter", ops: [{ op: "replace", path: ["n"], value: 5 }] },
  ]);
});

Deno.test("empty path (root replacement) → undefined", () => {
  const patches: PatchEntry[] = [
    { cell: "user", ops: [{ op: "replace", path: [], value: { new: true } }] },
  ];
  const strategies = new Map<string, CellPatchStrategy>([["user", "filter"]]);
  const ff = new Map<string, FilterFields>([
    ["user", { mode: "include", fields: new Set(["name"]) }],
  ]);
  const result = filterPatchesByStrategy(patches, strategies, ff);
  assertEquals(result, undefined);
});

Deno.test("mixed raw + filter cells both processed correctly", () => {
  const patches: PatchEntry[] = [
    { cell: "counter", ops: [{ op: "replace", path: ["n"], value: 3 }] },
    {
      cell: "user",
      ops: [
        { op: "replace", path: ["name"], value: "Bob" },
        { op: "replace", path: ["token"], value: "xyz" },
      ],
    },
  ];
  const strategies = new Map<string, CellPatchStrategy>([
    ["counter", "raw"],
    ["user", "filter"],
  ]);
  const ff = new Map<string, FilterFields>([
    ["user", { mode: "exclude", fields: new Set(["token"]) }],
  ]);
  const result = filterPatchesByStrategy(patches, strategies, ff);
  assertEquals(result, [
    { cell: "counter", ops: [{ op: "replace", path: ["n"], value: 3 }] },
    { cell: "user", ops: [{ op: "replace", path: ["name"], value: "Bob" }] },
  ]);
});

Deno.test("all ops filtered out → empty array", () => {
  const patches: PatchEntry[] = [
    {
      cell: "user",
      ops: [{ op: "replace", path: ["secret"], value: "x" }],
    },
  ];
  const strategies = new Map<string, CellPatchStrategy>([["user", "filter"]]);
  const ff = new Map<string, FilterFields>([
    ["user", { mode: "include", fields: new Set(["name"]) }],
  ]);
  const result = filterPatchesByStrategy(patches, strategies, ff);
  assertEquals(result, []);
});

Deno.test("unknown cell (not in strategy map) → undefined", () => {
  const patches: PatchEntry[] = [
    { cell: "mystery", ops: [{ op: "add", path: ["x"], value: 1 }] },
  ];
  const strategies = new Map<string, CellPatchStrategy>([["counter", "raw"]]);
  const result = filterPatchesByStrategy(patches, strategies, new Map());
  assertEquals(result, undefined);
});
