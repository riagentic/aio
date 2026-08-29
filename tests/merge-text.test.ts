// The `text` merge strategy — and the two properties that make it safe.
//
// Every string field used to be `lww`: two people editing the same note, one
// of them loses the whole thing, silently. Correct LWW, wrong answer for
// prose. `text` is a diff3 against the agreed base: disjoint edits both
// survive, overlapping ones are a REAL conflict resolved by HLC and reported.
//
// The two properties, both fuzzed below, are what a merge has to have:
//   CONVERGENCE — both peers compute the SAME string, or they have silently
//                 forked and every later merge is against a base that never
//                 existed.
//   NO INVENTION — every token in the output came from the base or from one
//                 of the two sides. A merge that can invent is worse than one
//                 that loses, because nobody can tell.
import { assert, assertEquals } from "@std/assert";
import {
  hunksOf,
  MAX_TOKENS,
  mergeText3,
  tokenize,
} from "../src/sync/merge-text.ts";
import { mergeField } from "../src/sync/merge.ts";
import type { HLC } from "../src/sync/types.ts";

const A: HLC = [1000, 0, "a"]; // earlier
const B: HLC = [2000, 0, "b"]; // later — wins a conflict

const merge = (base: string, local: string, remote: string) =>
  mergeText3(base, local, A, remote, B);

// ── The case the whole thing exists for ──

Deno.test("text: two people editing different paragraphs both keep their edit", () => {
  const base = "intro\nbody\noutro\n";
  const local = "INTRO EDITED\nbody\noutro\n";
  const remote = "intro\nbody\nOUTRO EDITED\n";
  const r = merge(base, local, remote);
  assertEquals(r.value, "INTRO EDITED\nbody\nOUTRO EDITED\n");
  assertEquals(r.conflict, false, "disjoint edits are not a conflict");
});

Deno.test("text: both appending, in different places", () => {
  const base = "a\nb\n";
  const r = merge(base, "start\na\nb\n", "a\nb\nend\n");
  assertEquals(r.value, "start\na\nb\nend\n");
  assertEquals(r.conflict, false);
});

Deno.test("text: a single-line field merges character-wise", () => {
  // A title has no line structure, so lines would degrade to whole-value LWW
  // and one of these two fixes would vanish.
  const r = merge("Frist Post", "First Post", "Frist Post!");
  assertEquals(r.value, "First Post!");
  assertEquals(r.conflict, false);
});

Deno.test("text: one side did not move — the other's text wins, no conflict", () => {
  assertEquals(merge("same", "same", "changed"), {
    value: "changed",
    conflict: false,
  });
  assertEquals(merge("same", "changed", "same"), {
    value: "changed",
    conflict: false,
  });
});

Deno.test("text: identical edits on both sides are not a conflict", () => {
  assertEquals(merge("a", "b", "b"), { value: "b", conflict: false });
});

// ── The case it must NOT paper over ──

Deno.test("text: the same paragraph, rewritten twice, is a real conflict", () => {
  const base = "one\ntwo\nthree\n";
  const r = merge(base, "one\nLOCAL\nthree\n", "one\nREMOTE\nthree\n");
  assert(r.conflict, "two rewrites of one paragraph cannot both be right");
  assertEquals(
    r.value,
    "one\nREMOTE\nthree\n",
    "the later HLC wins — exactly what `lww` would have done, but SAID",
  );
});

Deno.test("text: a conflict never produces a mangled hybrid", () => {
  const r = merge("hello", "hello world", "hello there");
  assert(r.conflict);
  assert(
    r.value === "hello world" || r.value === "hello there",
    `a conflict must resolve to ONE side's text, got ${
      JSON.stringify(r.value)
    }`,
  );
});

Deno.test("text: two insertions at the same offset conflict rather than interleave", () => {
  const r = merge("ab", "aXb", "aYb");
  assert(r.conflict);
  assert(r.value === "aXb" || r.value === "aYb", r.value);
});

Deno.test("text: an insertion beside a replacement is NOT a conflict", () => {
  // The most ordinary merge there is: one peer appends, another rewrites what
  // follows. Calling it a conflict would refuse the common case.
  const base = "a\nb\n";
  const r = merge(base, "a\nb\nnew\n", "a\nB CHANGED\n");
  assertEquals(r.conflict, false);
  assertEquals(r.value, "a\nB CHANGED\nnew\n");
});

Deno.test("text: deletions merge with edits elsewhere", () => {
  const base = "one\ntwo\nthree\n";
  const r = merge(base, "one\nthree\n", "one\ntwo\nTHREE\n");
  assertEquals(r.conflict, false);
  assertEquals(r.value, "one\nTHREE\n");
});

// ── Shape refusals, matching every sibling strategy ──

Deno.test("text: a non-string is refused, not stringified", () => {
  // Coercing here writes "[object Object]" into cell state — the silent
  // coercion this framework refuses everywhere else.
  for (const bad of [42, { a: 1 }, [1, 2], true]) {
    let threw = false;
    try {
      mergeField("text", bad, A, "ok", B, "");
    } catch (e) {
      threw = true;
      assert(String((e as Error).message).includes("string"));
    }
    assert(threw, `${JSON.stringify(bad)} must be refused`);
  }
});

Deno.test("text: null/undefined is LWW's question, and it answers it", () => {
  // A cleared field is not a text edit. Delegated rather than guessed at.
  assertEquals(mergeField("text", null, A, "x", B, "base").value, "x");
  assertEquals(mergeField("text", "x", B, null, A, "base").value, "x");
});

Deno.test("text: an absent base reads as empty, and both sides insert", () => {
  const r = mergeField("text", "aaa", A, "aaa", B, undefined);
  assertEquals(r.value, "aaa");
  assertEquals(r.conflict, false);
});

// ── Bounds ──

Deno.test("text: an enormous field falls back to LWW instead of stalling", () => {
  const base = "x".repeat(MAX_TOKENS + 50);
  const r = mergeText3(base, base + "L", A, base + "R", B);
  assert(r.conflict, "the fallback is reported, never silent");
  assertEquals(r.value, base + "R", "…and it is LWW, which is what lww does");
});

Deno.test("text: tokenize round-trips exactly, newline or not", () => {
  for (
    const s of ["", "a", "a\n", "a\nb", "a\nb\n", "\n", "\n\n", "line\n\nline"]
  ) {
    assertEquals(tokenize(s).join(""), s, JSON.stringify(s));
  }
});

Deno.test("text: hunksOf finds nothing when nothing changed", () => {
  assertEquals(hunksOf(tokenize("abc"), tokenize("abc")), []);
});

// ── The two properties, fuzzed ──

/** A deterministic PRNG — a fuzz that cannot be replayed is a fuzz that
 *  cannot be debugged. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Apply `n` random edits to `text`. */
function edit(text: string, r: () => number, n: number): string {
  let out = text;
  for (let i = 0; i < n; i++) {
    const at = Math.floor(r() * (out.length + 1));
    const kind = r();
    if (kind < 0.4) {
      out = out.slice(0, at) + "XYZ"[Math.floor(r() * 3)] + out.slice(at);
    } else if (kind < 0.7 && out.length > 0) {
      const end = Math.min(out.length, at + 1 + Math.floor(r() * 3));
      out = out.slice(0, at) + out.slice(end);
    } else {
      out = out.slice(0, at) + "\n" + out.slice(at);
    }
  }
  return out;
}

Deno.test("text: PROPERTY — both peers compute the same merge", () => {
  // The one property a merge cannot be without. Each peer runs the same
  // function with its own side as `local`, so `merge(base, x, y)` and
  // `merge(base, y, x)` MUST agree — otherwise the two have silently forked
  // and every later merge is against a base that never existed.
  const r = rng(20260829);
  for (let i = 0; i < 3000; i++) {
    const base = edit("alpha\nbeta\ngamma\n", r, 1 + Math.floor(r() * 4));
    const local = edit(base, r, 1 + Math.floor(r() * 3));
    const remote = edit(base, r, 1 + Math.floor(r() * 3));
    // Peer A holds `local`; peer B holds `remote`. Same two HLCs either way.
    const fromA = mergeText3(base, local, A, remote, B);
    const fromB = mergeText3(base, remote, B, local, A);
    assertEquals(
      fromA.value,
      fromB.value,
      `case ${i} diverged\n base=${JSON.stringify(base)}\n local=${
        JSON.stringify(local)
      }\n remote=${JSON.stringify(remote)}\n A=${
        JSON.stringify(fromA.value)
      }\n B=${JSON.stringify(fromB.value)}`,
    );
    assertEquals(fromA.conflict, fromB.conflict, `case ${i} conflict differs`);
  }
});

Deno.test("text: PROPERTY — the merge never invents a character", () => {
  // Every token in the output came from the base or from one of the two
  // sides. A merge that can invent is worse than one that loses: nobody can
  // tell it happened.
  const r = rng(4242);
  let total = 0;
  for (let i = 0; i < 2000; i++) {
    const base = edit("one\ntwo\nthree\n", r, 1 + Math.floor(r() * 3));
    const local = edit(base, r, 1 + Math.floor(r() * 3));
    const remote = edit(base, r, 1 + Math.floor(r() * 3));
    const out = mergeText3(base, local, A, remote, B).value;
    const allowed = new Set([...base, ...local, ...remote]);
    let checked = 0;
    for (const ch of out) {
      assert(
        allowed.has(ch),
        `case ${i} invented ${JSON.stringify(ch)}\n out=${
          JSON.stringify(out)
        }\n base=${JSON.stringify(base)}`,
      );
      checked++;
    }
    assertEquals(
      checked,
      [...out].length,
      "every character must be examined — an empty output would make the " +
        "loop above assert nothing at all",
    );
    total += checked;
  }
  assert(
    total > 10_000,
    `only ${total} characters examined across 2000 cases — the generator ` +
      `stopped producing text and this property proved nothing`,
  );
});

Deno.test("text: PROPERTY — a merge with an unchanged side is that side, exactly", () => {
  const r = rng(99);
  for (let i = 0; i < 1000; i++) {
    const base = edit("a\nb\nc\n", r, 1 + Math.floor(r() * 4));
    const other = edit(base, r, 1 + Math.floor(r() * 4));
    assertEquals(mergeText3(base, base, A, other, B).value, other);
    assertEquals(mergeText3(base, other, A, base, B).value, other);
  }
});
