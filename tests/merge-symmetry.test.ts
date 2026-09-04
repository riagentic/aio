// The property `text` has, extended to every other strategy that claims to be
// conflict-free.
//
// CONVERGENCE — each peer runs the SAME function with its own side as `local`,
// so `mergeField(s, x, hx, y, hy, base)` and `mergeField(s, y, hy, x, hx,
// base)` must agree. Otherwise the two have silently forked, and every later
// merge is against a base that never existed.
//
// `text` carried a 3,000-case fuzz for exactly this; `set-add`, `set-remove`
// and `lww-per-key` carried none — and all three failed it, because the merge
// was built by iterating LOCAL first and then REMOTE, which is a different
// order on each side of the same merge. `docs/persistence/crdt.md` lists all of
// them as "Conflict-free: Yes".
import { assertEquals } from "@std/assert";
import { mergeField } from "../src/sync/merge.ts";
import type { HLC } from "../src/sync/types.ts";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const ids = ["x", "y", "z", "w", "v"];

function pickItems(r: () => number, base: { id: string; n: number }[]) {
  const out: { id: string; n: number }[] = [];
  for (const item of base) if (r() < 0.7) out.push({ ...item });
  for (const id of ids) {
    if (!out.some((i) => i.id === id) && r() < 0.3) {
      out.push({ id, n: Math.floor(r() * 3) });
    }
  }
  // Order is deliberately shuffled: a peer's own array order is its own.
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

Deno.test("PROPERTY: set-add and set-remove converge on both peers", () => {
  const CASES = 600;
  for (let c = 0; c < CASES; c++) {
    const r = rng(0xC0FFEE + c);
    const base = ids.filter(() => r() < 0.6).map((id) => ({
      id,
      n: Math.floor(r() * 3),
    }));
    const a = pickItems(r, base);
    const b = pickItems(r, base);
    // Distinct HLCs (compareHLC tie-breaks on the node id, so it is total).
    const ha: HLC = [1000 + Math.floor(r() * 100), 0, "a"];
    const hb: HLC = [1000 + Math.floor(r() * 100), 0, "b"];

    for (const strategy of ["set-add", "set-remove"] as const) {
      const peerA = mergeField(strategy, a, ha, b, hb, base);
      const peerB = mergeField(strategy, b, hb, a, ha, base);
      assertEquals(
        JSON.stringify(peerA.value),
        JSON.stringify(peerB.value),
        `${strategy} FORKED at case ${c}\n  base=${JSON.stringify(base)}\n` +
          `  a=${JSON.stringify(a)}\n  b=${JSON.stringify(b)}\n` +
          `  peerA=${JSON.stringify(peerA.value)}\n` +
          `  peerB=${JSON.stringify(peerB.value)}`,
      );
      assertEquals(
        peerA.conflict,
        peerB.conflict,
        `${strategy}: the two peers disagree about whether this WAS a conflict`,
      );
    }
  }
});

Deno.test("PROPERTY: lww-per-key converges on both peers, key order included", () => {
  const keys = ["a", "b", "c", "d"];
  for (let c = 0; c < 600; c++) {
    const r = rng(0xBEEF + c);
    const mk = () => {
      const o: Record<string, number> = {};
      // Insertion order varies per side — that is the point.
      for (const k of [...keys].sort(() => r() - 0.5)) {
        if (r() < 0.6) o[k] = Math.floor(r() * 5);
      }
      return o;
    };
    const a = mk(), b = mk();
    const ha: HLC = [1000 + Math.floor(r() * 100), 0, "a"];
    const hb: HLC = [1000 + Math.floor(r() * 100), 0, "b"];
    const peerA = mergeField("lww-per-key", a, ha, b, hb);
    const peerB = mergeField("lww-per-key", b, hb, a, ha);
    assertEquals(
      JSON.stringify(peerA.value),
      JSON.stringify(peerB.value),
      `lww-per-key FORKED at case ${c}: ${JSON.stringify(a)} / ${
        JSON.stringify(b)
      }`,
    );
  }
});

Deno.test("PROPERTY: counter converges on both peers", () => {
  for (let c = 0; c < 200; c++) {
    const r = rng(0xFACE + c);
    const base = Math.floor(r() * 10);
    const a = base + Math.floor(r() * 5);
    const b = base + Math.floor(r() * 5);
    const ha: HLC = [1000 + Math.floor(r() * 100), 0, "a"];
    const hb: HLC = [1000 + Math.floor(r() * 100), 0, "b"];
    assertEquals(
      mergeField("counter", a, ha, b, hb, base).value,
      mergeField("counter", b, hb, a, ha, base).value,
    );
  }
});
