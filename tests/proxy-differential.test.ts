// Differential fuzzer: the live async-method proxy vs the Immer sync draft.
//
// The two are the SAME `s` to an app author — the docs promise that a method
// body behaves identically whether it is sync (Immer draft in the reducer) or
// async (the hand-built live proxy in cell-impl.ts). That proxy re-implements
// JavaScript object semantics by hand — array method interception, overlay
// read-your-writes, nested proxy caching — which is an unbounded surface for
// silent divergence, and the class of bug that has shipped repeatedly
// (find-element writes, iterator support, preventExtensions rejections).
//
// This suite makes the CLASS unshippable instead of chasing instances: random
// programs over the supported state operations run once as a sync method and
// once as an async method, and the final state AND every intermediate read
// must agree exactly. A failure prints the seed + program, so any divergence
// is a one-line repro.
import { assertEquals } from "@std/assert";
import { fuzzEnvInt } from "./fuzz-seed.ts";
import { applyOp, type Data, initData, KINDS, type Op } from "./fuzz-ops.ts";
import { bootCells } from "../src/testing/cell-test.ts";
import { cell } from "../src/state/cell-create.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

// The seed is FIXED by default — CI must explore the same programs on every
// run, or a red build is not reproducible from its own commit. But a fuzzer
// pinned to one seed is really a regression test: it re-checks 120 known
// programs forever and can never find anything new. `FUZZ_SEED` (and
// `FUZZ_ROUNDS`) let a sweep explore beyond them without making the default
// run nondeterministic:
//
//     for s in 1 7 31 99 12345; do FUZZ_SEED=$s deno test -A \
//       tests/proxy-differential.test.ts; done
//
// A divergence prints the seed AND the program, so anything a sweep finds
// comes back as a one-line repro — and belongs here as a fixed case.
const SEED = fuzzEnvInt("FUZZ_SEED", 0x6a11f00d) & 0x7fffffff;
const ROUNDS = fuzzEnvInt("FUZZ_ROUNDS", 120, 1);

Deno.test("differential: a method body behaves identically sync and async", async () => {
  let seed = SEED;
  const rnd = () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = (n: number) => Math.floor(rnd() * n);

  for (let round = 0; round < ROUNDS; round++) {
    const program: Op[] = Array.from(
      { length: 6 + pick(14) },
      () => ({ kind: KINDS[pick(KINDS.length)]!, i: pick(9), v: pick(100) }),
    );
    // The seed is part of the repro: without it a sweep failure names a round
    // number that means nothing on the default seed.
    const repro = `FUZZ_SEED=${SEED} round ${round}: ${
      JSON.stringify(program)
    }`;

    const syncLog: unknown[] = [];
    const asyncLog: unknown[] = [];
    const sc = cell(`fz_s_${round}`, {
      state: { data: initData() } as { data: Data },
      methods: {
        run(s: { data: Data }) {
          for (const op of program) applyOp(s, op, syncLog);
        },
      },
    });
    const ac = cell(`fz_a_${round}`, {
      state: { data: initData() } as { data: Data },
      methods: {
        // deno-lint-ignore require-await
        async run(s: { data: Data }) {
          for (const op of program) applyOp(s, op, asyncLog);
        },
      },
    });

    const h = await bootCells([sc, ac]);
    try {
      await (sc as Any).run();
      await (ac as Any).run();
      await h.settle();
      const syncState = JSON.parse(JSON.stringify((sc as Any).data));
      const asyncState = JSON.parse(JSON.stringify((ac as Any).data));
      assertEquals(asyncState, syncState, `state diverged — ${repro}`);
      assertEquals(asyncLog, syncLog, `reads diverged — ${repro}`);
    } finally {
      h.dispose();
    }
  }
});
