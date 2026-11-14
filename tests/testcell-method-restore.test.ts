// testCell binds the cell's METHOD functions to its own dispatcher (so a
// self-call inside a method reaches the harness) — and must put them back,
// as it puts back the selectors and state getters. Left bound, a later plain
// `counter.inc()` with nothing booted went into the dead harness and
// RESOLVED, where production (and the same test run alone) refuses "not
// booted": an order-dependent green.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testCell } from "../src/cell-test.ts";

const counter = cell("restorectr", {
  state: { n: 0 },
  methods: {
    inc(s) {
      s.n += 1;
    },
    twice() {
      counter.inc();
      counter.inc();
    },
  },
});

const original = { inc: counter.inc, twice: counter.twice };
const ownBefore = Object.getOwnPropertyDescriptor(counter, "inc");

async function unbound(): Promise<string> {
  try {
    await counter.inc();
    return "resolved";
  } catch (e) {
    return "rejected: " + (e as Error).message;
  }
}

let fresh = "";
Deno.test("testCell method restore: baseline unbooted call", async () => {
  fresh = await unbound();
  assert(fresh.startsWith("rejected:"), fresh);
  assert(fresh.includes("[restorectr] inc()"), fresh);
});

testCell(counter, "self-calls reach the harness while it runs", async (t) => {
  await t.send.twice();
  t.expect.state((s) => s.n === 2);
});

Deno.test("testCell method restore: the def is as it was found", async () => {
  assert(counter.inc === original.inc, "counter.inc was left rebound");
  assert(counter.twice === original.twice, "counter.twice was left rebound");
  assertEquals(Object.getOwnPropertyDescriptor(counter, "inc"), ownBefore);
  assertEquals(await unbound(), fresh);
});
