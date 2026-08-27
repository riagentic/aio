// field-filter validation — a ui/persist filter key that matches no state
// field silently leaks. These lock the loud-failure behavior.
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
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

// ── `include` AND `exclude` together ────────────────────────────────────
//
// They are two different filters, and every reader answers `"include" in
// filter` first and returns — so the `exclude` list is discarded without a
// word. `visible: { include: [...], exclude: ["b.secret"] }` therefore SENDS
// `b.secret` to every client while reading like it hides it. `normalizeUiFilter`
// then drops the key entirely, so nothing downstream can even see it was
// written: the refusal has to happen at `cell()`, while the evidence exists.
Deno.test("filter: visible with BOTH include and exclude is refused", () => {
  const e = assertThrows(
    () =>
      C("ffb1", {
        state: { a: 1, b: { secret: "x" } },
        methods: {},
        visible: { include: ["a", "b"], exclude: ["b.secret"] },
      }),
    Error,
    "BOTH",
  );
  const msg = (e as Error).message;
  assertStringIncludes(msg, "b.secret"); // the list that would be discarded
  assertStringIncludes(msg, "sent to clients anyway"); // the consequence
  assertStringIncludes(msg, "pick one"); // the fix
});

Deno.test("filter: persist with BOTH include and exclude is refused", () => {
  const e = assertThrows(
    () =>
      C("ffb2", {
        state: { keep: 1, secret: "x" },
        methods: {},
        persist: { include: ["keep"], exclude: ["secret"] },
      }),
    Error,
    "BOTH",
  );
  assertStringIncludes((e as Error).message, "written to the database anyway");
});

// One of them alone is untouched — this is a refusal of the ambiguous pair,
// not a new restriction on the filters themselves.
Deno.test("filter: one list alone still works", () => {
  // The assertion IS that neither call throws: the refusal above fires only
  // when BOTH lists are present, and a rule that also refused the ordinary
  // one-list shapes would be worse than the bug it replaced.
  const inc = C("ffb3", {
    state: { a: 1, b: 2 },
    methods: {},
    visible: { include: ["a"] },
  });
  const exc = C("ffb4", {
    state: { a: 1, b: 2 },
    methods: {},
    visible: { exclude: ["b"] },
  });
  // Not a bare "did not throw": both cells must have been ACCEPTED and be
  // usable, which is what a rule that over-refused would break.
  assertEquals(inc.__aio.id, "ffb3");
  assertEquals(exc.__aio.id, "ffb4");
});
