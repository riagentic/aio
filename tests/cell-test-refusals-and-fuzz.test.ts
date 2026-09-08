// Two gaps in `testCell`, both reported by apps that reached for the obvious
// thing and found it missing.
//
// `expect.rejects` — "Validation lives with the data … a method that refuses
// does so by throwing" is documented behaviour with a worked example, and the
// harness had no assertion for it. A field report reached for
// `t.expect.rejects(...)` by analogy with `.state` / `.effects` / `.invariant`,
// got `TS2339: Property 'rejects' does not exist`, and imported `assertRejects`.
// The analogy was right; the member was missing.
//
// `t.fuzz` — `randomActions` is unseeded, so a failing fuzz cannot be re-run.
// When one failed, its author "spent a worktree and ten runs establishing
// whether it was mine". And it picks uniformly over EVERY action key, including
// boot-only methods that need a clock this harness does not have: with 32 keys
// and 120 picks, missing such a key has probability ~2%, so the test does not
// "sometimes fail" — it sometimes PASSES.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testCell } from "../src/cell-test.ts";
import { schedule } from "../src/state/schedule.ts";

type S = { items: string[]; total: number };

const shop = cell("shop_refuse", {
  state: { items: [] as string[], total: 0 },
  methods: {
    add(s: S, name: string) {
      // The documented shape: validation lives with the data, and a refusal is
      // a throw.
      if (!name?.trim()) throw new Error("name is required");
      s.items.push(name);
      s.total += 1;
    },
    async addAsync(s: S, name: string) {
      await Promise.resolve();
      if (!name?.trim()) throw new Error("name is required");
      s.items.push(name);
      s.total += 1;
    },
    clear(s: S) {
      s.items = [];
      s.total = 0;
    },
  },
});

testCell(
  shop,
  "expect.rejects: a refusal is a first-class assertion",
  async (t) => {
    const err = await t.expect.rejects(
      () => t.send.addAsync(""),
      /name is required/,
    );
    assert(err instanceof Error);
    t.expect.state((s) => (s as S).total === 0, "the refusal changed nothing");
  },
);

testCell(
  shop,
  "expect.rejects: a call that RESOLVES fails the assertion",
  async (t) => {
    let failed = "";
    try {
      await t.expect.rejects(() => t.send.addAsync("milk"));
    } catch (e) {
      failed = e instanceof Error ? e.message : String(e);
    }
    assert(
      failed.includes("REFUSED"),
      `an assertion that passes when the guard is GONE is worse than no ` +
        `assertion: ${failed || "(it passed)"}`,
    );
  },
);

testCell(shop, "expect.rejects: the WRONG refusal does not pass", async (t) => {
  let failed = "";
  try {
    await t.expect.rejects(() => t.send.addAsync(""), /disk is full/);
  } catch (e) {
    failed = e instanceof Error ? e.message : String(e);
  }
  assert(
    failed.includes("different reason"),
    `"it threw" passes for a TypeError from a typo just as happily as for ` +
      `the validation under test: ${failed || "(it passed)"}`,
  );
});

testCell(shop, "expect.throws: the synchronous half", (t) => {
  // A plain helper — the case `throws` is actually for.
  const err = t.expect.throws(() => {
    throw new Error("name is required");
  }, "name is required");
  assertEquals(err.message.includes("name is required"), true);
});

testCell(
  shop,
  "expect.throws on a cell METHOD names the right assertion",
  (t) => {
    // Every cell method is a sender and returns a promise, so a refusal rejects.
    // Reported as "it returned", this also left an unhandled rejection that took
    // down the whole test FILE from outside any test — a green-to-catastrophic
    // failure with no line number in it.
    let failed = "";
    try {
      t.expect.throws(() => t.send.add(""));
    } catch (e) {
      failed = e instanceof Error ? e.message : String(e);
    }
    assert(
      failed.includes("expect.rejects"),
      `it must name the assertion that works: ${failed || "(it passed)"}`,
    );
  },
);

// ── fuzz ────────────────────────────────────────────────────────────────

const counter = cell("fuzz_counter", {
  state: { total: 0, seen: [] as number[] },
  methods: {
    inc(s: { total: number }) {
      s.total += 1;
    },
    dec(s: { total: number }) {
      s.total -= 1;
    },
    reset(s: { total: number }) {
      s.total = 0;
    },
    // The boot-only method that makes an unfiltered fuzz a coin toss: its body
    // emits a framework effect the harness owns no clock for.
    armWatch(s: { total: number } & { $do?: (e: unknown) => void }) {
      s.$do?.(schedule.every("tick", 1000, { type: "fuzz_counter:inc" }));
    },
  },
  // deno-lint-ignore no-explicit-any
} as any);

testCell(counter, "fuzz: the same seed replays the same sequence", (t) => {
  const a = t.fuzz({ n: 40, seed: 12345, skip: ["armWatch"] });
  assertEquals(a.seed, 12345);
  assertEquals(a.actions.length, 40);
  const b = t.fuzz({ n: 40, seed: 12345, skip: ["armWatch"] });
  assertEquals(
    b.actions,
    a.actions,
    "a fuzz you cannot replay is a bug report you cannot act on",
  );
});

testCell(
  counter,
  "fuzz: a generated seed is RETURNED, so a failure can name it",
  (t) => {
    const run = t.fuzz({ n: 10, skip: ["armWatch"] });
    assert(Number.isInteger(run.seed), "the seed must be reportable");
    const replay = t.fuzz({ n: 10, seed: run.seed, skip: ["armWatch"] });
    assertEquals(replay.actions, run.actions);
  },
);

testCell(counter, "fuzz: skip keeps the boot-only method out", (t) => {
  const run = t.fuzz({ n: 200, seed: 7, skip: ["armWatch"] });
  assertEquals(
    run.actions.filter((a) => a.includes("armWatch")),
    [],
    "200 picks over 3 keys — an unskipped 4th would appear ~50 times",
  );
});

testCell(
  counter,
  "fuzz: skipping EVERYTHING is an error, not a silent no-op",
  (t) => {
    let failed = "";
    try {
      t.fuzz({ n: 10, skip: ["inc", "dec", "reset", "armWatch"] });
    } catch (e) {
      failed = e instanceof Error ? e.message : String(e);
    }
    assert(
      failed.includes("every action was skipped"),
      `a fuzz that dispatches nothing and then asserts an invariant is the ` +
        `vacuous-pass shape: ${failed || "(it ran)"}`,
    );
  },
);

testCell(
  counter,
  "fuzz: a full cell:method key skips too, not just the bare name",
  (t) => {
    const run = t.fuzz({ n: 60, seed: 3, skip: ["fuzz_counter:armWatch"] });
    assertEquals(run.actions.filter((a) => a.includes("armWatch")), []);
  },
);
