// An async method's writes are coalesced on a microtask — and until then they
// were invisible to every other action. A sync `inc()` issued in the same
// tick, a second call's `s.n++`, three calls resuming from one awaited
// promise: each read the old value, and its commit silently overwrote the
// other's. `Promise.all([c.ainc(), c.ainc()])` ended at 1; an async push
// followed by a sync push landed in the reverse order. The microtask is a
// coalescing window, never a reordering — pinned in BOTH harnesses, since the
// production loop (`bootCells`) and `testCell` each own a dispatch.
import { assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { bootCells, testCell } from "../src/cell-test.ts";

const tick = () => new Promise((r) => setTimeout(r, 1));

function make(name: string) {
  let go!: () => void;
  const gate = new Promise<void>((r) => (go = r));
  const c = cell(name, {
    state: { n: 0, done: 0, items: [] as number[] },
    methods: {
      async ainc(s) {
        s.n++;
        await tick();
      },
      inc(s) {
        s.n++;
      },
      async job(s) {
        await gate;
        s.done++;
      },
      async apush(s, x: number) {
        s.items.push(x);
        await tick();
      },
      push(s, x: number) {
        s.items.push(x);
      },
    },
  });
  return { c, go };
}

Deno.test("bootCells: no async write is lost or reordered", async () => {
  const { c, go } = make("pwo_boot");
  await using _h = await bootCells([c]);
  await Promise.all([c.ainc(), c.ainc()]);
  assertEquals(c.n, 2, "two async calls in one tick");
  const p = c.ainc();
  c.inc();
  await p;
  assertEquals(c.n, 4, "async then sync in one tick");
  const jobs = [c.job(), c.job(), c.job()];
  await tick();
  go();
  await Promise.all(jobs);
  assertEquals(c.done, 3, "three calls resuming from one promise");
  const q = c.apush(1);
  c.push(2);
  await q;
  assertEquals([...c.items], [1, 2], "program order");
});

const t1 = make("pwo_tc");
testCell(t1.c, "testCell: no async write is lost or reordered", async (t) => {
  await Promise.all([t.send.ainc(), t.send.ainc()]);
  assertEquals(t.state.n, 2);
  const p = t.send.ainc();
  t.send.inc();
  await p;
  assertEquals(t.state.n, 4);
  const jobs = [t.send.job(), t.send.job(), t.send.job()];
  await tick();
  t1.go();
  await Promise.all(jobs);
  assertEquals(t.state.done, 3);
  const q = t.send.apush(1);
  t.send.push(2);
  await q;
  assertEquals(t.state.items, [1, 2]);
});
