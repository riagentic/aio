// field-filter validation — a ui/persist filter key that matches no state
// field silently leaks (risoto Ugly #2: "the surface says one thing, the
// machinery does another"). These lock the loud-failure behavior.
import { assertThrows } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
// deno-lint-ignore no-explicit-any
const C = cell as any;

Deno.test("filter: exclude key not in state throws (would silently leak)", () => {
  assertThrows(
    () => C("ff1", { state: { pub: 1, encSecretKey: "s" }, methods: {}, ui: { exclude: ["encSecKey"] } }),
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
    () => C("ff3", { state: { keep: 1, secret: "x" }, methods: {}, persist: { exclude: ["secrets"] } }),
    Error,
    "silently exposing",
  );
});

Deno.test("filter: nested path in include throws (unsupported)", () => {
  assertThrows(
    () => C("ff4", { state: { accounts: [] }, methods: {}, ui: { include: ["accounts.pubKey"] } }),
    Error,
    "does not support nested",
  );
});

Deno.test("filter: valid nested exclude is accepted (head resolves)", () => {
  C("ff5", { state: { accounts: [] }, methods: {}, ui: { exclude: ["accounts.encSecKey"] } });
});

Deno.test("filter: valid top-level include/exclude accepted", () => {
  C("ff6", { state: { pub: 1, secret: "s" }, methods: {}, ui: { include: ["pub"] }, persist: { exclude: ["secret"] } });
});

Deno.test("filter: ui.publicFields naming a non-field throws (typo'd opt-out)", () => {
  assertThrows(
    () => C("ffp", { state: { a: 1 }, methods: {}, ui: { publicFields: ["notAField"] } }),
    Error,
    "not a state field",
  );
});

Deno.test("filter: valid ui.publicFields is accepted", () => {
  C("ffp2", { state: { pubKey: "", n: 0 }, methods: {}, ui: { publicFields: ["pubKey"] } });
});

Deno.test("filter: 'all'/'none' and no filter are fine", () => {
  C("ff7", { state: { a: 1 }, methods: {}, ui: "all", persist: "none" });
  C("ff8", { state: { a: 1 }, methods: {} });
});
