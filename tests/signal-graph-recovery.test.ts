// Five ways the signal graph lost a subscriber, and the property that makes
// the class unshippable.
//
// Each of the first five is a node that stopped hearing about writes it
// depended on — with no error, no log, and a value that LOOKED right until
// the world moved: a computed that threw once and kept zero upstream links, an
// effect that threw on its first run and could never be disposed, a cleanup
// returned by an effect that had just disposed itself, a memo hit over a
// computed that compared `undefined` to `undefined`, and an effect whose
// dependency moved during its own creation run. The last test is a
// randomized DAG differential against a reference evaluator over the raw
// signals: every effect's last observation must equal what the sources say
// NOW, after every op, with throwing computeds, batches, foreign writes from
// inside effects, and create/dispose churn — and nothing may be left
// subscribed after teardown.
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  _effectCollectEnd,
  _effectCollectStart,
  _effectDisposeAll,
  batch,
  computed,
  effect,
  signal,
  trackedMemo,
} from "../src/state/signal.ts";
import { fuzzEnvInt } from "./fuzz-seed.ts";

const subs = (x: unknown): number =>
  (x as { _subscribers: Set<unknown> })._subscribers.size;

Deno.test("computed: a throw does not sever it — the source's next write reaches the effects downstream", () => {
  const s = signal(-1);
  const c = computed(() => {
    const v = s.value;
    if (v < 0) throw new Error("not ready");
    return v * 2;
  });
  const seen: string[] = [];
  const dispose = effect(() => {
    try {
      seen.push(`ok:${c.value}`);
    } catch {
      seen.push("throw");
    }
  });
  assertEquals(seen, ["throw"]);
  assertEquals(subs(s), 1, "the failed compute keeps the link to its source");
  s.set(5);
  assertEquals(seen, ["throw", "ok:10"], "recovery re-runs the effect");
  s.set(-2);
  s.set(7);
  assertEquals(seen, ["throw", "ok:10", "throw", "ok:14"]);
  dispose();
  (c as unknown as { dispose(): void }).dispose();
  assertEquals(subs(s), 0);
});

Deno.test("computed: recovery propagates through a chain of computeds", () => {
  const s = signal(-1);
  const c1 = computed(() => {
    if (s.value < 0) throw new Error("neg");
    return s.value;
  });
  const c2 = computed(() => c1.value + 1);
  const seen: string[] = [];
  const dispose = effect(() => {
    try {
      seen.push(`ok:${c2.value}`);
    } catch {
      seen.push("throw");
    }
  });
  s.set(1);
  assertEquals(seen, ["throw", "ok:2"]);
  dispose();
});

Deno.test("effect: a first run that throws leaves no subscriber and no zombie", () => {
  const s = signal(0);
  let runs = 0;
  assertThrows(
    () =>
      effect(() => {
        runs++;
        s.value;
        throw new Error("first run fails");
      }),
    Error,
    "first run fails",
  );
  assertEquals(subs(s), 0, "nothing may hold a subscription nobody can drop");
  s.set(1);
  assertEquals(runs, 1, "an effect that failed to be created never runs again");
});

Deno.test("effect: a first-run throw inside a render collector registers nothing to dispose", () => {
  const s = signal(0);
  const collected = _effectCollectStart();
  try {
    assertThrows(() =>
      effect(() => {
        s.value;
        throw new Error("boom");
      })
    );
  } finally {
    _effectCollectEnd(collected);
  }
  assertEquals(collected.length, 0);
  _effectDisposeAll(collected);
  assertEquals(subs(s), 0);
});

Deno.test("effect: the cleanup returned by a self-disposing run is invoked", () => {
  const s = signal(0);
  let cleaned = 0;
  let dispose: () => void = () => {};
  dispose = effect(() => {
    if (s.value === 1) {
      dispose();
      return () => {
        cleaned++;
      };
    }
  });
  s.set(1);
  assertEquals(cleaned, 1, "a cleanup handed to a dead effect must still run");
  dispose();
  assertEquals(cleaned, 1, "…exactly once");
  assertEquals(subs(s), 0);
});

Deno.test("trackedMemo: a hit whose read set contains a computed recomputes when the computed's source moved", () => {
  const s = signal(1);
  const c = computed(() => s.value * 10);
  let computes = 0;
  const memo = trackedMemo((k: string) => {
    computes++;
    return `${k}:${c.value}`;
  });
  assertEquals(memo("a"), "a:10");
  assertEquals(memo("a"), "a:10");
  assertEquals(computes, 1, "an unmoved computed is a hit");
  s.set(2);
  assertEquals(memo("a"), "a:20", "a moved computed is a miss");
  assertEquals(computes, 2);
});

Deno.test("trackedMemo: a computed that recomputes to the SAME value keeps the hit fresh", () => {
  const s = signal(1);
  const parity = computed(() => s.value % 2);
  let computes = 0;
  const memo = trackedMemo((k: string) => {
    computes++;
    return `${k}:${parity.value}`;
  });
  memo("a");
  s.set(3); // parity unchanged
  assertEquals(memo("a"), "a:1");
  assertEquals(computes, 1, "same derived value ⇒ still a hit");
  s.set(4);
  assertEquals(memo("a"), "a:0");
  assertEquals(computes, 2);
});

Deno.test("effect: a dependency moved during its own creation run (by the effect its write woke) is not missed", () => {
  const x = signal(0), y = signal(0);
  const dB = effect(() => {
    y.set(x.value + 1);
  });
  let seen = -1;
  const dA = effect(() => {
    seen = y.value;
    x.set(5);
  });
  assertEquals(y.peek(), 6);
  assertEquals(seen, 6, "A must hold the value y has, not the one it had");
  dA();
  dB();
});

Deno.test("effect: a write to its OWN dependency still never re-triggers it (documented rule)", () => {
  const s = signal(0);
  let runs = 0;
  const d = effect(() => {
    runs++;
    if (s.value < 3) s.set(s.value + 1);
  });
  assertEquals(runs, 1);
  s.set(0);
  assertEquals(runs, 2);
  d();
});

// ── Randomized DAG differential ─────────────────────────────────────

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Node = { kind: "s"; i: number } | { kind: "c"; i: number };
type Spec = { deps: Node[]; cond: number; throwsOn: number | null };
type Val = number | "throw";

Deno.test("signal graph fuzz: every effect's last observation equals the reference over the raw signals, after every op", () => {
  const seed = fuzzEnvInt("AIO_FUZZ_SEED", 1274);
  const rounds = fuzzEnvInt("AIO_FUZZ_ROUNDS", 40);
  const OPS = 300;
  const violations: string[] = [];

  for (let round = 0; round < rounds && violations.length < 6; round++) {
    const rseed = seed * 1000 + round;
    const r = rng(rseed);
    const NS = 3 + Math.floor(r() * 5);
    const NC = 2 + Math.floor(r() * 8);
    const sigs = Array.from(
      { length: NS },
      (_, i) => signal(Math.floor(r() * 10), `s${i}`),
    );
    const pickDeps = (maxC: number): Node[] => {
      const n = 1 + Math.floor(r() * 4);
      const out: Node[] = [];
      for (let k = 0; k < n; k++) {
        out.push(
          maxC > 0 && r() < 0.5
            ? { kind: "c", i: Math.floor(r() * maxC) }
            : { kind: "s", i: Math.floor(r() * NS) },
        );
      }
      return out;
    };
    const half = (spec: Spec, cond: number): Node[] =>
      cond % 2 === 0
        ? spec.deps.slice(0, Math.ceil(spec.deps.length / 2))
        : spec.deps.slice(Math.floor(spec.deps.length / 2));

    // Reference: the computed graph evaluated over peek()ed signals, memoized
    // per query so a diamond is consistent.
    const cSpecs: Spec[] = [];
    const comps: ReturnType<typeof computed<number>>[] = [];
    const refC = (j: number, memo: Map<number, Val>): Val => {
      const hit = memo.get(j);
      if (hit !== undefined) return hit;
      const sp = cSpecs[j]!;
      let res: Val = j;
      if (sp.throwsOn !== null && sigs[sp.throwsOn]!.peek() < 0) res = "throw";
      else {
        for (const d of half(sp, sigs[sp.cond]!.peek())) {
          const v = d.kind === "s" ? sigs[d.i]!.peek() : refC(d.i, memo);
          if (v === "throw") {
            res = "throw";
            break;
          }
          res = (res as number) + v;
        }
      }
      memo.set(j, res);
      return res;
    };
    for (let j = 0; j < NC; j++) {
      const sp: Spec = {
        deps: pickDeps(j),
        cond: Math.floor(r() * NS),
        throwsOn: r() < 0.25 ? Math.floor(r() * NS) : null,
      };
      cSpecs.push(sp);
      comps.push(computed(() => {
        if (sp.throwsOn !== null && sigs[sp.throwsOn]!.value < 0) {
          throw new Error(`c${j} throws`);
        }
        let sum = j;
        for (const d of half(sp, sigs[sp.cond]!.value)) {
          sum += d.kind === "s" ? sigs[d.i]!.value : comps[d.i]!.value;
        }
        return sum;
      }));
    }

    // Does signal i feed computed j, transitively? An effect may only write
    // signals it does not read (directly or through a computed): a write to
    // its own dependency never re-triggers it, by documented rule.
    const cReads = (
      j: number,
      i: number,
      seen = new Set<number>(),
    ): boolean => {
      if (seen.has(j)) return false;
      seen.add(j);
      const sp = cSpecs[j]!;
      if (sp.cond === i || sp.throwsOn === i) return true;
      return sp.deps.some((d) =>
        d.kind === "s" ? d.i === i : cReads(d.i, i, seen)
      );
    };

    type Eff = {
      id: number;
      spec: Spec;
      last: string;
      disposed: boolean;
      dispose: () => void;
      writes: boolean;
    };
    const effs: Eff[] = [];
    let budget = 0;
    const evalEff = (spec: Spec, read: (n: Node) => Val): string => {
      const cond = read({ kind: "s", i: spec.cond });
      if (cond === "throw") return "throw";
      const vals: number[] = [];
      for (const d of half(spec, cond)) {
        const v = read(d);
        if (v === "throw") return "throw";
        vals.push(v);
      }
      return vals.join(",");
    };
    const refEff = (spec: Spec): string => {
      const memo = new Map<number, Val>();
      return evalEff(
        spec,
        (n) => n.kind === "s" ? sigs[n.i]!.peek() : refC(n.i, memo),
      );
    };
    const mkEff = (): Eff => {
      const spec: Spec = {
        deps: pickDeps(NC),
        cond: Math.floor(r() * NS),
        throwsOn: null,
      };
      const e: Eff = {
        id: effs.length,
        spec,
        last: "",
        disposed: false,
        dispose: () => {},
        writes: r() < 0.3,
      };
      const readsSig = (i: number): boolean =>
        spec.cond === i ||
        spec.deps.some((d) => d.kind === "s" ? d.i === i : cReads(d.i, i));
      e.dispose = effect(() => {
        if (e.disposed) {
          violations.push(`seed ${rseed}: effect ${e.id} ran AFTER dispose`);
        }
        const memo = new Map<number, Val>();
        e.last = evalEff(spec, (n) => {
          if (n.kind === "s") return sigs[n.i]!.value;
          let live: Val;
          try {
            live = comps[n.i]!.value;
          } catch {
            live = "throw";
          }
          const ref = refC(n.i, memo);
          if (live !== ref) {
            violations.push(
              `seed ${rseed}: GLITCH effect ${e.id} read c${n.i}=${live}, reference=${ref}`,
            );
          }
          return live;
        });
        if (e.writes && budget > 0 && r() < 0.3) {
          budget--;
          let i = Math.floor(r() * NS);
          for (let tries = 0; readsSig(i) && tries < 20; tries++) {
            i = Math.floor(r() * NS);
          }
          if (!readsSig(i)) sigs[i]!.set(Math.floor(r() * 10) - 2);
        }
      });
      return e;
    };
    for (let k = 0; k < 2 + Math.floor(r() * 4); k++) effs.push(mkEff());

    const check = (op: number, what: string): void => {
      for (const e of effs) {
        if (e.disposed) continue;
        const want = refEff(e.spec);
        if (e.last !== want) {
          violations.push(
            `seed ${rseed} op ${op} [${what}]: STALE effect ${e.id}: last="${e.last}" expected="${want}" spec=${
              JSON.stringify(e.spec)
            }`,
          );
        }
      }
    };
    check(-1, "init");
    for (let op = 0; op < OPS && violations.length < 6; op++) {
      const k = r();
      budget = 8;
      let what = "";
      if (k < 0.45) {
        const i = Math.floor(r() * NS);
        const v = Math.floor(r() * 12) - 2;
        what = `set s${i}=${v}`;
        sigs[i]!.set(v);
      } else if (k < 0.7) {
        const n = 1 + Math.floor(r() * 4);
        const ws: string[] = [];
        batch(() => {
          for (let q = 0; q < n; q++) {
            const i = Math.floor(r() * NS);
            const v = Math.floor(r() * 12) - 2;
            ws.push(`s${i}=${v}`);
            if (r() < 0.3) sigs[i]!.update((p) => p + v);
            else sigs[i]!.set(v);
          }
        });
        what = `batch ${ws.join(" ")}`;
      } else if (k < 0.85) {
        const live = effs.filter((e) => !e.disposed);
        if (live.length) {
          const e = live[Math.floor(r() * live.length)]!;
          e.disposed = true;
          e.dispose();
          what = `dispose e${e.id}`;
        }
      } else if (effs.filter((e) => !e.disposed).length < 8) {
        const e = mkEff();
        effs.push(e);
        what = `create e${e.id}`;
      }
      check(op, what);
    }
    for (const e of effs) {
      if (!e.disposed) {
        e.disposed = true;
        e.dispose();
      }
    }
    for (const c of comps) (c as unknown as { dispose(): void }).dispose();
    for (const s of sigs) {
      if (subs(s) > 0) {
        violations.push(
          `seed ${rseed}: ${
            subs(s)
          } subscriber(s) left on ${s._name} after full teardown`,
        );
      }
    }
  }
  assert(
    violations.length === 0,
    `${violations.length} violation(s) (AIO_FUZZ_SEED=${seed}):\n  ${
      violations.slice(0, 8).join("\n  ")
    }`,
  );
});
