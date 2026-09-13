// What `set-add`, `set-remove` and `lww-per-key` actually guarantee.
//
// `docs/persistence/crdt.md` lists all three as conflict-free, and only `lww`
// and `counter` had a property test — so the claim rested on nothing. Measured
// with a seeded fuzzer over three peers, and the answer is in two parts:
//
//  • MEMBERSHIP converges. Whatever order three replicas fold the same merges
//    in, the same ids survive. That is the property the strategies promise and
//    the one apps depend on.
//  • ORDER does not, past two peers. Each pairwise merge picks its canonical
//    order from the PAIR's HLCs — which makes the merge symmetric (pinned
//    below, and the reason that order exists at all) — but the merged value
//    carries no HLC of its own, so a three-way fold reaches the same members
//    by different routes and can lay them out differently. Shrunk:
//
//        A = [b,c] @ [1001,2,"A"]   B = [] @ [1002,0,"B"]   C = [d,a] @ [1001,2,"C"]
//        (A+B)+C = [d,a,b,c]        (A+C)+B = [b,c,d,a]
//
//    It is transient in the engine as it stands — `mergeField` results reach
//    only the optimistic client view, and the server stays the convergence
//    authority, so the next broadcast replaces the layout. It is pinned here
//    rather than fixed because the only associative order is one derived from
//    the VALUES (sorting by id), which would throw away the list order every
//    app renders.
import { assert, assertEquals } from "@std/assert";
import { mergeField } from "../../../src/sync/merge.ts";
import { compareHLC } from "../../../src/sync/hlc.ts";
import type { HLC, MergeStrategy } from "../../../src/sync/types.ts";
import { fuzzEnvInt } from "../../fuzz-seed.ts";

/** A replica: a value and the clock it carries. Merging two replicas carries
 *  the LATER clock forward, which is what a real peer does — the merged state
 *  is at least as new as either input. */
type Rep = { v: unknown; h: HLC };
const laterOf = (a: HLC, b: HLC): HLC => (compareHLC(a, b) >= 0 ? a : b);

const SEED = fuzzEnvInt("FUZZ_SEED", 0x5e7ab1e) & 0x7fffffff;
const ROUNDS = fuzzEnvInt("FUZZ_ROUNDS", 400, 1);

function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

type Row = { id: string; v: number };
const ids = ["a", "b", "c", "d", "e"];

/** Every distinct id in a merged array, as a sorted list — the MEMBERSHIP. */
const members = (v: unknown): string[] =>
  [...new Set((v as Row[]).map((r) => r.id))].sort();

Deno.test("set-add/set-remove: membership converges however peers fold", () => {
  const rnd = rng(SEED);
  const pick = (n: number) => Math.floor(rnd() * n);
  for (const strategy of ["set-add", "set-remove"] as MergeStrategy[]) {
    for (let round = 0; round < ROUNDS; round++) {
      const rows = (): Row[] =>
        ids.filter(() => rnd() < 0.5).map((id) => ({ id, v: pick(3) }));
      const base = rows();
      const peers: Rep[] = ["A", "B", "C"].map((n) => ({
        v: rows(),
        h: [1000 + pick(5), pick(3), n] as HLC,
      }));
      const [A, B, C] = peers as [Rep, Rep, Rep];
      const m = (x: Rep, y: Rep): Rep => ({
        v: mergeField(strategy, x.v, x.h, y.v, y.h, base).value,
        h: laterOf(x.h, y.h),
      });

      // Three routes to the same three-peer state.
      const routes = [
        m(m(A, B), C).v,
        m(m(A, C), B).v,
        m(A, m(B, C)).v,
      ];
      const repro = `FUZZ_SEED=${SEED} ${strategy} round ${round}: ` +
        JSON.stringify({ base, peers });
      assertEquals(members(routes[0]), members(routes[1]), repro);
      assertEquals(members(routes[1]), members(routes[2]), repro);
    }
  }
});

Deno.test("set-add/set-remove/lww-per-key: one merge is symmetric", () => {
  // This is the property the canonical ordering exists to give, and it is the
  // one the engine actually relies on: two peers merging the SAME pair must
  // reach the identical value, layout included, or they disagree on screen.
  const rnd = rng(SEED ^ 0x9e3779b9);
  const pick = (n: number) => Math.floor(rnd() * n);
  for (
    const strategy of [
      "set-add",
      "set-remove",
      "lww-per-key",
    ] as MergeStrategy[]
  ) {
    for (let round = 0; round < ROUNDS; round++) {
      const rows = (): Row[] =>
        ids.filter(() => rnd() < 0.5).map((id) => ({ id, v: pick(3) }));
      const obj = (): Record<string, unknown> =>
        Object.fromEntries(
          ids.filter(() => rnd() < 0.5).map((k) => [k, pick(3)]),
        );
      const mk = () => (strategy === "lww-per-key" ? obj() : rows());
      const base = mk();
      const lv = mk(), rv = mk();
      const lh: HLC = [1000 + pick(5), pick(3), "A"];
      const rh: HLC = [1000 + pick(5), pick(3), "B"];
      const ab = mergeField(strategy, lv, lh, rv, rh, base).value;
      const ba = mergeField(strategy, rv, rh, lv, lh, base).value;
      assertEquals(
        JSON.stringify(ab),
        JSON.stringify(ba),
        `FUZZ_SEED=${SEED} ${strategy} round ${round}: one merge, two peers, ` +
          `two answers — ${JSON.stringify({ base, lv, lh, rv, rh })}`,
      );
    }
  }
});

Deno.test("set-add: the three-peer ORDER difference is real, and only order", () => {
  // The shrunk case from the hunt, pinned. If a future change makes the fold
  // associative this test goes red and should be DELETED, not adjusted — the
  // stronger property is strictly better.
  const A: Rep = { v: [{ id: "b" }, { id: "c" }], h: [1001, 2, "A"] };
  const B: Rep = { v: [], h: [1002, 0, "B"] };
  const C: Rep = { v: [{ id: "d" }, { id: "a" }], h: [1001, 2, "C"] };
  const m = (x: Rep, y: Rep): Rep => ({
    v: mergeField("set-add", x.v, x.h, y.v, y.h).value,
    h: laterOf(x.h, y.h),
  });
  const abc = m(m(A, B), C).v;
  const acb = m(m(A, C), B).v;
  assertEquals(members(abc), members(acb), "membership is the same");
  assert(
    JSON.stringify(abc) !== JSON.stringify(acb),
    "the known order difference is gone — if the fold is associative now, " +
      "delete this test and tighten the doc, do not weaken it",
  );
});
