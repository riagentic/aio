// The timeline diff, as a ROUND TRIP.
//
// `diffState` is always on: it runs on every committed dispatch and it is the
// only description of what an action changed that `am timeline` — or anyone
// reading a bug report — ever sees. A diff that is merely "usually right" is
// the shape of bug this whole area keeps producing: it produces a plausible,
// wrong answer and people act on it.
//
// So the property is stated as an inverse, not as examples:
//
//   1. COMPLETENESS — if `prev` and `next` differ deeply, the diff is non-empty.
//      (Silence for a real change is the exact failure mode that let a changed
//      Date go unreported.)
//   2. SUFFICIENCY  — applying the diff's leaves to `prev` reconstructs `next`.
//      A diff you cannot replay is a diff that did not describe the change.
//   3. SOUNDNESS    — deep-equal states produce no diff at all.
//
// States are generated THROUGH Immer, so the structural sharing the walker
// prunes on (`a === b`) is real rather than simulated — a fuzzer over
// hand-built literals would exercise a walker that never takes its fast path.
//
// SCOPE, deliberately: plain JSON — objects, arrays, strings, numbers,
// booleans, null. That is not a convenience, it is the shape `persist-guard`
// FORCES for any persisted cell: Date, Map, Set and sparse arrays are refused
// there, with a named reason. So the contract worth pinning is the JSON one,
// and the refusal is asserted here rather than pretended around (last test).

import { assert, assertEquals } from "@std/assert";
import { produce } from "immer";
import { diffState } from "../src/server/timeline.ts";
import { stringifyWithIssues } from "../src/server/persist-guard.ts";
import { fuzzEnvInt } from "./fuzz-seed.ts";

// The seed is FIXED by default so CI explores the same states every run; a
// sweep widens it without making the default nondeterministic:
//
//     for s in 1 7 31 99 12345; do FUZZ_SEED=$s deno test -A \
//       tests/timeline-diff-differential.test.ts; done
const SEED = fuzzEnvInt("FUZZ_SEED", 0x71e11e0d) & 0x7fffffff;
const ROUNDS = fuzzEnvInt("FUZZ_ROUNDS", 300, 1);

// deno-lint-ignore no-explicit-any
type Any = any;

function rng(seed: number) {
  let s = seed || 1;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

const MAX_DEPTH = 4; // below the walker's MAX_DEPTH of 12 — truncation is its
// own contract and is covered by tests/timeline.test.ts

/** A random plain-JSON value. Dense arrays only — a hole is `undefined`, which
 *  JSON cannot represent and `persist-guard` refuses. */
function genValue(rnd: () => number, depth: number): unknown {
  const r = rnd();
  if (depth >= MAX_DEPTH || r < 0.34) {
    const k = rnd();
    if (k < 0.3) return Math.floor(rnd() * 1000);
    if (k < 0.5) return `s${Math.floor(rnd() * 100)}`;
    if (k < 0.65) return rnd() < 0.5;
    if (k < 0.75) return null;
    // Values that LOOK like other types — the ambiguity a diff must survive.
    if (k < 0.85) return String(Math.floor(rnd() * 10));
    return rnd() < 0.5 ? "null" : "true";
  }
  if (r < 0.67) {
    const n = Math.floor(rnd() * 4);
    return Array.from({ length: n }, () => genValue(rnd, depth + 1));
  }
  const n = Math.floor(rnd() * 4);
  const o: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) o[`k${i}`] = genValue(rnd, depth + 1);
  return o;
}

function genState(rnd: () => number): Record<string, unknown> {
  const n = 1 + Math.floor(rnd() * 3);
  const s: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) s[`c${i}`] = genValue(rnd, 1);
  return s;
}

/** Mutate a random path of `base` THROUGH Immer, so everything untouched stays
 *  reference-equal — the structural sharing `diffState` prunes on. */
function mutate(
  base: Record<string, unknown>,
  rnd: () => number,
): Record<string, unknown> {
  return produce(base, (d: Any) => {
    let node: Any = d;
    const keys = (): (string | number)[] =>
      Array.isArray(node)
        ? node.map((_: unknown, i: number) => i)
        : Object.keys(node ?? {});
    // Walk down a random spine.
    for (let hop = 0; hop < 3; hop++) {
      const ks = keys();
      if (ks.length === 0 || rnd() < 0.35) break;
      const k = ks[Math.floor(rnd() * ks.length)]!;
      const child = node[k];
      if (child === null || typeof child !== "object") {
        // Replace a leaf — including with a DIFFERENT type.
        node[k] = genValue(rnd, MAX_DEPTH - 1);
        return;
      }
      node = child;
    }
    const ks = keys();
    const r = rnd();
    if (Array.isArray(node)) {
      if (r < 0.4 && ks.length > 0) {
        node[
          ks[Math.floor(rnd() * ks.length)] as number
        ] = genValue(rnd, 3);
      } else if (r < 0.7) node.push(genValue(rnd, 3));
      else if (ks.length > 0) node.pop();
      else node.push(genValue(rnd, 3));
      return;
    }
    if (r < 0.45 && ks.length > 0) {
      node[ks[Math.floor(rnd() * ks.length)] as string] = genValue(rnd, 3);
    } else if (r < 0.8) {
      node[`n${Math.floor(rnd() * 5)}`] = genValue(rnd, 3);
    } else if (ks.length > 0) {
      delete node[ks[Math.floor(rnd() * ks.length)] as string];
    } else {
      node.added = genValue(rnd, 3);
    }
  }) as Record<string, unknown>;
}

const deepEq = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Apply the diff's leaves to a deep clone of `prev`. If the diff described the
 *  change, the result IS `next`. */
function applyDiff(
  prev: Record<string, unknown>,
  diff: { path: string; before: unknown; after: unknown }[],
): unknown {
  const out = structuredClone(prev) as Any;
  for (const d of diff) {
    const parts = d.path === "" ? [] : d.path.split(".");
    if (parts.length === 0) return d.after;
    let node: Any = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i]!;
      if (node[k] === null || typeof node[k] !== "object") {
        node[k] = /^\d+$/.test(parts[i + 1]!) ? [] : {};
      }
      node = node[k];
    }
    const last = parts[parts.length - 1]!;
    if (d.after === undefined) {
      if (Array.isArray(node)) {
        node.length = Math.min(node.length, Number(last));
      } else delete node[last];
    } else node[last] = d.after;
  }
  return out;
}

Deno.test("diff round-trip: the diff is complete, sufficient and sound", () => {
  const rnd = rng(SEED);
  let checked = 0;
  for (let round = 0; round < ROUNDS; round++) {
    const prev = produce(genState(rnd), () => {}) as Record<string, unknown>;
    const next = mutate(prev, rnd);
    const diff = diffState(prev, next);
    const repro = () =>
      `FUZZ_SEED=${SEED} round ${round}\nprev=${JSON.stringify(prev)}\n` +
      `next=${JSON.stringify(next)}\ndiff=${JSON.stringify(diff)}`;

    assert(
      !diff.some((d) => d.path === "…"),
      `the generator must stay under the truncation cap:\n${repro()}`,
    );

    if (deepEq(prev, next)) {
      // SOUNDNESS. (Immer returns the SAME object when a producer changes
      // nothing, so this is usually the `a === b` fast path — but a mutation
      // that writes back an equal value must not invent a change either.)
      assertEquals(diff.length, 0, `a no-op produced a diff:\n${repro()}`);
      continue;
    }

    // COMPLETENESS — silence for a real change is the failure mode.
    assert(
      diff.length > 0,
      `a deep-unequal pair produced NO diff:\n${repro()}`,
    );

    // SUFFICIENCY — the diff replays to `next`.
    const rebuilt = applyDiff(prev, diff);
    assert(
      deepEq(rebuilt, next),
      `applying the diff to prev did not reconstruct next:\n${repro()}\n` +
        `rebuilt=${JSON.stringify(rebuilt)}`,
    );
    checked++;
  }
  assert(
    checked > ROUNDS / 4,
    `only ${checked}/${ROUNDS} rounds produced a real change — the generator ` +
      `stopped exercising the property`,
  );
});

Deno.test("diff round-trip: an unchanged state is reference-equal and diffs to nothing", () => {
  const rnd = rng(SEED ^ 0x5eed);
  for (let round = 0; round < Math.min(ROUNDS, 60); round++) {
    const s = produce(genState(rnd), () => {}) as Record<string, unknown>;
    // Immer returns the identical object for a producer that writes nothing.
    const same = produce(s, () => {}) as Record<string, unknown>;
    assertEquals(same, s);
    assertEquals(diffState(s, same), []);
  }
});

// ─── The classes this contract deliberately does NOT cover ─────────────────

Deno.test("diff round-trip: Date/Map/Set and sparse arrays are REFUSED on the persist path", () => {
  // The fuzzer generates plain JSON because that is what a persisted cell is
  // allowed to hold. Asserting the refusal is the honest way to scope the
  // contract — the alternative is a fuzzer that quietly pretends the diff
  // round-trips types the framework never lets reach it.
  const cases: [string, unknown][] = [
    ["Date", { at: new Date(0) }],
    ["Map", { m: new Map([["a", 1]]) }],
    ["Set", { z: new Set([1]) }],
    ["undefined", { u: undefined }],
  ];
  for (const [what, state] of cases) {
    const { issues } = stringifyWithIssues(state);
    assert(
      issues.some((i) => i.kind === what),
      `persist-guard must refuse ${what} — the diff contract is scoped to ` +
        `what a persisted cell may hold`,
    );
  }
  // A sparse array's hole is `undefined`, refused for the same reason.
  const sparse: unknown[] = [1];
  sparse[3] = 4;
  const { issues } = stringifyWithIssues({ arr: sparse });
  assert(
    issues.some((i) => i.kind === "undefined"),
    "a sparse array's holes must be refused",
  );

  // …and the diff still REPORTS a change in those types rather than going
  // silent — a non-persisted field (`persist: { exclude: [...] }`) may hold a
  // Date, and "no diff" would be a lie there.
  const d = diffState({ s: { at: new Date(0) } }, { s: { at: new Date(1) } });
  assertEquals(d.length, 1);
  assertEquals(d[0]!.path, "s.at");
});
