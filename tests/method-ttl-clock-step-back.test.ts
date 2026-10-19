// A method's `ttl` cache does not outlive its ttl when the wall clock steps
// back.
//
// The cache ages an entry as `Date.now() - at`. After a backward step (an
// NTP/chrony correction, a VM restored from a snapshot) that age is NEGATIVE,
// and a negative age is "< ttl" for as long as the step was: a 60 s price
// cache stepped back an hour served the same price for an hour and a minute,
// and the sweep (`age >= ttl`) never evicted it either. An entry from the
// clock's "future" cannot be judged fresh, so it is a miss.
import { assertEquals } from "@std/assert";
import { bootCells } from "../src/testing/cell-test.ts";
import { cell } from "../src/state/cell-create.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

let runs = 0;

const prices = cell("ttlstepback", {
  state: { n: 0 },
  ttl: { quote: 60_000 },
  methods: {
    async quote(_s: Any) {
      await Promise.resolve();
      return ++runs;
    },
  },
} as Any) as Any;

Deno.test("method ttl: a wall clock stepped back an hour does not keep a 60s result for an hour", async () => {
  await using _h = await bootCells([prices]);
  const realNow = Date.now;
  try {
    assertEquals(await prices.quote(), 1);
    assertEquals(await prices.quote(), 1, "fresh within the ttl");
    const t = realNow();
    Date.now = () => t - 3_600_000; // NTP steps the clock back an hour
    assertEquals(
      await prices.quote(),
      2,
      "an entry stamped in the clock's future is not fresh",
    );
  } finally {
    Date.now = realNow;
  }
});
