// Randomized lifecycle fuzzer — the END of a process's life, under load.
//
// The bug class this exists for is the VANISHING WRITE: a method that returned
// successfully, whose change never reached disk, with nothing in the log to say
// so. Shutdown is the densest place for it — the window closes while sync
// methods are landing, async methods are mid-await, effects are dispatching
// follow-ups, timers are about to fire, and a second `close()` may arrive from
// a signal handler at the same moment.
//
// One invariant, checked after every program:
//
//   EVERY call that RESOLVED before shutdown() was invoked is present in the
//   state read back FROM DISK after shutdown.
//
// "Resolved" is the whole point: `await cell.method()` returning is the
// framework's promise that the change was applied. If that change can be absent
// from the next launch, the promise is a lie — and it is a silent one.
//
// Seeded and replayable: `AIO_FUZZ_SEED=… AIO_FUZZ_ROUNDS=… deno test -A
// tests/shutdown-lifecycle-fuzz.test.ts`.
import { assert, assertEquals } from "@std/assert";
import { fuzzEnvInt } from "./fuzz-seed.ts";
import { freePort } from "../src/testing/server-test.ts";
import type { MethodDraftMeta } from "../src/state/cell-impl.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** mulberry32 — same tiny deterministic PRNG the other fuzzers use. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Doc = { applied: string[]; n: number };

async function boot(name: string, dir: string, defs: unknown[]) {
  const { aio } = await import("../mod.ts");
  return await aio.run({
    cells: defs,
    appId: name,
    appVersion: "0.0.0",
    client: "server-only",
    persist: true,
    libraryMode: true,
    port: freePort(),
    appDir: dir,
  } as Any) as Any;
}

async function defineCell(name: string) {
  const { cell } = await import("../mod.ts");
  return cell(name, {
    // alpha52: pins incremental/abort-path write semantics — the opt-out.
    transaction: false,
    state: { applied: [] as string[], n: 0 } as Doc,
    methods: {
      // Sync: applies inside reduce, resolves when the queue drains.
      bump(s: Doc, id: string) {
        s.applied = [...s.applied, id];
        s.n++;
      },
      // Async, well-behaved: writes on both sides of an await, and takes its
      // documented cancellation path.
      async slow(s: Doc & Partial<MethodDraftMeta>, id: string, steps: number) {
        for (let i = 0; i < steps; i++) {
          if (s.$signal?.aborted) {
            s.applied = [...s.applied, `${id}!`];
            return;
          }
          await sleep(3);
          s.applied = [...s.applied, `${id}.${i}`];
        }
        s.applied = [...s.applied, id];
        s.n++;
      },
      // Async, ignores its abort signal entirely — the shape that must be
      // BOUNDED by the drain budget rather than hold the window open.
      async deaf(s: Doc, id: string) {
        for (let i = 0; i < 400; i++) await sleep(5);
        s.applied = [...s.applied, id];
      },
      // An async method that dispatches a follow-up: the re-entrant path.
      async chain(s: Doc & { $cell?: never }, id: string) {
        await sleep(2);
        s.applied = [...s.applied, `${id}a`];
        await sleep(2);
        s.applied = [...s.applied, `${id}b`, id];
        s.n++;
      },
    },
  });
}

type Op = { kind: string; id: string };

const OPS = ["bumpAwait", "bumpFF", "slowAwait", "slowFF", "deafFF", "chainFF"];

/** The cell under test carries one sync method and three async shapes.
 *  `applied` is an append-only receipt list: a call that resolved has to be in
 *  it, on disk, afterwards.
 *
 *  Run ONE randomized program against a fresh app, then assert the invariant
 *  against what the NEXT launch actually reads from disk. */
async function round(seed: number): Promise<{ ops: number; resolved: number }> {
  const r = rng(seed);
  const name = `fz${seed % 100000}`;
  const dir = await Deno.makeTempDir({ prefix: "aio-shutdown-fuzz-" });
  // Every call whose promise RESOLVED before shutdown started. These are the
  // receipts the persisted document must honour.
  const resolved = new Set<string>();
  const pending: Promise<unknown>[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  let ops = 0;
  try {
    const def = await defineCell(name);
    const app = await boot(name, dir, [def]);
    const c = def as Any;

    const nOps = 3 + Math.floor(r() * 8);
    for (let i = 0; i < nOps; i++) {
      const op: Op = {
        kind: OPS[Math.floor(r() * OPS.length)]!,
        id: `o${i}`,
      };
      ops++;
      switch (op.kind) {
        case "bumpAwait":
          await c.bump(op.id);
          resolved.add(op.id);
          break;
        case "bumpFF": {
          const p = c.bump(op.id).then(() => resolved.add(op.id));
          pending.push(p.catch(() => {}));
          break;
        }
        case "slowAwait":
          await c.slow(op.id, 1 + Math.floor(r() * 3));
          resolved.add(op.id);
          break;
        case "slowFF": {
          const p = c.slow(op.id, 2 + Math.floor(r() * 20)).then(() =>
            resolved.add(op.id)
          );
          pending.push(p.catch(() => {}));
          break;
        }
        case "deafFF":
          pending.push((c.deaf(op.id) as Promise<unknown>).catch(() => {}));
          break;
        case "chainFF": {
          const p = c.chain(op.id).then(() => resolved.add(op.id));
          pending.push(p.catch(() => {}));
          break;
        }
      }
      // A timer that may land mid-shutdown — the "a schedule fires during the
      // drain" interleaving, without needing the scheduler itself.
      if (r() < 0.3) {
        timers.push(
          setTimeout(() => {
            (c.bump(`t${i}`) as Promise<unknown>).catch(() => {});
          }, Math.floor(r() * 40)),
        );
      }
      if (r() < 0.5) await sleep(Math.floor(r() * 12));
    }

    // The receipts are frozen HERE: anything that resolves after this point is
    // a bonus, never an obligation.
    const owed = [...resolved];

    const t0 = Date.now();
    // Sometimes two concurrent closes (a signal handler racing the window).
    const closes = r() < 0.35 ? [app.close(), app.close()] : [app.close()];
    await Promise.all(closes);
    const elapsed = Date.now() - t0;
    assert(
      elapsed < 20_000,
      `seed ${seed}: shutdown took ${elapsed}ms — a phase is unbounded again`,
    );

    for (const t of timers) clearTimeout(t);
    await Promise.allSettled(pending);

    // Read the DISK, via a fresh boot — `app.getState()` on a closed app is
    // the released in-memory slice, not what the user gets back next launch.
    const app2 = await boot(name, dir, [await defineCell(name)]);
    const restored = app2.getState()[name] as Doc;
    await app2.close();

    const have = new Set(restored.applied);
    const missing = owed.filter((id) => !have.has(id));
    assertEquals(
      missing,
      [],
      `seed ${seed}: ${missing.length} call(s) resolved before shutdown but ` +
        `their write is NOT on disk — a vanishing write. persisted=${
          JSON.stringify(restored.applied)
        }`,
    );
    return { ops, resolved: owed.length };
  } finally {
    for (const t of timers) clearTimeout(t);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test({
  name: "shutdown fuzz: a resolved call's write is always on disk afterwards",
  async fn() {
    const rounds = fuzzEnvInt("AIO_FUZZ_ROUNDS", 12, 1);
    const seed0 = fuzzEnvInt("AIO_FUZZ_SEED", 20260805, 0);
    let ops = 0, receipts = 0;
    for (let i = 0; i < rounds; i++) {
      const s = await round(seed0 + i * 7919);
      ops += s.ops;
      receipts += s.resolved;
    }
    assert(ops > 0, "the fuzzer must actually have run programs");
    assert(receipts > 0, "…and at least some calls must have resolved");
    console.log(
      `shutdown fuzz: ${rounds} programs, ${ops} ops, ${receipts} receipts honoured`,
    );
  },
});
