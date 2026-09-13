// Finite recursion through `$call` across an `await` runs to the end.
//
// The chain cap that stops a cycle hidden by an await
// (`cell-call-cycle-after-await.test.ts`) was the stack cap's 32, so an honest
// paginated fetch —
//
//   async fetchPage(s, p, last) { await io; s.items.push(p);
//                                 if (p < last) await s.$call.fetchPage(p + 1, last) }
//
// — over 40 pages was refused as "almost always a cycle" with pages 1–32
// already written. Nothing distinguishes that from a cycle except that it ends,
// so the chain has its own, much higher cap; the STACK cap stays 32.
import { assert, assertEquals } from "@std/assert";
import { bootCells } from "../src/testing/cell-test.ts";
import { cell } from "../src/state/cell-create.ts";
import { MAX_CALL_CHAIN, MAX_CALL_DEPTH } from "../src/state/cell-call.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const pages = cell("callrecurse", {
  state: { items: [] as number[] },
  methods: {
    // Yields to a timer between pages — the network, in a test.
    async fetchPage(s: Any, page: number, last: number): Promise<void> {
      await tick();
      s.items.push(page);
      if (page < last) await s.$call.fetchPage(page + 1, last);
    },
    // Yields only to microtasks (a cached fetch), and returns a value up the
    // chain rather than writing.
    async sumTo(s: Any, n: number): Promise<number> {
      await null;
      return n === 0 ? 0 : n + await s.$call.sumTo(n - 1);
    },
    // Sync recursion is on the stack: still the stack cap.
    down(s: Any, n: number): number {
      return n === 0 ? 0 : 1 + s.$call.down(n - 1);
    },
  },
} as Any) as Any;

Deno.test("$call: a paginated recursion past the stack cap runs every page", async () => {
  await using _h = await bootCells([pages]);
  const last = MAX_CALL_DEPTH * 4;
  await pages.fetchPage(1, last);
  assertEquals(pages.items, Array.from({ length: last }, (_, i) => i + 1));
});

Deno.test("$call: microtask-only finite recursion up to the chain cap resolves", async () => {
  await using _h = await bootCells([pages]);
  // `sumTo(n)` is n chained `$call`s below the dispatched call.
  const n = MAX_CALL_CHAIN;
  assertEquals(await pages.sumTo(n), (n * (n + 1)) / 2);
  const msg = await pages.sumTo(n + 1).then(
    () => "resolved",
    (e: Error) => e.message,
  );
  assert(msg.includes(`exceeded ${MAX_CALL_CHAIN} chained`), msg);
});

Deno.test("$call: sync recursion is still bounded by the stack cap", async () => {
  await using _h = await bootCells([pages]);
  assertEquals(await pages.down(MAX_CALL_DEPTH), MAX_CALL_DEPTH);
  const msg = await Promise.resolve(pages.down(MAX_CALL_DEPTH + 1)).then(
    () => "resolved",
    (e: Error) => e.message,
  );
  assert(msg.includes(`exceeded ${MAX_CALL_DEPTH} nested`), msg);
});
