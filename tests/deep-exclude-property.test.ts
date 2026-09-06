// `visible: { exclude: ["accounts.encSecKey"] }` is a SECRET filter, and its
// contract has a subtle rule: a path through an array applies to every element
// ("clones only along the removal path"). Three holes have shipped in this
// area (see foruser-leak.test.ts), so it is worth a property rather than
// examples.
//
// Two-sided, because a filter can fail in both directions: a secret on the
// targeted path must ALWAYS vanish, and an identically-named field that is NOT
// on that path must ALWAYS survive — over-removal silently empties a UI.
//
// 2800 generated shapes found no failure; this keeps that true. The generator
// leans on what breaks such functions: arrays of arrays (element-wise must
// recurse through both), arrays whose elements do not all carry the path,
// nulls and scalars mid-path, and neighbours named `constructor` / `0` /
// `toString` where `in` and object spread get subtle.
import { assert, assertEquals } from "@std/assert";
import { deepExclude } from "../src/state/state-filter.ts";

const SECRET = "SECRET-MUST-VANISH";
const DECOY = "DECOY-MUST-SURVIVE";

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function build(
  segs: string[],
  rnd: () => number,
  depth = 0,
): unknown {
  if (segs.length === 0) return SECRET;
  const head = segs[0]!;
  const rest = segs.slice(1);
  const leaf = segs[segs.length - 1]!;
  const node: Record<string, unknown> = {};
  const r = rnd();
  node[head] = r < 0.2 && depth < 3
    ? [[build(rest, rnd, depth + 1)], [
      build(rest, rnd, depth + 1),
      build(rest, rnd, depth + 1),
    ]]
    : r < 0.4 && depth < 3
    ? [
      build(rest, rnd, depth + 1),
      { unrelated: 1 },
      7,
      null,
      build(rest, rnd, depth + 1),
    ]
    : build(rest, rnd, depth + 1);
  // Same LEAF NAME, off the targeted path — every one of these must survive.
  if (rnd() < 0.6) node["other"] = { [leaf]: DECOY };
  if (rnd() < 0.5) node["list"] = [{ [leaf]: DECOY }];
  if (rnd() < 0.4) node["plain"] = [1, "x", null, true];
  if (rnd() < 0.3) node["constructor"] = { [leaf]: DECOY };
  if (rnd() < 0.3) node["0"] = { [leaf]: DECOY };
  if (rnd() < 0.2) node["toString"] = DECOY;
  if (rnd() < 0.2) node[head + "x"] = { [leaf]: DECOY };
  return node;
}

Deno.test("deepExclude property: the secret always goes, the decoys always stay", () => {
  let shapes = 0;
  for (const seed of [1, 2, 3, 7, 8, 9, 10]) {
    const rnd = makeRng(seed);
    for (let i = 0; i < 120; i++) {
      const depth = 1 + Math.floor(rnd() * 3);
      const segs = Array.from({ length: depth }, (_, k) => `k${k}`);
      segs[segs.length - 1] = "secret";
      const input = build(segs, rnd);
      const inText = JSON.stringify(input);
      const outText = JSON.stringify(deepExclude(input, segs));
      shapes++;

      assert(
        !outText.includes(SECRET),
        `seed ${seed} #${i}: a secret on ${segs.join(".")} survived\n` +
          `  in : ${inText.slice(0, 240)}\n  out: ${outText.slice(0, 240)}`,
      );
      const want = (inText.match(/DECOY-MUST-SURVIVE/g) ?? []).length;
      const got = (outText.match(/DECOY-MUST-SURVIVE/g) ?? []).length;
      assertEquals(
        got,
        want,
        `seed ${seed} #${i}: over-removal on ${
          segs.join(".")
        } — a field with ` +
          `the same NAME but off the path was dropped\n  in : ${
            inText.slice(0, 240)
          }\n  out: ${outText.slice(0, 240)}`,
      );
    }
  }
  // VERIFY THE INSTRUMENT: a generator that produced nothing would pass.
  assertEquals(shapes, 840, "the generator must actually produce shapes");
});

// The rule the array case exists for, stated once as an example so a reader
// does not have to run the generator to see it.
Deno.test("deepExclude: a path through an array applies to every element", () => {
  const rows = {
    rows: [
      { id: 1, secret: "a" },
      { id: 2 },
      { id: 3, secret: "c" },
    ],
  };
  assertEquals(deepExclude(rows, ["rows", "secret"]), {
    rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
  });
  // …and an untouched branch keeps referential identity
  const keep = { a: { b: 1 }, drop: { secret: 1 } };
  const out = deepExclude(keep, ["drop", "secret"]) as typeof keep;
  assertEquals(out.a, keep.a);
  assert(out.a === keep.a, "untouched branches are not cloned");
});
