// A transactional method's RETURN of state it wrote includes the write —
// read-your-writes (docs/state/transactional-methods.md §4) holds for the value
// the caller gets, as it does for a read inside the body and as it does for a
// non-transactional method. The return used to be materialized AFTER the
// commit, when the snapshot proxy no longer overlaid the write-set, so
// `s.obj.q = 5; return s.obj` answered `{ q: 0 }`. The fuzzer twin of this is
// the transactional leg of tests/proxy-differential.test.ts.
import { assertEquals, assertRejects } from "@std/assert";
import { bootCells } from "../src/testing/cell-test.ts";
import { cell } from "../src/state/cell-create.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

type S = { obj: Record<string, number>; list: number[] };
const mk = (name: string, transaction: boolean) =>
  cell(name, {
    ...(transaction ? { transaction: true } : {}),
    state: { obj: { a: 1, q: 0 }, list: [1, 2] } as S,
    methods: {
      async wroteObj(s: S) {
        s.obj.q = 5;
        const seen = s.obj.q;
        await Promise.resolve();
        return { seen, ret: s.obj };
      },
      // deno-lint-ignore require-await
      async pushed(s: S) {
        s.list.push(9);
        return { len: s.list.length, ret: s.list };
      },
      // deno-lint-ignore require-await
      async circular(s: S) {
        s.obj.q = 7;
        const o: Record<string, unknown> = { x: s.obj };
        o.self = o;
        return o;
      },
    },
  } as Any);

for (const tx of [false, true]) {
  Deno.test(`return of a written object includes the write (transaction: ${tx})`, async () => {
    const c = mk(tx ? "txrw_t" : "txrw_l", tx) as Any;
    await using _h = await bootCells([c]);
    const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
    assertEquals(plain(await c.wroteObj()), {
      seen: 5,
      ret: { a: 1, q: 5 },
    });
    assertEquals(plain(await c.pushed()), { len: 3, ret: [1, 2, 9] });
  });

  // Materializing early must not reorder failure: a return that cannot be
  // materialized still rejects the caller AFTER its write-set committed —
  // exactly as when the value was materialized post-commit.
  Deno.test(`an unmaterializable return still rejects after the commit (transaction: ${tx})`, async () => {
    const c = mk(tx ? "txrw_ct" : "txrw_cl", tx) as Any;
    await using _h = await bootCells([c]);
    await assertRejects(() => c.circular(), Error, "circular");
    assertEquals(c.obj.q, 7);
  });
}
