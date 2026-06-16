// AIO-380: function transition targets — machine status can depend on
// state and action args instead of being a static string.

import { assertEquals } from "@std/assert";
import { cell } from "../src/cell.ts";
import { testCell } from "../src/cell-test.ts";
import { validateMachine } from "../src/cell-machine.ts";

// Sync methods: the transition fn runs AFTER the reducer — it sees post-method
// state, so status can track what actually happened.
const docs = cell("docs380", {
  state: { open: [] as string[] },
  machine: {
    initial: "empty",
    states: {
      empty: { openDoc: "viewing" },
      viewing: {
        openDoc: "viewing",
        // Close the last doc → 'empty'; otherwise stay 'viewing'.
        closeDoc: (s: { open: string[] }) => s.open.length > 0 ? "viewing" : "empty",
      },
    },
  },
  methods: {
    openDoc(s, name: string) {
      s.open.push(name);
    },
    closeDoc(s, name: string) {
      s.open = s.open.filter((n) => n !== name);
    },
  },
});

testCell(docs, "sync fn target sees post-method state", (t) => {
  t.init();
  t.send.openDoc!("a");
  t.send.openDoc!("b");
  t.expect.status("viewing");
  t.send.closeDoc!("a");
  t.expect.status("viewing"); // one doc still open
  t.send.closeDoc!("b");
  t.expect.status("empty"); // last one closed → fn returned 'empty'
});

// Async methods: the trigger reduces before the method body runs, so the fn
// sees pre-execution state — branch on args.
const files = cell("files380", {
  state: { current: "" },
  machine: {
    initial: "viewing",
    states: {
      viewing: {
        open: "viewing",
        remove: (s: { current: string }, path: string) =>
          s.current === path ? "empty" : "viewing",
      },
      empty: { open: "viewing" },
    },
  },
  methods: {
    async open(s, path: string) {
      await Promise.resolve();
      s.current = path;
    },
    async remove(s, path: string) {
      await Promise.resolve();
      if (s.current === path) s.current = "";
    },
  },
});

testCell(files, "async fn target branches on args (pre-execution state)", async (t) => {
  t.init();
  await t.send.open!("/a.md");
  t.expect.status("viewing");
  t.expect.state((s) => s.current === "/a.md");

  await t.send.remove!("/other.md"); // not the open file → stay viewing
  t.expect.status("viewing");

  await t.send.remove!("/a.md"); // deleting the open file → empty
  t.expect.status("empty");
  t.expect.state((s) => s.current === "");
});

// Null/undefined → stay; unknown state → logged, stay; throwing fn → logged, stay.
const guard = cell("guard380", {
  state: { n: 0 },
  machine: {
    initial: "idle",
    states: {
      idle: {
        stay: () => null,
        bogus: () => "nonexistent" as unknown as "idle",
        explode: () => {
          throw new Error("guard bug");
        },
        go: "busy",
      },
      busy: { reset: "idle" },
    },
  },
  methods: {
    stay(s) {
      s.n += 1;
    },
    bogus(s) {
      s.n += 1;
    },
    explode(s) {
      s.n += 1;
    },
    go(_s) {},
    reset(_s) {},
  },
});

testCell(guard, "fn returning null stays in current state", (t) => {
  t.init();
  t.send.stay!();
  t.expect.status("idle");
  t.expect.state((s) => s.n === 1); // reducer still applied
});

testCell(guard, "fn returning unknown state stays put (logged, not thrown)", (t) => {
  t.init();
  t.send.bogus!();
  t.expect.status("idle");
  t.expect.state((s) => s.n === 1);
});

testCell(guard, "throwing fn never corrupts dispatch — state applies, status stays", (t) => {
  t.init();
  t.send.explode!();
  t.expect.status("idle");
  t.expect.state((s) => s.n === 1);
});

// Validation: fn targets pass validateMachine; static checks still apply.
Deno.test("validateMachine: fn targets skip static target/reachability checks", () => {
  validateMachine(
    "fn-ok",
    {
      initial: "a",
      states: {
        a: { go: (() => "b") as () => "a" | "b" },
        b: { back: "a" },
      },
    },
    new Set(["go", "back"]),
  );
});

Deno.test("validateMachine: static errors still caught alongside fn targets", () => {
  let threw = false;
  try {
    validateMachine(
      "fn-bad",
      {
        initial: "a",
        states: {
          a: { go: (() => "b") as () => "a" | "b", jump: "nope" as "a" },
          b: { back: "a" },
        },
      },
      new Set(["go", "back", "jump"]),
    );
  } catch (e) {
    threw = true;
    assertEquals(String(e).includes("unknown target 'nope'"), true);
  }
  assertEquals(threw, true);
});
