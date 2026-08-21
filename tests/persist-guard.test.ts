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

Deno.test("persist-guard: names the built-ins JSON would corrupt, with its path", () => {
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

// ── the guard is STRUCTURAL, not a list of four names ────────────────────
//
// `classify` used to be an allow-list — Date, Map, Set — so everything else
// with a prototype sailed through: a RegExp and an Error persisted as `{}`
// (exactly the loss the Map/Set entries describe), a Uint8Array as
// `{"0":1,"1":2}`, an ArrayBuffer as `{}`. `s.lastError = err` and a byte
// array are ordinary things to hold, and both came back as plain objects on
// the next boot with nothing said at write time — the failure this file exists
// to end, reintroduced by the shape of its own check.
Deno.test("persist-guard: every non-plain object is named, not just the three", () => {
  const cases: [string, unknown, string][] = [
    ["RegExp", /ab+c/gi, "RegExp"],
    ["Error", new Error("boom"), "Error"],
    ["Uint8Array", new Uint8Array([1, 2, 3]), "Uint8Array"],
    ["Float64Array", new Float64Array([1.5]), "Float64Array"],
    ["ArrayBuffer", new ArrayBuffer(4), "ArrayBuffer"],
    ["URL", new URL("https://x.test/"), "URL"],
    [
      "a class instance",
      new (class Session {
        token = "t";
        valid() {
          return true;
        }
      })(),
      "Session",
    ],
  ];
  for (const [label, value, kind] of cases) {
    const { issues } = stringifyWithIssues({ field: value });
    assertEquals(issues.length, 1, `${label}: expected exactly one issue`);
    assertEquals(issues[0]!.path, "field", label);
    assertEquals(issues[0]!.kind, kind, label);
    assert(issues[0]!.becomes.length > 8, `${label}: says what it becomes`);
  }
});

Deno.test("persist-guard: a toJSON() that creates the loss is caught too", () => {
  // The blind spot in the old design: it classified the ORIGINAL value off the
  // holder (so a Date is named "Date", not "string"), which meant a toJSON
  // returning undefined dropped the key in total silence.
  const dropped = stringifyWithIssues({ a: { toJSON: () => undefined } });
  assertEquals(dropped.issues.map((i) => i.path), ["a"]);
  assertEquals(dropped.json, "{}");

  const nulled = stringifyWithIssues({ a: { toJSON: () => NaN } });
  assertEquals(nulled.issues.map((i) => i.path), ["a"]);

  // …and a toJSON that returns something JSON keeps is not an issue.
  assertEquals(
    stringifyWithIssues({ a: { toJSON: () => ({ ok: 1 }) } }).issues,
    [],
  );
});

Deno.test("persist-guard: plain data of every shape stays silent", () => {
  const clean = {
    s: "x",
    n: 0,
    neg: -1.5,
    b: false,
    nul: null,
    arr: [1, "two", { three: 3 }, []],
    nested: { deep: { deeper: [{ ok: true }] } },
    empty: {},
    nullProto: Object.assign(Object.create(null), { k: 1 }),
  };
  assertEquals(stringifyWithIssues(clean).issues, []);
});

Deno.test("persist-guard: an array hole is reported as null, not as a dropped key", () => {
  const { issues } = stringifyWithIssues({ a: [1, , 3] });
  assertEquals(issues.length, 1);
  assertEquals(issues[0]!.path, "a.1");
  assertStringIncludes(issues[0]!.becomes, "null");
});
