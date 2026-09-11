// `s.$call.sibling(args)` — one cell method calling another, on the same draft.
//
// Three reports reached for this and all three workarounds are wrong
// (llama.master §6/§9, vidtune §6): `this.bench(...)` cannot type-check,
// `myCell.bench(...)` is a SECOND dispatch with its own draft, and a
// module-level helper works but takes the body out of `aiol`'s reach, so the
// absence of a warning starts meaning "not analysed" while reading as "fine".
//
// _"The single most valuable thing aio could add for an app of this size.
// Composition inside a cell is not exotic."_
//
// THE PROPERTY THAT MAKES IT WORTH HAVING is that it is the SAME draft — the
// caller's uncommitted writes are visible to the sibling, and the sibling's
// writes are the caller's. A version that dispatched would pass a naive test
// and be the thing it was built to replace.
import { assert, assertEquals } from "@std/assert";
import { cell, type MethodDraftCalls } from "../mod.ts";
import { testCell } from "../src/cell-test.ts";
import { MAX_CALL_DEPTH } from "../src/state/cell-call.ts";

type S = { n: number; log: string[] };
// deno-lint-ignore no-explicit-any
type D = any;

const sibSync = cell("sibsync", {
  state: { n: 0, log: [] as string[] },
  methods: {
    double(s: S) {
      s.n = s.n * 2;
      s.log.push(`double->${s.n}`);
      return s.n;
    },
    run(s: S) {
      s.n = 5;
      const got = (s as D).$call.double();
      s.log.push(`run saw ${got}`);
      return got;
    },
    bump(s: S) {
      s.n++;
    },
    thrice(s: S) {
      const call = (s as D).$call;
      call.bump();
      call.bump();
      call.bump();
    },
  },
} as D);

testCell(
  sibSync,
  "sync: the sibling sees the caller's UNCOMMITTED writes",
  async (t: D) => {
    await t.send.run();
    // A sibling on its own draft would have doubled a committed 0.
    assertEquals(t.getState().n, 10);
    assertEquals(t.getState().log, ["double->10", "run saw 10"]);
  },
);

testCell(sibSync, "sync: three sibling calls, ONE commit", async (t: D) => {
  t.init();
  await t.send.thrice();
  assertEquals(t.getState().n, 3);
  // `myCell.bump()` would be three separate dispatches with three drafts.
  // Running inline is the entire difference, and the count is what shows it.
  assertEquals(t.getState().log, []);
});

const sibAsync = cell("sibasync", {
  state: { n: 0, log: [] as string[] },
  methods: {
    async fetchish(s: S, by: number) {
      await Promise.resolve();
      s.n += by;
      return s.n;
    },
    async run(s: S) {
      s.n = 1;
      const a = await (s as D).$call.fetchish(10);
      const b = await (s as D).$call.fetchish(100);
      s.log.push(`${a},${b}`);
      return s.n;
    },
  },
} as D);

testCell(sibAsync, "async: the same draft, across an await", async (t: D) => {
  await t.send.run();
  assertEquals(t.getState().n, 111);
  assertEquals(t.getState().log, ["11,111"]);
});

const sibMixed = cell("sibmixed", {
  state: { n: 0, log: [] as string[] },
  methods: {
    tag(s: S, what: string) {
      s.log.push(what);
      return s.log.length;
    },
    async run(s: S) {
      const one = (s as D).$call.tag("a");
      await Promise.resolve();
      const two = (s as D).$call.tag("b");
      s.n = one + two;
    },
  },
} as D);

testCell(
  sibMixed,
  "async caller, SYNC sibling — the ordinary mixed case",
  async (t: D) => {
    await t.send.run();
    assertEquals(t.getState().log, ["a", "b"]);
    assertEquals(t.getState().n, 3);
  },
);

const sibRefuse = cell("sibrefuse", {
  state: { n: 0, log: [] as string[] },
  methods: {
    async slow(s: S) {
      await Promise.resolve();
      s.n++;
    },
    run(s: S) {
      (s as D).$call.slow();
    },
  },
} as D);

testCell(
  sibRefuse,
  "a SYNC method calling an ASYNC sibling is refused by name",
  async (t: D) => {
    // There is no way to await it there, and a floating promise would write into
    // the draft after the commit — changes landing in somebody else's tick,
    // which presents as "sometimes it works".
    let msg = "";
    try {
      await t.send.run();
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    assert(
      msg.length > 0,
      "a sync method awaited an async sibling and got away with it",
    );
    assert(msg.includes("slow"), `it must name the sibling: ${msg}`);
    assert(msg.includes("ASYNC"), `it must say WHY: ${msg}`);
    assert(msg.includes("async run"), `it must name the fix: ${msg}`);
  },
);

const sibTypo = cell("sibtypo", {
  state: { n: 0, log: [] as string[] },
  methods: {
    bench(s: S) {
      s.n++;
    },
    run(s: S) {
      (s as D).$call.bnech();
    },
  },
} as D);

testCell(
  sibTypo,
  "an unknown sibling names the typo AND what was available",
  async (t: D) => {
    let msg = "";
    try {
      await t.send.run();
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    assert(msg.includes("bnech"), `the typo: ${msg}`);
    assert(msg.includes("bench"), `what WAS there: ${msg}`);
    assert(
      !msg.includes("is not a function"),
      `the bare JS error names neither the cell nor the typo: ${msg}`,
    );
  },
);

const sibCycle = cell("sibcycle", {
  state: { n: 0, log: [] as string[] },
  methods: {
    a(s: S) {
      (s as D).$call.b();
    },
    b(s: S) {
      (s as D).$call.a();
    },
  },
} as D);

testCell(
  sibCycle,
  "a cycle is refused with a sentence about the app, not a stack",
  async (t: D) => {
    let msg = "";
    try {
      await t.send.a();
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    assert(
      msg.includes(String(MAX_CALL_DEPTH)),
      `it must say the limit: ${msg}`,
    );
    assert(msg.includes("cycle"), `it must name the likely cause: ${msg}`);
  },
);

const sibExists = cell("sibexists", {
  state: { n: 0, log: [] as string[] },
  methods: {
    s1(s: S) {
      s.log.push(typeof (s as D).$call + ":" + ("$call" in (s as D)));
    },
    async a1(s: S) {
      await Promise.resolve();
      s.log.push(typeof (s as D).$call + ":" + ("$call" in (s as D)));
    },
  },
} as D);

testCell(
  sibExists,
  "`$call` exists on every draft, sync and async",
  async (t: D) => {
    await t.send.s1();
    await t.send.a1();
    // The sync/async parity contract: a spelling that works in one and is
    // `undefined` in the other is the divergence this repo bans outright.
    assertEquals(t.getState().log, ["object:true", "object:true"]);
  },
);

// ── the TYPED spelling, checked by the type-checker that runs this file ──
//
// `MethodDraftCalls` is a separate opt-in type, not a member of
// `MethodDraftMeta`: that one is frozen, and adding a required member to it
// would break any code that CONSTRUCTS one (a hand-built fake draft in
// somebody's test). aio's surface promise has no exceptions, and check:api
// refused the first shape of this change on exactly those grounds.
//
// These declarations compile or this file does not run — which is the only
// assertion a type needs.
type TypedState = { count: number; notes: string[] };

// The precise spelling is an INTERFACE the method names, not
// `typeof methods` — that is circular (TS7022: "referenced directly or
// indirectly in its own initializer") and would have shipped an example that
// does not compile.
interface TypedCalls {
  bench(kind: string): number;
}

const typedMethods = {
  bench(s: TypedState, kind: string): number {
    s.notes.push(kind);
    return s.notes.length;
  },
  async run(s: TypedState & MethodDraftCalls<TypedCalls>) {
    // Precisely typed: `kind` is a string, the return is a number.
    const n: number = s.$call.bench("cold");
    await Promise.resolve();
    s.count = n;
  },
  // The permissive default — no type argument, still a legal spelling.
  loose(s: TypedState & MethodDraftCalls) {
    s.$call.bench("whatever");
  },
};

const typedCell = cell("sibtyped", {
  state: { count: 0, notes: [] as string[] },
  methods: typedMethods,
} as D);

testCell(
  typedCell,
  "the typed spelling runs, not only compiles",
  async (t: D) => {
    await t.send.run();
    assertEquals(t.getState().count, 1);
    assertEquals(t.getState().notes, ["cold"]);
    await t.send.loose();
    assertEquals(t.getState().notes, ["cold", "whatever"]);
  },
);

// ── the aiol half of the same report ────────────────────────────────────────
//
// llama.master §7 named the workaround as the actual danger, not the
// inconvenience: moved into a module-level function taking the draft, a
// post-await read is no longer analysed, and the absence of a warning starts
// meaning "not analysed" while still reading as "fine".
//
// `$call` removes the reason to move it. Two things have to hold for that to
// be worth anything: the sibling's body stays inside the cell where the
// linter reads it, and `s.$call` itself is not mistaken for the post-await
// hazard it is the cure for.
Deno.test("aiol: `s.$call` is draft META, not a post-await state read", async () => {
  const { draftReadOffsets, DRAFT_META } = await import("../aiol/checks.ts");
  assert(
    (DRAFT_META as readonly string[]).includes("$call"),
    "$call must be on the meta list, or the documented way to compose inside " +
      "a cell is reported as the hazard it replaces",
  );
  // A call into this cell is not state another action can move under you.
  assertEquals(draftReadOffsets("s.$call.bench('x')", "s"), []);
  // …and the rule still sees a real read, so the silence above means
  // "exempt", not "the analyser stopped working".
  assert(
    draftReadOffsets("const n = s.count", "s").length === 1,
    "a genuine draft read must still be reported",
  );
  // The exemption is the KNOWN list, not "anything starting with $".
  assert(
    draftReadOffsets("const v = s.$myField", "s").length === 1,
    "a blanket $-prefix exemption would outlive the rule that made it safe",
  );
});
