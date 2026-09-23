// tests/sync/properties/_prop.ts — the one seeded-property runner the
// `test:sync` lane's property files share.
//
// Every case gets its own seed derived from the base, and a failure rethrows
// with the exact line that replays THAT case alone — a property that fails
// without telling you how to see it again is a flake report, not a finding.
// The base is fixed by default (CI reproduces from its own commit) and the
// knobs go through `fuzzEnvInt`, which throws on an unreadable value rather
// than silently running a different program.
import { fuzzEnvInt } from "../../fuzz-seed.ts";

/** mulberry32 — tiny seeded PRNG, good enough for schedules. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seeded source with the helpers every generator here needs. */
export interface Rng {
  (): number;
  int(n: number): number;
  pick<T>(xs: readonly T[]): T;
  chance(p: number): boolean;
}

export function rngOf(seed: number): Rng {
  const r = mulberry32(seed) as Rng;
  r.int = (n) => Math.floor(r() * n);
  r.pick = (xs) => xs[r.int(xs.length)]!;
  r.chance = (p) => r() < p;
  return r;
}

/** Run `cases` seeded cases of `prop`. `SYNC_PROP_SEED=<n>` replays exactly
 *  one case (the one a failure names); `SYNC_PROP_CASES` widens a sweep. */
export async function forAllSeeds(
  file: string,
  name: string,
  cases: number,
  prop: (rng: Rng, seed: number) => void | Promise<void>,
  base = 0x51c0de,
): Promise<number> {
  const replay = Deno.env.get("SYNC_PROP_SEED") !== undefined
    ? fuzzEnvInt("SYNC_PROP_SEED", 0)
    : undefined;
  const n = fuzzEnvInt("SYNC_PROP_CASES", cases, 1);
  const seeds = replay !== undefined
    ? [replay >>> 0]
    : Array.from({ length: n }, (_, i) => (base + i * 0x9E3779B9) >>> 0);
  for (const seed of seeds) {
    try {
      await prop(rngOf(seed), seed);
    } catch (e) {
      const line = `SYNC_PROP_SEED=${seed} deno test -A ${file} ` +
        `--filter "${name}"`;
      console.error(`[${name}] FAILED — replay with: ${line}`);
      throw new Error(`${name} — replay: ${line}\n${(e as Error).message}`, {
        cause: e,
      });
    }
  }
  return seeds.length;
}
