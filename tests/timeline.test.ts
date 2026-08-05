// Timeline — the in-memory dispatch ring + its state-diff engine,
// and the trojan `timeline` route that surfaces them to `am timeline`.
import { assert, assertEquals } from "@std/assert";
import { createTimeline, diffState } from "../src/server/timeline.ts";
import { handleTrojan, type TrojanDeps } from "../src/server/server-trojan.ts";

// ── diffState ──────────────────────────────────────────────────────────────

Deno.test("diffState: identical (reference-equal) → no diff", () => {
  const s = { a: 1, b: { c: 2 } };
  assertEquals(diffState(s, s), []);
});

Deno.test("diffState: a changed leaf yields its path + before/after", () => {
  assertEquals(
    diffState({ n: 1, keep: "x" }, { n: 2, keep: "x" }),
    [{ path: "n", before: 1, after: 2 }],
  );
});

Deno.test("diffState: nested change reports a dotted path", () => {
  assertEquals(
    diffState({ cart: { total: 0 } }, { cart: { total: 12 } }),
    [{ path: "cart.total", before: 0, after: 12 }],
  );
});

Deno.test("diffState: unchanged sibling subtrees are pruned (structural sharing)", () => {
  const big = { rows: [1, 2, 3] };
  const prev = { a: big, n: 1 };
  const next = { a: big, n: 2 }; // `a` is the SAME ref → must not be walked
  assertEquals(diffState(prev, next), [{ path: "n", before: 1, after: 2 }]);
});

Deno.test("diffState: added + removed keys both surface", () => {
  const d = diffState({ a: 1 }, { b: 2 });
  const paths = d.map((x) => x.path).sort();
  assertEquals(paths, ["a", "b"]);
});

Deno.test("diffState: type change (object → primitive) is a leaf, not a recurse", () => {
  assertEquals(
    diffState({ v: { x: 1 } }, { v: 5 }),
    [{ path: "v", before: { x: 1 }, after: 5 }],
  );
});

Deno.test("diffState: array element change reports an indexed path", () => {
  assertEquals(
    diffState({ xs: [1, 2, 3] }, { xs: [1, 9, 3] }),
    [{ path: "xs.1", before: 2, after: 9 }],
  );
});

Deno.test("diffState: a huge single-shot change is truncated + flagged, never unbounded", () => {
  const prev: Record<string, number> = {};
  const next: Record<string, number> = {};
  for (let i = 0; i < 1000; i++) {
    prev[`k${i}`] = i;
    next[`k${i}`] = i + 1;
  }
  const d = diffState(prev, next);
  assert(d.length <= 201, `capped, got ${d.length}`);
  assertEquals(d[d.length - 1]!.path, "…", "truncation marker present");
});

// ── createTimeline ───────────────────────────────────────────────────────────

Deno.test("timeline: records entries with computed diffs, newest last", () => {
  const tl = createTimeline();
  tl.record(1, "cart:add", { args: [1] }, { n: 0 }, { n: 1 }, 100);
  tl.record(2, "cart:add", { args: [2] }, { n: 1 }, { n: 3 }, 200);
  const all = tl.entries();
  assertEquals(all.length, 2);
  assertEquals(all[0]!.seq, 1);
  assertEquals(all[1]!.diff, [{ path: "n", before: 1, after: 3 }]);
  assertEquals(tl.lastSeq(), 2);
});

Deno.test("timeline: ?after filters to newer seqs; limit keeps the last N", () => {
  const tl = createTimeline();
  for (let i = 1; i <= 5; i++) tl.record(i, "t", null, { i: i - 1 }, { i }, i);
  assertEquals(tl.entries(3).map((e) => e.seq), [4, 5]);
  assertEquals(tl.entries(undefined, 2).map((e) => e.seq), [4, 5]);
});

Deno.test("timeline: ring is bounded to capacity (oldest dropped)", () => {
  const tl = createTimeline(3);
  for (let i = 1; i <= 6; i++) tl.record(i, "t", null, {}, { i }, i);
  assertEquals(tl.size(), 3);
  assertEquals(tl.entries().map((e) => e.seq), [4, 5, 6]);
});

Deno.test("timeline: clear() empties the ring and resets lastSeq", () => {
  const tl = createTimeline();
  tl.record(9, "t", null, {}, { x: 1 }, 1);
  tl.clear();
  assertEquals(tl.size(), 0);
  assertEquals(tl.lastSeq(), 0);
});

// ── trojan `timeline` route ─────────────────────────────────────────────────

function depsWith(tl: ReturnType<typeof createTimeline>): TrojanDeps {
  return {
    dispatch: () => Promise.resolve(),
    getUIState: () => ({}),
    debug: () => {},
    prod: false,
    trojan: {
      getState: () => ({}),
      getSchedules: () => [],
      startedAt: Date.now(),
      getTimeline: (after?: number, limit?: number) => tl.entries(after, limit),
    },
  } as unknown as TrojanDeps;
}

async function getRoute(deps: TrojanDeps, route: string) {
  const req = new Request(`http://x/__aio/trojan/${route}`);
  const resp = await handleTrojan(
    `/__aio/trojan/${route.split("?")[0]}`,
    req,
    deps,
  )!;
  return {
    status: resp.status,
    body: await resp.json() as Record<string, unknown>,
  };
}

Deno.test("trojan timeline: returns recorded entries with diffs", async () => {
  const tl = createTimeline();
  tl.record(1, "cart:add", { args: [1] }, { n: 0 }, { n: 1 }, 100);
  const r = await getRoute(depsWith(tl), "timeline");
  assertEquals(r.status, 200);
  const entries = r.body.entries as Array<{ seq: number; diff: unknown }>;
  assertEquals(entries.length, 1);
  assertEquals(entries[0]!.seq, 1);
  assertEquals(entries[0]!.diff, [{ path: "n", before: 0, after: 1 }]);
});

Deno.test("trojan timeline: ?after + ?limit query params flow through", async () => {
  const tl = createTimeline();
  for (let i = 1; i <= 5; i++) tl.record(i, "t", null, { i: i - 1 }, { i }, i);
  const r = await getRoute(depsWith(tl), "timeline?after=3");
  const entries = r.body.entries as Array<{ seq: number }>;
  assertEquals(entries.map((e) => e.seq), [4, 5]);
});

Deno.test("trojan timeline: absent capability → empty entries (not a crash)", async () => {
  const deps = {
    dispatch: () => Promise.resolve(),
    getUIState: () => ({}),
    debug: () => {},
    prod: false,
    trojan: {
      getState: () => ({}),
      getSchedules: () => [],
      startedAt: Date.now(),
    },
  } as unknown as TrojanDeps;
  const r = await getRoute(deps, "timeline");
  assertEquals(r.status, 200);
  assertEquals(r.body.entries, []);
});

// ── trojan `migrations` route ────────────────────────────────────

Deno.test("trojan migrations: returns the boot migration + drift summary", async () => {
  const summary = {
    declared: { wallet: 2 },
    stored: { wallet: 1 },
    report: [{ cell: "wallet", from: 1, to: 2, outcome: "migrated" }],
    drift: [{
      cell: "wallet",
      path: "seedPhrase",
      issue: "unknown-field",
      storedType: "string",
    }],
  };
  const deps = {
    dispatch: () => Promise.resolve(),
    getUIState: () => ({}),
    debug: () => {},
    prod: false,
    trojan: {
      getState: () => ({}),
      getSchedules: () => [],
      startedAt: Date.now(),
      getMigrations: () => summary,
    },
  } as unknown as TrojanDeps;
  const r = await getRoute(deps, "migrations");
  assertEquals(r.status, 200);
  assertEquals(r.body, summary);
});

Deno.test("trojan migrations: absent capability → empty summary (not a crash)", async () => {
  const deps = {
    dispatch: () => Promise.resolve(),
    getUIState: () => ({}),
    debug: () => {},
    prod: false,
    trojan: {
      getState: () => ({}),
      getSchedules: () => [],
      startedAt: Date.now(),
    },
  } as unknown as TrojanDeps;
  const r = await getRoute(deps, "migrations");
  assertEquals(r.status, 200);
  assertEquals(r.body, { declared: {}, stored: {}, report: [], drift: [] });
});

// ─── Non-plain objects are LEAVES, not empty containers ─────────────────────
//
// `Object.keys(new Date())` is `[]`. Descending into a changed Date therefore
// found nothing to compare and emitted no entry at all — `am timeline` printed
// `"diff": []` for an action that moved a timestamp. Reachable for any
// non-persisted field, which is exactly what the persist guard tells you to do
// when you want to hold a Date (`persist: { exclude: [...] }`).

Deno.test("timeline diff: a changed Date is reported, not silently skipped", () => {
  const prev = { s: { at: new Date("2020-01-01T00:00:00Z"), n: 1 } };
  const next = { s: { at: new Date("2026-06-06T00:00:00Z"), n: 1 } };
  const d = diffState(prev, next);
  assertEquals(d.length, 1, "a changed Date must produce exactly one entry");
  assertEquals(d[0]!.path, "s.at");
  assertEquals((d[0]!.after as Date).getTime(), Date.UTC(2026, 5, 6));
});

Deno.test("timeline diff: Map, Set and class instances are leaves too", () => {
  const mapDiff = diffState(
    { s: { m: new Map([["a", 1]]) } },
    { s: { m: new Map([["a", 2]]) } },
  );
  assertEquals(mapDiff.length, 1);
  assertEquals(mapDiff[0]!.path, "s.m");

  const setDiff = diffState(
    { s: { z: new Set([1]) } },
    { s: { z: new Set([1, 2]) } },
  );
  assertEquals(setDiff.length, 1);
  assertEquals(setDiff[0]!.path, "s.z");

  class Point {
    constructor(public x: number) {}
  }
  const clsDiff = diffState({ s: { p: new Point(1) } }, {
    s: { p: new Point(2) },
  });
  assertEquals(clsDiff.length, 1);
  assertEquals(clsDiff[0]!.path, "s.p");
});

Deno.test("timeline diff: plain objects still recurse to the changed leaf", () => {
  const d = diffState(
    { s: { a: { b: { c: 1 }, keep: 9 } } },
    { s: { a: { b: { c: 2 }, keep: 9 } } },
  );
  assertEquals(d.length, 1);
  assertEquals(d[0]!.path, "s.a.b.c");
  assertEquals(d[0]!.before, 1);
  assertEquals(d[0]!.after, 2);
});

Deno.test("timeline diff: a null-prototype object is still traversed", () => {
  const mk = (n: number) => {
    const o = Object.create(null) as Record<string, unknown>;
    o.n = n;
    return o;
  };
  const d = diffState({ s: { o: mk(1) } }, { s: { o: mk(2) } });
  assertEquals(d.length, 1);
  assertEquals(d[0]!.path, "s.o.n");
});
