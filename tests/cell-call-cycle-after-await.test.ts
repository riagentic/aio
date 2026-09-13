// A `$call` cycle that recurses AFTER an `await` is refused, not run forever.
//
// The cap counted sibling bodies on the stack at once, and an async body
// leaves the stack at its first `await` — so
//
//   async a(s) { await null; return s.$call.b() }
//   async b(s) { await null; return s.$call.a() }
//
// never counted past one. The two chained microtasks with no macrotask between
// them: no timer ever fired again, the process could not be stopped, and RSS
// went 1.3 → 3.6 GB before anyone noticed. It must be refused at the CHAIN
// cap (`MAX_CALL_CHAIN`), WITHOUT counting a fan-out
// (`cell-call-parallel-siblings.test.ts`) as nesting — and without refusing
// finite recursion across awaits (`cell-call-finite-recursion.test.ts`).
//
// Every body carries a FUSE: when the fix is missing, the loop starves the
// event loop, so a timeout can never fire — the fuse turns the hang into a
// failing assertion instead.
import { assert, assertEquals } from "@std/assert";
import { bootCells } from "../src/testing/cell-test.ts";
import { cell } from "../src/state/cell-create.ts";
import { MAX_CALL_CHAIN } from "../src/state/cell-call.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

let bodies = 0;
const fuse = () => {
  if (++bodies > MAX_CALL_CHAIN * 2) {
    throw new Error("FUSE: the cycle was never refused");
  }
};

const cyc = cell("cycawait", {
  state: { n: 0, got: [] as number[] },
  methods: {
    async a(s: Any) {
      fuse();
      await null;
      return s.$call.b();
    },
    async b(s: Any) {
      fuse();
      await null;
      return s.$call.a();
    },
    // The same cycle through `s.$live`, which is the draft read another way.
    async liveA(s: Any) {
      fuse();
      await null;
      return s.$live.$call.liveB();
    },
    async liveB(s: Any) {
      fuse();
      await null;
      return s.$live.$call.liveA();
    },
    // Honest composition several levels deep, each level awaiting and then
    // fanning out: depth is the chain, not the width.
    async level(s: Any, d: number): Promise<number> {
      fuse();
      await null;
      if (d === 0) {
        s.got.push(d);
        return 1;
      }
      const parts = await Promise.all(
        Array.from({ length: 3 }, () => s.$call.level(d - 1)),
      );
      return parts.reduce((x: number, y: number) => x + y, 0);
    },
    // A sync sibling handing back its own `s` still hands back the draft.
    self(s: Any) {
      return s;
    },
    viaSelf(s: Any) {
      s.n = 7;
      return s.$call.self() === s ? "same" : "different";
    },
  },
} as Any) as Any;

// A transaction's `$live` is a different proxy from its pinned `s`.
const txCyc = cell("cycawaittx", {
  state: { n: 0 },
  transaction: true,
  methods: {
    async txA(s: Any) {
      fuse();
      await null;
      return s.$live.$call.txB();
    },
    async txB(s: Any) {
      fuse();
      await null;
      return s.$call.txA();
    },
  },
} as Any) as Any;

const refusal = (p: Promise<unknown>) =>
  p.then(() => "resolved", (e: Error) => e.message);

Deno.test("$call: a cycle past an await is refused at the cap, naming the chain", async () => {
  await using _h = await bootCells([cyc, txCyc]);
  for (const [c, m] of [[cyc, "a"], [cyc, "liveA"], [txCyc, "txA"]]) {
    bodies = 0;
    const msg = await refusal(c[m]());
    assert(msg.includes(`exceeded ${MAX_CALL_CHAIN}`), `${m}: ${msg}`);
    assert(!msg.includes("FUSE"), `${m}: ${msg}`);
    assert(msg.includes("chain:"), `${m}: the chain is named — ${msg}`);
    assertEquals(bodies, MAX_CALL_CHAIN + 1, `${m}: stopped at the cap`);
  }
});

Deno.test("$call: nested fan-outs past awaits are depth, not width", async () => {
  await using _h = await bootCells([cyc]);
  bodies = 0;
  // 3^6 = 729 leaves, 1093 bodies, 7 levels deep.
  assertEquals(await cyc.level(6), 729);
  assertEquals(cyc.got.length, 729);
  assertEquals(await cyc.viaSelf(), "same");
});
