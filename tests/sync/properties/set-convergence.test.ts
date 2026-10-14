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
import { mulberry32 } from "./_prop.ts";

/** A replica: a value and the clock it carries. Merging two replicas carries
 *  the LATER clock forward, which is what a real peer does — the merged state
 *  is at least as new as either input. */
type Rep = { v: unknown; h: HLC };
const laterOf = (a: HLC, b: HLC): HLC => (compareHLC(a, b) >= 0 ? a : b);

const SEED = fuzzEnvInt("FUZZ_SEED", 0x5e7ab1e) & 0x7fffffff;
const ROUNDS = fuzzEnvInt("FUZZ_ROUNDS", 400, 1);

type Row = { id: string; v: number };
const ids = ["a", "b", "c", "d", "e"];

/** Which of `sets` hold `id`, as one bit each ("101"): the situations a
 *  merge can meet an id in — kept by all, dropped by one, added by one… */
const presence = (id: string, sets: unknown[]): string =>
  sets.map((v) =>
    (Array.isArray(v) ? v.some((r: Row) => r.id === id) : id in (v as object))
      ? "1"
      : "0"
  ).join("");
const allBits = (n: number): string[] =>
  Array.from({ length: 2 ** n }, (_, i) => i.toString(2).padStart(n, "0"));

/** Every distinct id in a merged array, as a sorted list — the MEMBERSHIP. */
const members = (v: unknown): string[] =>
  [...new Set((v as Row[]).map((r) => r.id))].sort();

Deno.test("set-add/set-remove: membership converges however peers fold", () => {
  const rnd = mulberry32(SEED);
  const pick = (n: number) => Math.floor(rnd() * n);
  for (const strategy of ["set-add", "set-remove"] as MergeStrategy[]) {
    // What a round drew: the peers' clock order (ties on time included),
    // and where each id was (base, A, B, C).
    const seen = new Set<string>();
    for (let round = 0; round < ROUNDS; round++) {
      const rows = (): Row[] =>
        ids.filter(() => rnd() < 0.5).map((id) => ({ id, v: pick(3) }));
      const base = rows();
      const peers: Rep[] = ["A", "B", "C"].map((n) => ({
        v: rows(),
        h: [1000 + pick(5), pick(3), n] as HLC,
      }));
      const [A, B, C] = peers as [Rep, Rep, Rep];
      seen.add(
        [...peers].sort((x, y) => compareHLC(x.h, y.h)).map((p) => p.h[2])
          .join("<"),
      );
      if (new Set(peers.map((p) => `${p.h[0]}.${p.h[1]}`)).size < 3) {
        seen.add("same time");
      }
      for (const id of ids) seen.add(presence(id, [base, A.v, B.v, C.v]));
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
    // A generator that stopped drawing a case compares nothing about it.
    if (ROUNDS >= 400) {
      const kinds = [
        ...["A<B<C", "A<C<B", "B<A<C", "B<C<A", "C<A<B", "C<B<A"],
        "same time",
        ...allBits(4),
      ];
      assertEquals(
        kinds.filter((k) => !seen.has(k)),
        [],
        `${strategy}: cases never drawn`,
      );
    }
  }
});

Deno.test("set-add/set-remove/lww-per-key: one merge is symmetric", () => {
  // This is the property the canonical ordering exists to give, and it is the
  // one the engine actually relies on: two peers merging the SAME pair must
  // reach the identical value, layout included, or they disagree on screen.
  const rnd = mulberry32(SEED ^ 0x9e3779b9);
  const pick = (n: number) => Math.floor(rnd() * n);
  for (
    const strategy of [
      "set-add",
      "set-remove",
      "lww-per-key",
    ] as MergeStrategy[]
  ) {
    const seen = new Set<string>();
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
      seen.add(compareHLC(lh, rh) < 0 ? "A<B" : "B<A");
      if (lh[0] === rh[0] && lh[1] === rh[1]) seen.add("same time");
      for (const id of ids) seen.add(presence(id, [base, lv, rv]));
      const ab = mergeField(strategy, lv, lh, rv, rh, base).value;
      const ba = mergeField(strategy, rv, rh, lv, lh, base).value;
      assertEquals(
        JSON.stringify(ab),
        JSON.stringify(ba),
        `FUZZ_SEED=${SEED} ${strategy} round ${round}: one merge, two peers, ` +
          `two answers — ${JSON.stringify({ base, lv, lh, rv, rh })}`,
      );
    }
    if (ROUNDS >= 400) {
      assertEquals(
        ["A<B", "B<A", "same time", ...allBits(3)].filter((k) => !seen.has(k)),
        [],
        `${strategy}: cases never drawn`,
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
