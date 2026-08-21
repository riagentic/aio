// field-filter validation — a ui/persist filter key that matches no state
// field silently leaks. These lock the loud-failure behavior.
import { assertStringIncludes, assertThrows } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
// deno-lint-ignore no-explicit-any
const C = cell as any;

Deno.test("filter: exclude key not in state throws (would silently leak)", () => {
  assertThrows(
    () =>
      C("ff1", {
        state: { pub: 1, encSecretKey: "s" },
        methods: {},
        visible: { exclude: ["encSecKey"] },
      }),
    Error,
    "silently exposing",
  );
});

Deno.test("filter: include key not in state throws", () => {
  assertThrows(
    () => C("ff2", { state: { a: 1 }, methods: {}, ui: { include: ["b"] } }),
    Error,
    "not a state field",
  );
});

Deno.test("filter: persist exclude typo throws", () => {
  assertThrows(
    () =>
      C("ff3", {
        state: { keep: 1, secret: "x" },
        methods: {},
        persist: { exclude: ["secrets"] },
      }),
    Error,
    "excludes nothing",
  );
});

// The message must describe the consequence of the filter that was WRITTEN.
// One sentence used to cover all four combinations — "silently exposing what
// you meant to hide" — which is true of `visible.exclude` and false of the
// other three. A field report added `engine` and `detail` to a cell's state and
// forgot `persist.include`; the setting silently did not survive a restart, and
// being told to look for a leak would have sent them hunting the wrong thing.
Deno.test("filter: each combination names its OWN consequence", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["persist-include", { persist: { include: ["engien"] } }, "restart"],
    ["persist-exclude", { persist: { exclude: ["secrt"] } }, "database"],
    ["visible-include", { visible: { include: ["engien"] } }, "UI"],
    ["visible-exclude", { visible: { exclude: ["secrt"] } }, "exposing"],
  ];
  for (const [label, extra, phrase] of cases) {
    const e = assertThrows(
      () =>
        C(`ffc-${label}`, {
          state: { engine: "", secret: "x" },
          methods: {},
          ...extra,
        }),
      Error,
    );
    const msg = (e as Error).message;
    assertStringIncludes(msg, phrase);
    // …and it points at the field that was probably meant.
    assertStringIncludes(msg, "did you mean");
  }
});

Deno.test("filter: nested path in include throws (unsupported)", () => {
  assertThrows(
    () =>
      C("ff4", {
        state: { accounts: [] },
        methods: {},
        visible: { include: ["accounts.pubKey"] },
      }),
    Error,
    "does not support nested",
  );
});

Deno.test("filter: valid nested exclude is accepted (head resolves)", () => {
  C("ff5", {
    state: { accounts: [] },
    methods: {},
    visible: { exclude: ["accounts.encSecKey"] },
  });
});

Deno.test("filter: valid top-level include/exclude accepted", () => {
  C("ff6", {
    state: { pub: 1, secret: "s" },
    methods: {},
    visible: { include: ["pub"] },
    persist: { exclude: ["secret"] },
  });
});

Deno.test("filter: ui.publicFields naming a non-field throws (typo'd opt-out)", () => {
  assertThrows(
    () =>
      C("ffp", {
        state: { a: 1 },
        methods: {},
        visible: { publicFields: ["notAField"] },
      }),
    Error,
    "not a state field",
  );
});

Deno.test("filter: valid ui.publicFields is accepted", () => {
  C("ffp2", {
    state: { pubKey: "", n: 0 },
    methods: {},
    visible: { publicFields: ["pubKey"] },
  });
});

Deno.test("filter: 'all'/'none' and no filter are fine", () => {
  C("ff7", { state: { a: 1 }, methods: {}, ui: "all", persist: "none" });
  C("ff8", { state: { a: 1 }, methods: {} });
});
