// the state persist path was raw `JSON.stringify` → `JSON.parse`, which
// silently mangles values apps really hold: `undefined` keys disappear,
// NaN/Infinity become null, a Date comes back a string, Map/Set become {}.
// Nothing said so at write time; it surfaced as corrupt state on the next boot.
//
// The framework already refuses this class for effects (structuredClone +
// report-and-drop, "never silently coerced via JSON round-trip"). State now
// gets the same treatment: dev throws, prod reports and keeps going.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  describeIssues,
  stringifyWithIssues,
} from "../src/server/persist-guard.ts";

Deno.test("persist-guard: names every value JSON would corrupt, with its path", () => {
  const state = {
    cart: {
      items: [{ id: 1, addedAt: new Date(0) }],
      coupon: undefined,
      total: NaN,
      ratio: Infinity,
      tags: new Set(["a"]),
      index: new Map([["k", 1]]),
    },
    ok: { n: 1, s: "fine", b: true, nil: null, nested: { deep: [1, 2] } },
  };
  const { issues } = stringifyWithIssues(state);
  const byPath = Object.fromEntries(issues.map((i) => [i.path, i.kind]));

  assertEquals(byPath["cart.items.0.addedAt"], "Date");
  assertEquals(byPath["cart.coupon"], "undefined");
  assertEquals(byPath["cart.total"], "NaN");
  assertEquals(byPath["cart.ratio"], "Infinity");
  assertEquals(byPath["cart.tags"], "Set");
  assertEquals(byPath["cart.index"], "Map");

  // Everything JSON handles faithfully is silent — no crying wolf.
  assert(
    !issues.some((i) => i.path.startsWith("ok")),
    `JSON-safe values must not be reported: ${JSON.stringify(issues)}`,
  );
});

Deno.test("persist-guard: clean state produces no issues and identical JSON", () => {
  const state = { a: { b: [1, "x", true, null] }, c: 0 };
  const { json, issues } = stringifyWithIssues(state);
  assertEquals(issues, []);
  assertEquals(json, JSON.stringify(state), "serialization is unchanged");
});

Deno.test("persist-guard: the message says what breaks and how to fix it", () => {
  const { issues } = stringifyWithIssues({ user: { seenAt: new Date(0) } });
  const msg = describeIssues(issues);
  assertStringIncludes(msg, "user.seenAt");
  assertStringIncludes(msg, "Date");
  assertStringIncludes(msg, "toISOString");
});

Deno.test("persist-guard: a Date really does come back as a string (the bug)", () => {
  const before = { when: new Date(0) };
  const after = JSON.parse(JSON.stringify(before));
  assertEquals(typeof after.when, "string");
  assert(
    !(after.when instanceof Date),
    "this is what the guard exists to catch",
  );
});
