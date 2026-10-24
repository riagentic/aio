// A call made inside an async method's FIRST frame runs after the whole frame,
// in every harness, as on the server: `async a(s){ s.n += 1; c.inc(); s.n += 100 }`
// — `inc` sees 101. The server and bootCells queue it behind the frame (the
// dispatch loop is draining); testCell ran it inline and `inc` saw 1. The
// final state agreed, so only a test reading state INSIDE `inc` saw the
// difference — a harness ordering prod never takes.
import { assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { bootCells, testCell } from "../src/testing/cell-test.ts";
import { testServer } from "../src/testing/server-test.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const mk = (id: string) => {
  const c: Any = cell(id, {
    state: { n: 0, seen: -1 },
    methods: {
      inc(s: { n: number; seen: number }) {
        s.seen = s.n;
      },
      async a(s: { n: number }) {
        s.n += 1;
        c.inc();
        s.n += 100;
      },
    },
  });
  return c;
};

Deno.test({
  name: "first-frame call order — server: the inner call sees the whole frame",
  sanitizeOps: false, // aio-ok: a live server, closed below
  sanitizeResources: false, // aio-ok: same
  fn: async () => {
    const c = mk("ffo_srv");
    const srv = await testServer({ cells: [c] });
    try {
      await c.a();
      await sleep(30);
      assertEquals([c.n, c.seen], [101, 101]);
    } finally {
      await srv.close();
    }
  },
});

Deno.test("first-frame call order — bootCells: the inner call sees the whole frame", async () => {
  const c = mk("ffo_boot");
  const h = await bootCells([c]);
  try {
    await c.a();
    await h.settle();
    assertEquals([c.n, c.seen], [101, 101]);
  } finally {
    h.dispose();
  }
});

testCell(
  mk("ffo_tc"),
  "first-frame call order — testCell: the inner call sees the whole frame",
  async (t) => {
    await t.send.a!();
    await t.settle();
    const s = t.getState() as Any;
    assertEquals([s.n, s.seen], [101, 101]);
  },
);
