import { assertEquals } from "@std/assert";
import {
  _checkWastedRenders,
  _getArrayRefStats,
  _memoCompare,
  _preserveArrayRefs,
  _projectWithSharing,
  _resetArrayRefStats,
} from "../src/browser.ts";

Deno.test("_preserveArrayRefs tracks preserved vs changed counts", () => {
  _resetArrayRefStats();
  const old = [{ id: 1, x: 10 }, { id: 2, x: 20 }, { id: 3, x: 30 }];
  const neu = [{ id: 1, x: 10 }, { id: 2, x: 99 }, { id: 3, x: 30 }];
  _preserveArrayRefs(neu, old);
  const stats = _getArrayRefStats();
  assertEquals(stats.preserved, 2); // elements 0 and 2 unchanged
  assertEquals(stats.changed, 1); // element 1 changed
  assertEquals(stats.total, 3);
});

Deno.test("_resetArrayRefStats clears accumulator", () => {
  _resetArrayRefStats();
  const stats = _getArrayRefStats();
  assertEquals(stats.preserved, 0);
  assertEquals(stats.changed, 0);
  assertEquals(stats.total, 0);
});

// ── _projectWithSharing tests ──

Deno.test("_projectWithSharing preserves element refs in array output", () => {
  _resetArrayRefStats();
  const transform = (members: { id: number; name: string; role: string }[]) =>
    members.map((x) => ({ ...x, label: `${x.name} (${x.role})` }));

  const members = [
    { id: 1, name: "Alice", role: "dev" },
    { id: 2, name: "Bob", role: "dev" },
    { id: 3, name: "Carol", role: "ops" },
  ];

  // First call — no previous result
  const result1 = _projectWithSharing(transform(members), null);
  assertEquals(result1.length, 3);
  assertEquals(result1[0]!.label, "Alice (dev)");

  // Second call — same content, new objects from transform
  // _projectWithSharing should preserve element refs via _preserveArrayRefs
  const result2 = _projectWithSharing(transform(members), result1);
  assertEquals(result2[0] === result1[0], true);
  assertEquals(result2[1] === result1[1], true);
  assertEquals(result2[2] === result1[2], true);
});

Deno.test("_projectWithSharing detects changed elements", () => {
  _resetArrayRefStats();
  const transform = (members: { id: number; name: string }[]) =>
    members.map((x) => ({ ...x }));

  const result1 = _projectWithSharing(
    transform([{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }]),
    null,
  );
  const result2 = _projectWithSharing(
    transform([{ id: 1, name: "Alice" }, { id: 2, name: "Bobby" }]),
    result1,
  );

  // Element 0 unchanged → ref preserved
  assertEquals(result2[0] === result1[0], true);
  // Element 1 changed → new ref
  assertEquals(result2[1] === result1[1], false);
  assertEquals(result2[1]!.name, "Bobby");
});

Deno.test("_projectWithSharing handles non-array results (passthrough)", () => {
  assertEquals(_projectWithSharing(10, null), 10);
  assertEquals(_projectWithSharing(10, 10), 10);
});

Deno.test("_projectWithSharing preserves object ref if shallow-equal", () => {
  const prev = { count: 5, label: "test" };
  const next = { count: 5, label: "test" }; // same values, new ref
  const result = _projectWithSharing(next, prev);
  assertEquals(result === prev, true); // prev ref preserved
});

// ── _memoCompare tests ──

Deno.test("_memoCompare: same refs → true", () => {
  const obj = { a: 1 };
  assertEquals(_memoCompare({ data: obj }, { data: obj }), true);
});

Deno.test("_memoCompare: different refs, same values → true", () => {
  assertEquals(
    _memoCompare({ data: { id: 1, name: "Alice" } }, {
      data: { id: 1, name: "Alice" },
    }),
    true,
  );
});

Deno.test("_memoCompare: different values → false", () => {
  assertEquals(
    _memoCompare({ data: { id: 1 } }, { data: { id: 2 } }),
    false,
  );
});

Deno.test("_memoCompare: different key count → false", () => {
  assertEquals(_memoCompare({ a: 1 }, { a: 1, b: 2 }), false);
});

Deno.test("_memoCompare: primitive props → uses ===", () => {
  assertEquals(_memoCompare({ x: 1, y: "hi" }, { x: 1, y: "hi" }), true);
  assertEquals(_memoCompare({ x: 1 }, { x: 2 }), false);
});

Deno.test("_memoCompare: arrays compared by ref (not deep)", () => {
  const arr = [1, 2, 3];
  assertEquals(_memoCompare({ items: arr }, { items: arr }), true);
  assertEquals(_memoCompare({ items: [1, 2] }, { items: [1, 2] }), false);
});

// ── _checkWastedRenders tests ──

Deno.test("_checkWastedRenders: high preservation + degraded → returns warning", () => {
  _resetArrayRefStats();
  // Simulate 5 cycles of 145/160 preserved
  const old = Array.from({ length: 160 }, (_, i) => ({ id: i, v: i }));
  const neu = old.map((x, i) => i < 15 ? { ...x, v: x.v + 1 } : { ...x });
  for (let c = 0; c < 5; c++) {
    _preserveArrayRefs([...neu.map((x) => ({ ...x }))], [
      ...old.map((x) => ({ ...x })),
    ]);
  }
  const warning = _checkWastedRenders("degraded");
  assertEquals(warning !== null, true);
  assertEquals(warning!.includes("preserved"), true);
  assertEquals(warning!.includes("useProjection"), true);
});

Deno.test("_checkWastedRenders: healthy status → null (no warning)", () => {
  _resetArrayRefStats();
  const old = [{ id: 1, v: 1 }];
  _preserveArrayRefs([{ id: 1, v: 1 }], old);
  const warning = _checkWastedRenders("healthy");
  assertEquals(warning, null);
});

Deno.test("_checkWastedRenders: low preservation ratio → null (legit churn)", () => {
  _resetArrayRefStats();
  // All elements changed — no wasted renders
  const old = Array.from({ length: 10 }, (_, i) => ({ id: i, v: i }));
  const neu = old.map((x) => ({ ...x, v: x.v + 100 })); // all different
  for (let c = 0; c < 5; c++) _preserveArrayRefs([...neu], [...old]);
  const warning = _checkWastedRenders("degraded");
  assertEquals(warning, null);
});
