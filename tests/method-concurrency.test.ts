// `concurrency:` and `ttl:` — what happens when an async method is called
// again while it is still running.
//
// One app had THREE different hand-written answers to that one question, and
// the comment on one records that its first-wins guard was itself a bug
// (llama.master §15). It is a policy: every app needs an answer, most need
// two or three different ones, and none of them should be writing the
// plumbing.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testCell } from "../src/cell-test.ts";
import { argsKey, resetMethodPolicy } from "../src/state/method-policy.ts";

// deno-lint-ignore no-explicit-any
type D = any;

const defer = () => {
  let go: () => void = () => {};
  const p = new Promise<void>((r) => (go = r));
  return { p, go };
};

Deno.test("argsKey: unserializable arguments mean DO NOT CACHE", () => {
  // Silently treating two different calls as the same one is the failure a
  // cache must not have, so no key means no cache and no dedup — it just runs.
  assertEquals(argsKey([1, "a"]), JSON.stringify([1, "a"]));
  // A function INSIDE AN ARRAY serializes as `null`, not `undefined`, so
  // JSON.stringify alone does not catch it — `scan(fnA)` and `scan(fnB)` would
  // both key on "[null]" and answer each other. That is the data bug a cache
  // must not have, and this assertion is what found it.
  assertEquals(argsKey([() => {}]), null, "a function has no stable key");
  assertEquals(argsKey([Symbol("x")]), null, "nor does a symbol");
  assertEquals(argsKey([1, () => {}]), null, "…in any position");
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assertEquals(argsKey([cyclic]), null);
});

// ── "first" ────────────────────────────────────────────────────────────────

let firstRuns = 0;
let gate = defer();
const firstCell = cell("concfirst", {
  state: { n: 0 },
  concurrency: { scan: "first" },
  methods: {
    async scan(s: { n: number }, _path: string) {
      firstRuns++;
      await gate.p;
      s.n++;
      return `ran#${firstRuns}`;
    },
  },
} as D);

testCell(
  firstCell,
  '"first": the second caller ADOPTS the running result',
  async (t: D) => {
    resetMethodPolicy();
    firstRuns = 0;
    gate = defer();
    const a = t.send.scan("/x");
    const b = t.send.scan("/x");
    gate.go();
    const [ra, rb] = await Promise.all([a, b]);
    assertEquals(firstRuns, 1, "the method ran twice — `first` did not dedup");
    // THE BUG THE REPORT SHIPPED: a first-wins guard that resolves the second
    // caller with `undefined`. Adopting the running call's result is the whole
    // difference between a policy and a silent drop.
    assertEquals(ra, "ran#1");
    assertEquals(rb, "ran#1", "the second caller was resolved with nothing");
    assertEquals(t.getState().n, 1);
  },
);

testCell(
  firstCell,
  '"first" is keyed by ARGUMENTS, not just the method',
  async (t: D) => {
    resetMethodPolicy();
    t.init();
    firstRuns = 0;
    gate = defer();
    // `scan("/a")` must not be answered by a running `scan("/b")`.
    const a = t.send.scan("/a");
    const b = t.send.scan("/b");
    gate.go();
    await Promise.all([a, b]);
    assertEquals(firstRuns, 2, "two different calls were deduped into one");
  },
);

// ── "queue" ────────────────────────────────────────────────────────────────

const order: string[] = [];
const queueCell = cell("concqueue", {
  state: { n: 0 },
  concurrency: { save: "queue" },
  methods: {
    async save(s: { n: number }, tag: string) {
      order.push(`start:${tag}`);
      await new Promise((r) => setTimeout(r, 10));
      s.n++;
      order.push(`end:${tag}`);
    },
  },
} as D);

testCell(queueCell, '"queue": one at a time, in order', async (t: D) => {
  resetMethodPolicy();
  order.length = 0;
  await Promise.all([t.send.save("a"), t.send.save("b"), t.send.save("c")]);
  // Without queueing these interleave: start,start,start,end,end,end.
  assertEquals(order, [
    "start:a",
    "end:a",
    "start:b",
    "end:b",
    "start:c",
    "end:c",
  ]);
  assertEquals(
    t.getState().n,
    3,
    "every call must still RUN — queue is not drop",
  );
});

// ── ttl ────────────────────────────────────────────────────────────────────

let ttlRuns = 0;
const ttlCell = cell("concttl", {
  state: { v: "" },
  ttl: { fetchUser: 10_000, flaky: 10_000 },
  methods: {
    async fetchUser(s: { v: string }, id: number) {
      ttlRuns++;
      await Promise.resolve();
      s.v = `u${id}`;
      return `u${id}#${ttlRuns}`;
    },
    async flaky(_s: D) {
      ttlRuns++;
      await Promise.resolve();
      throw new Error("nope");
    },
  },
} as D);

testCell(
  ttlCell,
  "ttl: an identical call returns the cached value",
  async (t: D) => {
    resetMethodPolicy();
    ttlRuns = 0;
    assertEquals(await t.send.fetchUser(1), "u1#1");
    assertEquals(await t.send.fetchUser(1), "u1#1", "it ran again");
    assertEquals(ttlRuns, 1);
  },
);

testCell(
  ttlCell,
  "ttl is keyed by ARGUMENTS — a data bug otherwise",
  async (t: D) => {
    resetMethodPolicy();
    t.init();
    ttlRuns = 0;
    assertEquals(await t.send.fetchUser(1), "u1#1");
    assertEquals(
      await t.send.fetchUser(2),
      "u2#2",
      "fetchUser(2) was answered by fetchUser(1)'s cache",
    );
    assertEquals(ttlRuns, 2);
  },
);

testCell(ttlCell, "ttl NEVER caches a failure", async (t: D) => {
  // Caching one would make a single bad minute last the whole ttl, which is
  // the opposite of what a ttl is for.
  resetMethodPolicy();
  t.init();
  ttlRuns = 0;
  for (let i = 0; i < 2; i++) {
    try {
      await t.send.flaky();
    } catch { /* expected */ }
  }
  assertEquals(ttlRuns, 2, "the failure was cached");
});

// ── the refusals ───────────────────────────────────────────────────────────

Deno.test("declaring both concurrency:newest and cancelOn is refused", () => {
  // Two spellings of one decision is how they come to disagree — and the
  // disagreement would be silent, because registering the trigger twice is
  // idempotent.
  let msg = "";
  try {
    cell("concboth", {
      state: { n: 0 },
      concurrency: { go: "newest" },
      cancelOn: { go: "self" },
      methods: { async go(_s: D) {} },
    } as D);
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  assert(msg.includes("spelled twice"), msg);
  assert(msg.includes("Keep ONE"), `it must say what to do: ${msg}`);
});

Deno.test('concurrency: "newest" registers the self-cancel, not a second mechanism', () => {
  const c = cell("concnewest", {
    state: { n: 0 },
    concurrency: { go: "newest" },
    methods: { async go(_s: D) {} },
  } as D);
  assertEquals(
    (c as D).__aio.cancelTriggers?.go,
    "self",
    "`newest` must fold into cancelOn — compose registers triggers from that " +
      "map and knows nothing about `concurrency`, which is what keeps the two " +
      "from drifting",
  );
});

Deno.test("a SYNC method cannot have a concurrency policy or a ttl", () => {
  // A sync method runs to completion inside one dispatch, so a second call can
  // never overlap the first and the policy would silently never do anything.
  for (
    const [cfg, word] of [
      [{ concurrency: { tick: "queue" } }, "SYNC method"],
      [{ ttl: { tick: 500 } }, "SYNC method"],
    ] as const
  ) {
    let msg = "";
    try {
      cell(`syncpolicy${word.length}${JSON.stringify(cfg).length}`, {
        state: { n: 0 },
        ...cfg,
        methods: {
          tick(s: { n: number }) {
            s.n++;
          },
        },
      } as D);
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    assert(msg.includes(word), `expected a refusal naming ${word}: ${msg}`);
  }
});

Deno.test("a name that is not a method is refused, for both keys", () => {
  // A typo in `ttl` is silent in the worst direction: a cache that never hits
  // looks exactly like no cache.
  for (
    const cfg of [{ concurrency: { nope: "first" } }, { ttl: { nope: 1 } }]
  ) {
    let msg = "";
    try {
      cell(`badname${JSON.stringify(cfg).length}`, {
        state: { n: 0 },
        ...cfg,
        methods: { async go(_s: D) {} },
      } as D);
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    assert(msg.includes("nope"), msg);
    assert(msg.includes("go"), `it must list what IS there: ${msg}`);
  }
});
