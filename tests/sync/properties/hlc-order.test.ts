// tests/sync/properties/hlc-order.test.ts — what the hybrid logical clock
// promises, as seeded properties over adversarial wall clocks.
//
// `tests/sync/hlc.test.ts` pins single examples. These are the laws every op
// order in the sync layer leans on (the server orders ops, snapshots and
// tombstones by HLC; a clock that can issue the same HLC twice, or order two
// HLCs both ways round, makes "which write won" undecidable):
//
//  1. tick is strictly monotonic however the wall clock moves — forward,
//     stalled, or BACKWARD (NTP step, suspend/resume).
//  2. receive respects causality: after a peer's HLC is taken in, the next
//     local tick is later than it. A peer beyond `maxDrift`, or with a counter
//     no real clock reaches, is ignored — it cannot drag the clock forward.
//  3. compareHLC is a total order: reflexive, antisymmetric, transitive, and 0
//     only for the identical triple. Ties on (physical, counter) break on the
//     node id — so two nodes can never issue equal HLCs.
import { assert, assertEquals } from "@std/assert";
import {
  compareHLC,
  createHLC,
  MAX_HLC_COUNTER,
} from "../../../src/sync/hlc.ts";
import type { HLC } from "../../../src/sync/types.ts";
import { forAllSeeds, type Rng } from "./_prop.ts";

const FILE = "tests/sync/properties/hlc-order.test.ts";
const DRIFT = 60_000;
const show = (h: HLC) => JSON.stringify(h);

/** A wall clock that jumps forward, stalls, and steps backward. */
function wildClock(rng: Rng, start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    step() {
      const r = rng();
      if (r < 0.35) return; // stall — same millisecond
      if (r < 0.6) t -= 1 + rng.int(5_000); // backward step
      else t += 1 + rng.int(r < 0.9 ? 3 : 20_000);
    },
  };
}

Deno.test("hlc property: tick is strictly monotonic under a wall clock that stalls and steps backward", async () => {
  await forAllSeeds(FILE, "hlc tick monotonic", 200, (rng) => {
    const wall = wildClock(rng);
    const clock = createHLC("n", wall.now, DRIFT);
    let prev = clock.tick();
    let maxWall = wall.now();
    for (let i = 0; i < 300; i++) {
      wall.step();
      maxWall = Math.max(maxWall, wall.now());
      const next = i % 2 ? clock.tick() : clock.now();
      assert(
        compareHLC(next, prev) > 0,
        `step ${i}: ${show(next)} is not after ${show(prev)}`,
      );
      // The physical part tracks the highest wall time seen, never ahead of it
      // (no remote input here) and never behind it.
      assertEquals(next[0], maxWall, `step ${i}: physical`);
      prev = next;
    }
  });
});

Deno.test("hlc property: receive respects causality across peers; drifted and absurd remotes are ignored", async () => {
  await forAllSeeds(FILE, "hlc receive causality", 150, (rng) => {
    const names = ["a", "b", "c"];
    const walls = names.map((_, i) => wildClock(rng, 1_000_000 + i * 7));
    const clocks = names.map((n, i) => createHLC(n, walls[i]!.now, DRIFT));
    const last: (HLC | null)[] = names.map(() => null);
    const inFlight: { to: number; h: HLC }[] = [];
    const seen = new Set<string>();
    let causal = 0, hostiles = 0;

    const issue = (i: number): HLC => {
      const h = clocks[i]!.tick();
      const prev = last[i];
      assert(!prev || compareHLC(h, prev) > 0, `${names[i]} regressed`);
      // Distinct nodes never issue equal HLCs — the node id breaks the tie.
      assert(!seen.has(show(h)), `HLC ${show(h)} issued twice`);
      seen.add(show(h));
      last[i] = h;
      return h;
    };

    for (let step = 0; step < 400; step++) {
      const i = rng.int(names.length);
      walls[i]!.step();
      const r = rng();
      if (r < 0.4) {
        // Send: a message carries the sender's fresh HLC to a random peer.
        const h = issue(i);
        inFlight.push({ to: (i + 1 + rng.int(names.length - 1)) % 3, h });
      } else if (r < 0.8 && inFlight.length) {
        // Deliver any in-flight message (arbitrary order), then act.
        const [m] = inFlight.splice(rng.int(inFlight.length), 1);
        const c = clocks[m!.to]!;
        const accepted = !c.isDriftExceeded(m!.h);
        c.receive(m!.h);
        const after = issue(m!.to);
        if (accepted) {
          causal++;
          assert(
            compareHLC(after, m!.h) > 0,
            `${names[m!.to]} ticked ${show(after)} after receiving ` +
              `${show(m!.h)} — causality broken`,
          );
        }
      } else {
        // A hostile remote: far future (beyond drift) or an absurd counter.
        const to = rng.int(names.length);
        const before = issue(to);
        const hostile: HLC = rng.chance(0.5)
          ? [walls[to]!.now() + DRIFT + 1 + rng.int(1e9), 0, "evil"]
          : [before[0], MAX_HLC_COUNTER + 1 + rng.int(1e6), "evil"];
        hostiles++;
        clocks[to]!.receive(hostile);
        const after = issue(to);
        assert(
          after[0] <= Math.max(before[0], walls[to]!.now()) &&
            after[1] <= before[1] + 1,
          `${names[to]} followed a hostile remote ${show(hostile)}: ` +
            `${show(before)} → ${show(after)}`,
        );
      }
    }
    // Never vacuous: both branches actually ran in this case.
    assert(
      causal > 10 && hostiles > 10,
      `causal=${causal} hostile=${hostiles}`,
    );
  });
});

Deno.test("hlc property: compareHLC is a total order with a node-id tie-break", async () => {
  await forAllSeeds(FILE, "hlc total order", 200, (rng) => {
    // Small domains so ties on physical AND counter are common.
    const gen = (): HLC => [
      1000 + rng.int(3),
      rng.int(3),
      rng.pick(["a", "b", "c", "aa", "B"]),
    ];
    const xs = Array.from({ length: 24 }, gen);
    assertEquals(xs.length, 24, "the sample is never empty");
    const sign = (n: number) => Math.sign(n);
    for (const a of xs) {
      assertEquals(compareHLC(a, [...a] as HLC), 0, `reflexive ${show(a)}`);
      for (const b of xs) {
        const ab = compareHLC(a, b);
        assertEquals(sign(ab), -sign(compareHLC(b, a)), "antisymmetric");
        assertEquals(
          ab === 0,
          a[0] === b[0] && a[1] === b[1] && a[2] === b[2],
          `0 iff identical: ${show(a)} vs ${show(b)}`,
        );
        if (a[0] === b[0] && a[1] === b[1] && a[2] !== b[2]) {
          assertEquals(sign(ab), a[2] < b[2] ? -1 : 1, "node-id tie-break");
        }
        for (const c of xs) {
          if (ab <= 0 && compareHLC(b, c) <= 0) {
            assert(
              compareHLC(a, c) <= 0,
              `not transitive: ${show(a)} ≤ ${show(b)} ≤ ${show(c)}`,
            );
          }
        }
      }
    }
    // Lexicographic on (physical, counter, node) — the documented order.
    const sorted = [...xs].sort(compareHLC);
    const lex = [...xs].sort((a, b) =>
      a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0)
    );
    assertEquals(sorted, lex);
  });
});
