// AIO-379: testCell async-aware send + deterministic settle()
//
// t.send.<asyncMethod>() returns a lazy completion promise: dispatch stays
// synchronous (legacy fire-and-forget tests unchanged), but awaiting it runs
// the method and resolves when all its writes are applied. settle() tracks
// async method triggers to real completion instead of guessing microtasks.

import { assertEquals, assertRejects } from "@std/assert";
import { cell } from "../src/state/cell.ts";
import { testCell } from "../src/testing/cell-test.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const selfDispatch = cell("selfdispatch", {
  state: { count: 0 },
  methods: {
    inc(s) {
      s.count++;
    },
  },
});

testCell(
  selfDispatch,
  "cell-def methods are bound — self-dispatch doesn't trip the unbound guard",
  (t) => {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => warnings.push(a.map(String).join(" "));
    try {
      t.init();
      // Calling the cell def's own method (what self/cross-cell code and
      // deferred setTimeout callbacks do) must dispatch via the harness, not
      // hit the "called before aio.run()" guard.
      (selfDispatch as unknown as { inc: () => void }).inc();
      t.expect.state((s) => s.count === 1);
    } finally {
      console.warn = orig;
    }
    assertEquals(
      warnings.some((w) => w.includes("called before aio.run()")),
      false,
    );
  },
);

let sideEffectRuns = 0;

const loader = cell("loader379", {
  // alpha52: these tests pin the opted-out semantics — "writes before the
  // throw were applied" is the incremental-commit contract; the transactional
  // default discards a throwing method's write-set (pinned elsewhere).
  transaction: false,
  state: {
    data: null as string | null,
    count: 0,
    error: null as string | null,
  },
  methods: {
    bump(s) {
      s.count += 1;
    },
    async load(s) {
      // Slow async work — longer than any microtask drain can cover.
      await sleep(30);
      sideEffectRuns += 1;
      s.data = "loaded";
    },
    async boom(s) {
      s.data = "exploding";
      await sleep(5);
      throw new Error("kaboom");
    },
  },
});

// Guard at method top (methods-style replacement for the old machine gate):
// run() is ignored until unlock() flips the status field.
const gated = cell("gated379", {
  state: { ran: false, gate: "locked" },
  methods: {
    unlock(s) {
      s.gate = "open";
    },
    async run(s) {
      if (s.gate !== "open") return;
      await sleep(5);
      s.ran = true;
    },
  },
});

testCell(
  loader,
  "await send: async method fully applied on resolve",
  async (t) => {
    t.init();
    await t.send.load!();
    t.expect.state((s) => s.data === "loaded");
  },
);

testCell(loader, "sync sends return an awaitable promise too", async (t) => {
  t.init();
  await t.send.bump!();
  t.expect.state((s) => s.count === 1);
});

testCell(
  loader,
  "an un-awaited send is already running — settle() drains it",
  async (t) => {
    t.init();
    const before = sideEffectRuns;
    t.send.load!(); // never awaited: started, like production cell.load()
    t.expect.state((s) => s.data === null); // its first await hasn't resolved
    await t.settle(); // drains calls the test never awaited
    assertEquals(sideEffectRuns, before + 1);
    t.expect.state((s) => s.data === "loaded");
  },
);

testCell(
  loader,
  "settle() waits for real async completion (no ms guessing)",
  async (t) => {
    t.init();
    t.send.load!();
    await t.settle(); // 30ms of real work — old microtask drain would miss this
    t.expect.state((s) => s.data === "loaded");
  },
);

testCell(
  loader,
  "await send then settle(): method executes exactly once",
  async (t) => {
    t.init();
    const before = sideEffectRuns;
    await t.send.load!();
    await t.settle();
    await t.settle();
    assertEquals(sideEffectRuns, before + 1);
  },
);

testCell(
  loader,
  "settle() then await send: no double execution either",
  async (t) => {
    t.init();
    const before = sideEffectRuns;
    const done = t.send.load!();
    await t.settle();
    await done; // resolves immediately — settle already ran and awaited it
    assertEquals(sideEffectRuns, before + 1);
    t.expect.state((s) => s.data === "loaded");
  },
);

testCell(loader, "await send rejects when the method throws", async (t) => {
  t.init();
  await assertRejects(() => t.send.boom!(), Error, "kaboom");
  // Writes before the throw were applied — same semantics as production.
  t.expect.state((s) => s.data === "exploding");
});

// `t.send.boom(); await t.settle();` used to PASS while the method threw:
// the harness reporting success for exactly the failure it exists to catch. The
// rule is the language's own rule for promises — an error nobody looked at is
// unhandled, and it surfaces.
testCell(loader, "settle() surfaces a failure nobody awaited", async (t) => {
  t.init();
  t.send.boom!(); // fire-and-forget…
  await assertRejects(() => t.settle(), Error, "kaboom"); // …still reported
  t.expect.state((s) => s.data === "exploding"); // writes before the throw stand
});

testCell(
  loader,
  "settle() stays quiet about a failure the test already handled",
  async (t) => {
    t.init();
    await assertRejects(() => t.send.boom!(), Error, "kaboom");
    await t.settle(); // the test observed it — no second delivery
    t.expect.state((s) => s.data === "exploding");
  },
);

testCell(
  loader,
  "a failure nobody awaited fails the test even without settle()",
  async (t) => {
    t.init();
    // No settle, no await: the check runs when the test body returns. Proven
    // by driving the harness's own end-of-test path in the test below.
    const seen: unknown[] = [];
    try {
      t.send.boom!();
      await new Promise((r) => setTimeout(r, 20)); // let it reject
      await t.settle();
    } catch (e) {
      seen.push(e);
    }
    assertEquals(seen.length, 1, "the failure surfaced");
  },
);

// the harness must order calls the way production does: a call
// STARTS when it is made, so a second action lands while the first is still in
// flight. Starting lazily on the first `await` inverted that order — the second
// action ran first, against untouched state — which made every
// cancel-in-flight / supersession test inexpressible at the cell level, with
// nothing in the API to warn you.
const order: string[] = [];

const disk = cell("diskspacy", {
  state: { path: null as string | null, scanning: false },
  methods: {
    async open(s, path: string) {
      order.push(`open:${path}`); // production: the subprocess spawns HERE
      s.scanning = true;
      await sleep(20);
      order.push(`done:${path}`);
      s.scanning = false;
    },
    cancel(s) {
      order.push("cancel");
      s.path = null;
    },
  },
});

testCell(
  disk,
  "an un-awaited call runs its sync prefix at call time",
  async (t) => {
    t.init();
    order.length = 0;
    t.send.open("/"); // never awaited — the work is under way regardless
    assertEquals(order, ["open:/"]);
    await t.settle(); // it IS running, so settle before leaving the test
    assertEquals(order, ["open:/", "done:/"]);
  },
);

testCell(
  disk,
  "a later action lands while the first call is in flight",
  async (t) => {
    t.init();
    order.length = 0;
    const scanning = t.send.open("/"); // starts NOW, like cell.open("/")
    await t.send.cancel(); // …so this lands MID-flight, not before it
    await scanning;
    assertEquals(order, ["open:/", "cancel", "done:/"]);
  },
);

testCell(
  gated,
  "awaiting a guard-blocked async send resolves without doing the work",
  async (t) => {
    t.init();
    await t.send.run!(); // guard rejects in 'locked' — resolves, no work done
    t.expect.state((s) => s.gate === "locked");
    t.expect.state((s) => s.ran === false);

    t.send.unlock!();
    await t.send.run!();
    t.expect.state((s) => s.gate === "open");
    t.expect.state((s) => s.ran === true);
  },
);
