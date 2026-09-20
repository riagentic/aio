// Differential fuzzer, THIRD axis: an async method with awaits in it vs the
// same program cut into one sync method per await.
//
// tests/proxy-differential.test.ts runs every program inside ONE batch (its
// async body has no suspension point), and tests/transaction-differential.ts
// compares three variants that all run on the live proxy — so a bug that lives
// in the live proxy's behaviour ACROSS a commit boundary is invisible to both.
// That boundary is exactly where the incremental read-your-writes overlay
// (`effectiveRoot`) swaps a write-set for a fresh one, so it needs an axis of
// its own: an await IS a commit point (the batcher flushes on the microtask),
// which makes `chunk; await; chunk` the same program as two sequential sync
// method calls.
//
// ALIAS_KINDS are excluded for the reason they are excluded from the
// transaction fuzzer: an alias does not survive a commit, so a program that
// puts one object in two slots legitimately answers differently either side of
// a boundary.
import { assertEquals } from "@std/assert";
import { fuzzEnvInt } from "./fuzz-seed.ts";
import {
  ALIAS_KINDS,
  applyOp,
  type Data,
  initData,
  KINDS,
  type Op,
} from "./fuzz-ops.ts";
import { bootCells } from "../src/testing/cell-test.ts";
import { cell } from "../src/state/cell-create.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const OP_KINDS = KINDS.filter((k) => !ALIAS_KINDS.includes(k));
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const SEED = fuzzEnvInt("FUZZ_SEED", 0x5eed5917) & 0x7fffffff;
const ROUNDS = fuzzEnvInt("FUZZ_ROUNDS", 60, 1);

Deno.test("differential: an awaited async method equals the same program split into sync methods", async () => {
  let seed = SEED;
  const rnd = () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = (n: number) => Math.floor(rnd() * n);

  for (let round = 0; round < ROUNDS; round++) {
    // A program is a list of CHUNKS; the async variant awaits between them,
    // the sync variant runs each chunk as its own method call.
    const chunks: Op[][] = Array.from({ length: 2 + pick(3) }, () =>
      Array.from(
        { length: 1 + pick(5) },
        () => ({
          kind: OP_KINDS[pick(OP_KINDS.length)]!,
          i: pick(9),
          v: pick(100),
        }),
      ));
    const repro = `FUZZ_SEED=${SEED} round ${round}: ${JSON.stringify(chunks)}`;

    const syncLog: unknown[] = [];
    const asyncLog: unknown[] = [];
    const sc = cell(`sp_s_${round}`, {
      state: { data: initData() } as { data: Data },
      methods: {
        step(s: { data: Data }, i: number) {
          for (const op of chunks[i]!) applyOp(s, op, syncLog);
        },
      },
    });
    const ac = cell(`sp_a_${round}`, {
      state: { data: initData() } as { data: Data },
      methods: {
        async run(s: { data: Data }) {
          for (let i = 0; i < chunks.length; i++) {
            if (i > 0) await tick();
            for (const op of chunks[i]!) applyOp(s, op, asyncLog);
          }
        },
      },
    });

    const h = await bootCells([sc, ac]);
    try {
      for (let i = 0; i < chunks.length; i++) await (sc as Any).step(i);
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
