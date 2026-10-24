// An async method's FIRST frame (the code before its first await) writes
// before anything queued after it reduces.
//
// The body of an async call runs as an effect of the call's own action — so
// its first frame runs INSIDE the dispatch loop, and its writes waited on a
// microtask while the (synchronous) loop went on reducing whatever was queued:
// a call the frame made, a sibling call queued beside it.
// Each of those read the state without the frame's writes, and the write-set
// that landed afterwards overwrote what they did — a silent lost update, on
// the server and under bootCells alike (testCell, which has its own loop, got
// it right). Found by tests/cell-concurrency-differential.test.ts.
import { assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { bootCells } from "../src/testing/cell-test.ts";
import { testServer } from "../src/testing/server-test.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const mk = (id: string) => {
  const c: Any = cell(id, {
    state: { n: 0 },
    methods: {
      inc(s: { n: number }) {
        s.n += 10;
      },
      async ainc(s: { n: number }) {
        s.n += 1;
      },
      // A call made in the first frame.
      async callInFrame(s: { n: number }) {
        s.n += 1;
        c.inc();
      },
      // Two calls queued side by side: the async one's frame runs first.
      both() {
        c.ainc();
        c.inc();
      },
    },
  });
  return c;
};

// A transaction's `s.$commit()` in the first frame, with a call queued
// beside it: the commit was guarded against the state of that moment, then
// landed behind the queued `+10` and overwrote it.
const mkTx = (id: string) => {
  const c: Any = cell(id, {
    state: { n: 0 },
    transaction: true,
    methods: {
      inc(s: { n: number }) {
        s.n += 10;
      },
      async commitInFrame(s: Any) {
        s.n += 1;
        s.$commit();
        await sleep(1);
      },
      both() {
        c.commitInFrame();
        c.inc();
      },
    },
  });
  return c;
};

const CASES = ["callInFrame", "both", "tx"] as const;
const build = (prefix: string) =>
  CASES.map((m) => m === "tx" ? mkTx(`${prefix}_tx`) : mk(`${prefix}_${m}`));
const call = (c: Any, m: (typeof CASES)[number]) =>
  m === "tx" ? c.both() : c[m]();
const ALL_ELEVEN = Object.fromEntries(CASES.map((m) => [m, 11]));

Deno.test({
  name: "first-frame writes land before what was queued after them — server",
  sanitizeOps: false, // aio-ok: a live server, closed below
  sanitizeResources: false, // aio-ok: same
  fn: async () => {
    const cells = build("ff_srv");
    const srv = await testServer({ cells });
    try {
      const got: Record<string, number> = {};
      for (const [i, m] of CASES.entries()) {
        await call(cells[i], m);
        await sleep(30);
        got[m] = cells[i].n;
      }
      assertEquals(got, ALL_ELEVEN, "a +10 was overwritten");
    } finally {
      await srv.close();
    }
  },
});

Deno.test("first-frame writes land before what was queued after them — bootCells", async () => {
  const cells = build("ff_boot");
  const h = await bootCells(cells);
  try {
    const got: Record<string, number> = {};
    for (const [i, m] of CASES.entries()) {
      await call(cells[i], m);
      await h.settle();
      await sleep(10);
      got[m] = cells[i].n;
    }
    assertEquals(got, ALL_ELEVEN, "a +10 was overwritten");
  } finally {
    h.dispose();
  }
});
