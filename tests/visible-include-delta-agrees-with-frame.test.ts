// `visible: { include: ["profile.name"] }` has two deciders that must agree:
// the full frame (`applyCellFieldFilter`) and the delta path
// (`filterPatchesByStrategy`). A client gets the frame once and deltas after.
//
// The delta path DROPPED every op whose value had nothing included left in
// it, reasoning "the client's projection is unchanged". It is not: the client
// holds what the value REPLACED. `s.profile = null` after `profile.name` was
// shown left the old name on screen forever (no op, no frame — the round had
// nothing visible to send), and a row pushed without the included field was
// never added, so every later index op landed one row off.
//
// Property: patching the projected previous state yields exactly the
// projection of the next state (or the round falls back to full state).
import { assertEquals } from "@std/assert";
import { enablePatches, produceWithPatches } from "immer";
import {
  applyCellFieldFilter,
  filterPatchesByStrategy,
} from "../src/state/state-filter.ts";
import { applyWirePatches, type WirePatch } from "../src/protocol/patch-ops.ts";

enablePatches();

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** Key-order-blind JSON, so the comparison is about content. */
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v).sort().map((k) => [
        k,
        canon((v as Record<string, unknown>)[k]),
      ]),
    );
  }
  return v;
}

type S = {
  title: string;
  profile: null | { name?: string; x?: number; nested?: unknown };
  rows: ({ id: number; name?: string } | number)[];
};

const MUTATIONS: ((d: S) => void)[] = [
  (d) => void (d.profile = { x: 2 }),
  (d) => void (d.profile = null),
  (d) => void (d.profile = { name: "Z", nested: { deep: 9 } }),
  (d) => void d.rows.push({ id: 9 }),
  (d) => void d.rows.push({ id: 9, name: "q" }),
  (d) => void (d.rows.length && (d.rows[0] = { id: 7 })),
  (d) => void (d.rows.length && d.rows.splice(0, 1)),
  (d) => void (d.profile && (d.profile.nested = 5)),
  (d) => void (d.profile && delete d.profile.name),
  (d) => void (d.profile && delete d.profile.nested),
  (d) => {
    const r = d.rows[0];
    if (r && typeof r === "object") delete r.name;
  },
  (d) => void (d.rows.length && (d.rows[0] = 5)),
  (d) => void (d.title = "T"),
];

const PATHS = ["profile.name", "rows.name", "profile.nested.deep", "title"];

Deno.test("visible.include: a delta patches the projection into the next frame (property)", () => {
  const r = makeRng(7);
  const int = (a: number, b: number) => a + Math.floor(r() * (b - a + 1));
  let checked = 0;
  for (let i = 0; i < 4000; i++) {
    const prev: S = {
      title: "t",
      profile: r() < 0.3
        ? null
        : r() < 0.5
        ? { x: 1 }
        : { name: "n", x: 1, nested: { deep: 1 } },
      rows: Array.from(
        { length: int(0, 3) },
        (_, i) => r() < 0.5 ? { id: i, name: "r" + i } : { id: i },
      ),
    };
    const keys = [
      ...new Set(Array.from({ length: int(1, 2) }, () => PATHS[int(0, 3)]!)),
    ];
    const filter = { include: keys };
    const deep = keys.filter((k) => k.includes(".")).map((k) => k.split("."));
    const fields = new Map([["c", {
      mode: "include" as const,
      fields: new Set(keys.filter((k) => !k.includes("."))),
      ...(deep.length ? { deepIncludes: deep } : {}),
    }]]);
    const mutate = MUTATIONS[int(0, MUTATIONS.length - 1)]!;
    const [next, ops] = produceWithPatches(prev, mutate) as unknown as [
      S,
      WirePatch[],
    ];
    if (ops.length === 0) continue;
    const filtered = filterPatchesByStrategy(
      [{ cell: "c", ops }],
      new Map([["c", "filter" as const]]),
      fields,
    );
    // The deliberate full-state fallback is always a correct answer.
    if (filtered === undefined) continue;
    const viewPrev = applyCellFieldFilter(filter, prev as never);
    const viewNext = applyCellFieldFilter(filter, next as never);
    const patched = applyWirePatches(viewPrev, filtered[0]?.ops ?? []);
    assertEquals(
      canon(patched),
      canon(viewNext),
      `case ${i}: include ${JSON.stringify(keys)}, ops ${JSON.stringify(ops)}`,
    );
    checked++;
  }
  // The property must have been exercised, not skipped into the fallback.
  if (checked < 2000) throw new Error(`only ${checked} cases checked`);
});

Deno.test("visible.include: clearing the parent of an included field reaches the client", () => {
  const prev = { profile: { name: "alice", secret: "x" } as unknown };
  const [next, ops] = produceWithPatches(prev, (d) => {
    d.profile = null;
  }) as unknown as [typeof prev, WirePatch[]];
  const filtered = filterPatchesByStrategy(
    [{ cell: "c", ops }],
    new Map([["c", "filter" as const]]),
    new Map([["c", {
      mode: "include" as const,
      fields: new Set<string>(),
      deepIncludes: [["profile", "name"]],
    }]]),
  );
  const filter = { include: ["profile.name"] };
  assertEquals(
    applyWirePatches(
      applyCellFieldFilter(filter, prev),
      filtered?.[0]?.ops ?? [],
    ),
    applyCellFieldFilter(filter, next),
  );
});
