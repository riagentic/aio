// An in-process caller's arguments reach an ASYNC method exactly as they reach
// a sync one: by reference.
//
// The async body runs as a `cell:__exec` effect, and every effect was
// structured-cloned twice on its way out of the reduce — arguments included.
// Measured before the fix, the same call to a sync and an async twin:
//
//   () => 7          sync "fn:7"          async: never RAN, await → undefined
//   new Money(250)   sync Money instance  async: a plain {cents:250}
//   AbortSignal      sync the signal      async: {}
//
// A function argument made the whole effect uncloneable, so it was dropped with
// one ERROR line about "fnarg:__exec" — an effect nobody wrote — and the caller
// resolved `undefined` (or, through the second clone seam, waited out the full
// call ceiling). docs/state/methods.md: "In-process callers always get the raw
// value; only the network boundary requires JSON."
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { bootCells } from "../src/testing/cell-test.ts";
import { cell } from "../src/state/cell-create.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

class Money {
  constructor(public cents: number) {}
  fmt() {
    return `$${this.cents / 100}`;
  }
}

const seen: { sync: unknown[]; async: unknown[] } = { sync: [], async: [] };
const twins = cell("rawargs", {
  state: { ran: 0 },
  methods: {
    viaSync(s: Any, v: unknown) {
      s.ran += 1;
      seen.sync.push(v);
      return typeof v === "function" ? (v as () => unknown)() : "no-fn";
    },
    async viaAsync(s: Any, v: unknown) {
      s.ran += 1;
      await Promise.resolve();
      seen.async.push(v);
      return typeof v === "function" ? (v as () => unknown)() : "no-fn";
    },
  },
} as Any) as Any;

Deno.test("async method: a function argument runs, and the caller gets its return", async () => {
  const h = await bootCells([twins]);
  try {
    seen.sync.length = seen.async.length = 0;
    const before = twins.ran;
    assertEquals(await twins.viaSync(() => 7), 7);
    assertEquals(
      await twins.viaAsync(() => 7),
      7,
      "the async twin must run with the function and resolve its result",
    );
    assertEquals(twins.ran - before, 2, "both bodies ran");
  } finally {
    h.dispose();
  }
});

Deno.test("async method: arguments arrive by reference, like the sync twin's", async () => {
  const h = await bootCells([twins]);
  try {
    seen.sync.length = seen.async.length = 0;
    const money = new Money(250);
    const signal = new AbortController().signal;
    const nested = { pick: () => "alice", when: new Date(0) };
    for (const v of [money, signal, nested]) {
      await twins.viaSync(v);
      await twins.viaAsync(v);
    }
    await h.settle();
    for (let i = 0; i < 3; i++) {
      assertStrictEquals(seen.async[i], seen.sync[i], `argument #${i}`);
    }
    assert(seen.async[0] instanceof Money);
    assertEquals((seen.async[0] as Money).fmt(), "$2.5");
    assert(seen.async[1] instanceof AbortSignal);
  } finally {
    h.dispose();
  }
});
