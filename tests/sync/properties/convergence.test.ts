// tests/sync/properties/convergence.test.ts
import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { mergeField } from "../../../src/sync/merge.ts";
import type { HLC } from "../../../src/sync/types.ts";

/** Generate a random HLC for property testing */
function randomHLC(nodeId: string): HLC {
  return [
    Math.floor(Math.random() * 100000),
    Math.floor(Math.random() * 100),
    nodeId,
  ];
}

describe("CRDT Properties", () => {
  describe("LWW commutativity", () => {
    it("merge(a,b) produces same winner as merge(b,a)", () => {
      for (let i = 0; i < 100; i++) {
        const hlcA = randomHLC("a");
        const hlcB = randomHLC("b");
        const valA = `val-${Math.random()}`;
        const valB = `val-${Math.random()}`;

        const ab = mergeField("lww", valA, hlcA, valB, hlcB);
        const ba = mergeField("lww", valB, hlcB, valA, hlcA);
        assertEquals(ab.value, ba.value, `Commutativity failed at i=${i}`);
      }
    });
  });

  describe("Counter commutativity", () => {
    it("merge(a,b) === merge(b,a) for counters", () => {
      for (let i = 0; i < 100; i++) {
        const base = Math.floor(Math.random() * 100);
        const a = base + Math.floor(Math.random() * 50);
        const b = base + Math.floor(Math.random() * 50);
        const hlcA = randomHLC("a");
        const hlcB = randomHLC("b");

        const ab = mergeField("counter", a, hlcA, b, hlcB, base);
        const ba = mergeField("counter", b, hlcB, a, hlcA, base);
        assertEquals(ab.value, ba.value);
      }
    });
  });

  describe("Counter associativity", () => {
    it("sequential pairwise merges converge regardless of order", () => {
      // Counter merge: result = base + (a - base) + (b - base)
      // Associativity for counters means: merging 3 deltas in any order converges.
      // We verify: fold-left [a,b,c] === fold-left [c,a,b] === fold-left [b,c,a]
      for (let i = 0; i < 50; i++) {
        const base = 0;
        const deltas = [
          Math.floor(Math.random() * 50),
          Math.floor(Math.random() * 50),
          Math.floor(Math.random() * 50),
        ];

        // All permutations of 3 deltas should converge to same value
        const perms = [
          [deltas[0]!, deltas[1]!, deltas[2]!],
          [deltas[1]!, deltas[2]!, deltas[0]!],
          [deltas[2]!, deltas[0]!, deltas[1]!],
        ];

        const results = perms.map((perm) => {
          let acc = base;
          for (const d of perm) {
            acc = mergeField(
              "counter",
              acc,
              randomHLC("acc"),
              base + d,
              randomHLC("d"),
              base,
            ).value as number;
          }
          return acc;
        });

        assertEquals(
          results[0],
          results[1],
          `Perm convergence failed at i=${i}`,
        );
        assertEquals(
          results[1],
          results[2],
          `Perm convergence failed at i=${i}`,
        );
      }
    });
  });

  describe("LWW idempotency", () => {
    it("merge(a,a) === a", () => {
      for (let i = 0; i < 100; i++) {
        const hlc = randomHLC("a");
        const val = `val-${Math.random()}`;

        const result = mergeField("lww", val, hlc, val, hlc);
        assertEquals(result.value, val);
        assertEquals(result.conflict, false);
      }
    });
  });

  describe("Set-add commutativity", () => {
    it("union is order-independent", () => {
      for (let i = 0; i < 50; i++) {
        const a = [{ id: "1" }, { id: "2" }];
        const b = [{ id: "2" }, { id: "3" }];
        const hlcA = randomHLC("a");
        const hlcB = randomHLC("b");

        const ab = mergeField("set-add", a, hlcA, b, hlcB);
        const ba = mergeField("set-add", b, hlcB, a, hlcA);

        const idsAB = (ab.value as { id: string }[]).map((x) => x.id).sort();
        const idsBA = (ba.value as { id: string }[]).map((x) => x.id).sort();
        assertEquals(idsAB, idsBA);
      }
    });
  });

  describe("Set-add idempotency", () => {
    it("adding same items twice → same set", () => {
      const items = [{ id: "1" }, { id: "2" }];
      const hlc = randomHLC("a");
      const result = mergeField("set-add", items, hlc, items, hlc);
      assertEquals((result.value as unknown[]).length, 2);
    });
  });

  describe("Convergence stress test", () => {
    it("N clients with random counter ops all converge via pairwise merge", () => {
      const N = 10;
      const base = 0;
      const deltas: number[] = [];

      for (let i = 0; i < N; i++) {
        deltas.push(Math.floor(Math.random() * 100));
      }

      // Fold in original order
      let merged = base;
      for (const d of deltas) {
        merged = (mergeField(
          "counter",
          base + d,
          randomHLC("c"),
          merged,
          randomHLC("s"),
          base,
        ).value) as number;
      }
      // Fold in reversed order — must converge to same result
      let mergedRev = base;
      for (const d of deltas.slice().reverse()) {
        mergedRev = (mergeField(
          "counter",
          base + d,
          randomHLC("c"),
          mergedRev,
          randomHLC("s"),
          base,
        ).value) as number;
      }
      assertEquals(merged, mergedRev);
    });
  });
});
