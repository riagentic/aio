// Cycle detection in `deepMerge` must answer "am I INSIDE this object right
// now?", not "have I ever seen it?".
//
// A visited-set answers the second question, and the second question also fires
// on a DAG — the same object reachable by two paths, which `structuredClone`
// preserves and which every in-memory restore path can therefore produce. The
// second reference merged to the DECLARED DEFAULT, so a stored value silently
// became a zero. That is the vanishing-write class, wearing cycle-safety as a
// disguise.
import { assert, assertEquals } from "@std/assert";
import { deepMerge } from "../src/state/deep-merge.ts";

Deno.test("deepMerge: a shared (non-cyclic) reference restores at EVERY path", () => {
  const shared = { n: 99, deep: { m: 7 } };
  const persisted = { a: shared, b: shared };
  const initial = {
    a: { n: 0, deep: { m: 0 } },
    b: { n: 0, deep: { m: 0 } },
  };
  const out = deepMerge(initial, persisted) as {
    a: { n: number; deep: { m: number } };
    b: { n: number; deep: { m: number } };
  };
  assertEquals(out.a.n, 99);
  assertEquals(
    out.b.n,
    99,
    "the SECOND reference to a shared object must restore too — a visited-set " +
      "returned the schema default here and the stored value vanished",
  );
  assertEquals(out.a.deep.m, 7);
  assertEquals(out.b.deep.m, 7, "nested shared subtrees restore as well");
});

Deno.test("deepMerge: the same object at three sibling paths, all restored", () => {
  const shared = { v: "KEEP" };
  const out = deepMerge(
    { x: { v: "" }, y: { v: "" }, z: { v: "" } },
    { x: shared, y: shared, z: shared },
  ) as { x: { v: string }; y: { v: string }; z: { v: string } };
  assertEquals([out.x.v, out.y.v, out.z.v], ["KEEP", "KEEP", "KEEP"]);
});

Deno.test("deepMerge: a shared ref reachable at DIFFERENT depths still restores", () => {
  // The path-based set is unwound on exit, so depth cannot make one occurrence
  // shadow another.
  const shared = { v: 5 };
  const out = deepMerge(
    { top: { v: 0 }, nest: { inner: { v: 0 } } },
    { top: shared, nest: { inner: shared } },
  ) as { top: { v: number }; nest: { inner: { v: number } } };
  assertEquals(out.top.v, 5);
  assertEquals(out.nest.inner.v, 5);
});

Deno.test("deepMerge: a REAL cycle is still cut (no hang, no throw)", () => {
  const cyc: Record<string, unknown> = { n: 7 };
  cyc.self = cyc;
  const out = deepMerge({ n: 0, self: { n: 0 } }, cyc) as {
    n: number;
    self: { n: number };
  };
  // The non-cyclic part restores; the cyclic branch falls back to the default,
  // because there is nothing else it could honestly be.
  assertEquals(out.n, 7);
  assertEquals(out.self.n, 0);
});

Deno.test("deepMerge: a mutual cycle terminates", () => {
  const a: Record<string, unknown> = { tag: "a" };
  const b: Record<string, unknown> = { tag: "b", a };
  a.b = b;
  const out = deepMerge(
    { tag: "", b: { tag: "", a: { tag: "" } } },
    a,
  ) as Record<string, unknown>;
  assertEquals(out.tag, "a");
});

Deno.test("deepMerge: a reference-sharing DAG stays bounded (no exponential blowup)", () => {
  // Correct cycle detection merges a shared subtree once PER REFERENCE, which
  // is right for data but costs 2^depth when every level shares. The node
  // budget bounds it; without one this test would not finish.
  //
  // Built bottom-up: each level references the level below TWICE.
  let node: Record<string, unknown> = { leaf: 1 };
  let tmpl: Record<string, unknown> = { leaf: 0 };
  for (let i = 0; i < 30; i++) {
    node = { l: node, r: node };
    tmpl = { l: tmpl, r: tmpl };
  }
  const started = performance.now();
  const out = deepMerge(tmpl, node);
  const elapsed = performance.now() - started;
  assert(out, "must return a value");
  // 30 levels of 2-way sharing is 2^30 merges unguarded — minutes. With the
  // budget it stops at MAX_NODES regardless of depth, so a tight bound here is
  // what makes this test prove the guard rather than merely tolerate it.
  assert(
    elapsed < 5_000,
    `a shared-reference DAG must stay bounded; took ${Math.round(elapsed)}ms`,
  );
});
