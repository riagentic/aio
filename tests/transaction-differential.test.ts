// Differential fuzzer: the SAME async method program under all three isolation
// levels — no transaction (live reads, incremental commits), `transaction:
// true` (snapshot isolation, one atomic write-set) and `transaction: {
// serialize: true }` (serializable, plus the per-cell mutex).
//
// The invariant it pins is the one users actually rely on when they turn the
// flag on: with a SINGLE writer — one call, no concurrent action anywhere in
// the process — isolation has nothing to isolate from, so it must be
// observationally a NO-OP. Same final state, same value from every intermediate
// read, no refusal. Anything else means `transaction: true` changed the meaning
// of a method body rather than only its visibility to others, and that is a
// silent data bug in the exact cells that opted in because their data mattered.
//
// It is a real gate, not decoration: it is how the `$commit` poisoning was
// isolated (one method, one cell, zero concurrency, and the conflict detector
// still rejected — `$commit` was the sole divergence source across 1450
// programs × 6 seeds). `__commit` is in the op set so the fixed bug stays
// fixed, and `__await` so a suspension point can land anywhere in the program.
//
// The op vocabulary is shared with tests/proxy-differential.test.ts
// (tests/fuzz-ops.ts) — one language, two axes.
import { assertEquals } from "@std/assert";
import { fuzzEnvInt } from "./fuzz-seed.ts";
import { applyOp, type Data, initData, KINDS, type Op } from "./fuzz-ops.ts";
import { bootCells } from "../src/testing/cell-test.ts";
import { cell } from "../src/state/cell-create.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/** `__await` suspends (every isolation level's commit behaviour differs across
 *  a suspension point — that is the whole feature); `__commit` publishes the
 *  buffer mid-method (a no-op off the flag, by design in `createLiveProxy`, so
 *  the SAME program text runs on all three cells). */
const CONTROL_KINDS = ["__await", "__commit"];
const ALL_KINDS = [...KINDS, ...CONTROL_KINDS];

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

async function runProgram(
  s: { data: Data },
  program: Op[],
  log: unknown[],
): Promise<void> {
  for (const op of program) {
    if (op.kind === "__await") {
      await tick();
      continue;
    }
    if (op.kind === "__commit") {
      (s as Any).$commit();
      continue;
    }
    applyOp(s, op, log);
  }
}

// Fixed by default so CI is reproducible from its own commit; `FUZZ_SEED` /
// `FUZZ_ROUNDS` let a sweep explore past the pinned programs:
//
//     for s in 1 7 31 99 12345; do FUZZ_SEED=$s FUZZ_ROUNDS=250 deno test -A \
//       tests/transaction-differential.test.ts; done
//
// A divergence prints the seed and the program — a one-line repro that belongs
// back here as a fixed case.
const SEED = fuzzEnvInt("FUZZ_SEED", 0x7c0ffee1) & 0x7fffffff;
const ROUNDS = fuzzEnvInt("FUZZ_ROUNDS", 90, 1);

Deno.test("differential: with one writer, transaction/serialize are observationally a no-op", async () => {
  let seed = SEED;
  const rnd = () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = (n: number) => Math.floor(rnd() * n);

  for (let round = 0; round < ROUNDS; round++) {
    const program: Op[] = Array.from(
      { length: 6 + pick(14) },
      () => ({
        kind: ALL_KINDS[pick(ALL_KINDS.length)]!,
        i: pick(9),
        v: pick(100),
      }),
    );
    const repro = `FUZZ_SEED=${SEED} round ${round}: ${
      JSON.stringify(program)
    }`;

    const logs: Record<string, unknown[]> = { plain: [], txn: [], serial: [] };
    const make = (variant: string, transaction: unknown) =>
      cell(`tx_${variant}_${round}`, {
        ...(transaction === undefined ? {} : { transaction }),
        state: { data: initData() } as { data: Data },
        methods: {
          async run(s: { data: Data }) {
            await runProgram(s, program, logs[variant]!);
          },
        },
        // deno-lint-ignore no-explicit-any
      } as any);
    const plain = make("plain", undefined);
    const txn = make("txn", true);
    const serial = make("serial", { serialize: true });

    const h = await bootCells([plain, txn, serial]);
    try {
      // Sequentially: the claim under test is about a SINGLE writer. (Under
      // concurrency the levels are *supposed* to differ — that is what
      // transactional-methods.test.ts pins.)
      await (plain as Any).run();
      await (txn as Any).run();
      await (serial as Any).run();
      await h.settle();
      const state = (c: unknown) => JSON.parse(JSON.stringify((c as Any).data));
      assertEquals(
        state(txn),
        state(plain),
        `transaction: true changed the outcome — ${repro}`,
      );
      assertEquals(
        state(serial),
        state(plain),
        `transaction: { serialize: true } changed the outcome — ${repro}`,
      );
      assertEquals(
        logs.txn,
        logs.plain,
        `transaction: true changed what a read returns — ${repro}`,
      );
      assertEquals(
        logs.serial,
        logs.plain,
        `serialize changed what a read returns — ${repro}`,
      );
    } finally {
      h.dispose();
    }
  }
});
