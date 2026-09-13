// `ttl` and `concurrency: "first"` never turn a call that SUCCEEDED into a
// failure because its result could not be copied.
//
// Each caller gets a private copy of a shared result (see
// method-policy-keys-and-copies.test.ts), and the copy is `structuredClone` —
// which a Proxy defeats: from outside it looks like a plain object, so the
// "clones faithfully" check passed and the clone threw. Measured:
//
//   first  runner resolved, adopter's chain threw DataCloneError with nobody
//          listening → UNHANDLED REJECTION, the process died
//   ttl    call1 REJECTED "#<Object> could not be cloned" — the method ran and
//          returned; call2 ran it again
//
// and a result with a getter had the getter run once more by the check, then
// again by the clone. Before the copies existed both resolved {"id":1}: a value
// a copy cannot reproduce is shared by reference, as documented.
import { assertEquals } from "@std/assert";
import { bootCells } from "../src/testing/cell-test.ts";
import { cell } from "../src/state/cell-create.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let runs = 0;

const pol = cell("polunclone", {
  state: { n: 0 },
  concurrency: { firstProxy: "first" },
  ttl: { ttlProxy: 10_000, ttlGetter: 10_000 },
  methods: {
    async firstProxy(_s: Any, id: number) {
      runs++;
      await wait(10);
      return new Proxy({ id }, {});
    },
    async ttlProxy(_s: Any, id: number) {
      runs++;
      await wait(1);
      return new Proxy({ id }, {});
    },
    async ttlGetter(_s: Any, id: number) {
      runs++;
      let reads = 0;
      return {
        id,
        get once() {
          // The framework reads a result once to materialize it; a second
          // read is the policy's copy running a getter it had no business
          // running.
          if (++reads > 1) throw new Error("getter read twice");
          return reads;
        },
      };
    },
  },
} as Any) as Any;

Deno.test('concurrency "first": an uncloneable result resolves runner AND adopter', async () => {
  await using _h = await bootCells([pol]);
  runs = 0;
  const [a, b] = await Promise.all([pol.firstProxy(1), pol.firstProxy(1)]);
  assertEquals([a.id, b.id, runs], [1, 1, 1]);
});

Deno.test("ttl: an uncloneable result neither rejects its call nor misses the cache", async () => {
  await using _h = await bootCells([pol]);
  runs = 0;
  assertEquals((await pol.ttlProxy(1)).id, 1);
  assertEquals((await pol.ttlProxy(1)).id, 1);
  assertEquals(runs, 1);
});

Deno.test("ttl: the copy never runs a result's getter", async () => {
  await using _h = await bootCells([pol]);
  runs = 0;
  assertEquals((await pol.ttlGetter(1)).id, 1);
  assertEquals((await pol.ttlGetter(1)).id, 1);
  assertEquals(runs, 1);
});
