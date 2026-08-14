// The return-value transport gate: what a method returns is what its caller
// receives — or the framework SAYS SO.
//
// Sibling of proxy-differential. `serializeReturn` used to set `dropped` only
// when the WHOLE value failed to stringify, so everything JSON "handles" by
// quietly changing it crossed the wire corrupted and silent. A 45-class sweep
// × {sync, async} × {in-process, WS, UDS} scored EXACT=37, DROPPED(warned)=0,
// LOSSY-SILENT=53 — fifty-three ways to hand an app a different value than its
// method returned, with no warning anywhere. (WS and UDS agreed on all 90, so
// the defect was in the shared guard, not in a transport.)
//
// This file pins the CLASS: every value class is declared exact, lossy or
// dropped, and the guard must agree — a new silent conversion fails here
// rather than in someone's app.
import { assert, assertEquals } from "@std/assert";
import { fuzzEnvInt } from "./fuzz-seed.ts";
import { serializeReturn } from "../src/protocol/return-value.ts";
import { bootCells } from "../src/testing/cell-test.ts";
import { cell } from "../src/state/cell-create.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const SEED = fuzzEnvInt("FUZZ_SEED", 0x5eed10, 0) & 0x7fffffff;
const ROUNDS = fuzzEnvInt("FUZZ_ROUNDS", 60, 1);

/** exact  — the caller receives the same value
 *  lossy  — it arrives changed, and the guard must SAY so
 *  dropped— it cannot travel at all; the caller resolves undefined + a warn */
type Verdict = "exact" | "lossy" | "dropped";

class Point {
  constructor(public x = 1, public y = 2) {}
}
class WithToJson {
  hidden = "real";
  toJSON() {
    return { fake: true };
  }
}

const CLASSES: { name: string; make: () => unknown; verdict: Verdict }[] = [
  // — primitives that survive —
  { name: "undefined", make: () => undefined, verdict: "exact" },
  { name: "null", make: () => null, verdict: "exact" },
  { name: "true", make: () => true, verdict: "exact" },
  { name: "false", make: () => false, verdict: "exact" },
  { name: "zero", make: () => 0, verdict: "exact" },
  { name: "int", make: () => 42, verdict: "exact" },
  { name: "negative", make: () => -7, verdict: "exact" },
  { name: "float", make: () => 1.5, verdict: "exact" },
  { name: "maxSafeInt", make: () => Number.MAX_SAFE_INTEGER, verdict: "exact" },
  { name: "emptyString", make: () => "", verdict: "exact" },
  { name: "string", make: () => "hi", verdict: "exact" },
  { name: "unicodeString", make: () => "héllo ✅ 𝔘", verdict: "exact" },
  {
    name: "jsonLookalikeString",
    make: () => '{"t":"state"}',
    verdict: "exact",
  },
  { name: "emptyObject", make: () => ({}), verdict: "exact" },
  { name: "emptyArray", make: () => [], verdict: "exact" },
  {
    name: "flatObject",
    make: () => ({ a: 1, b: "x", c: true }),
    verdict: "exact",
  },
  {
    name: "nestedObject",
    make: () => ({ a: { b: { c: [1, 2, { d: null }] } } }),
    verdict: "exact",
  },
  {
    name: "arrayOfObjects",
    make: () => [{ id: 1 }, { id: 2 }],
    verdict: "exact",
  },
  { name: "nullInArray", make: () => [null, 1, "x"], verdict: "exact" },
  { name: "objectWithNullField", make: () => ({ a: null }), verdict: "exact" },
  { name: "deepArray", make: () => [[[[1]]]], verdict: "exact" },
  { name: "numericKeys", make: () => ({ 1: "a", 2: "b" }), verdict: "exact" },
  { name: "emptyStringKey", make: () => ({ "": 1 }), verdict: "exact" },

  // — silently CHANGED by JSON: every one of these used to arrive corrupted —
  { name: "Date", make: () => new Date(0), verdict: "lossy" },
  { name: "DateNested", make: () => ({ due: new Date(0) }), verdict: "lossy" },
  { name: "Map", make: () => new Map([["a", 1]]), verdict: "lossy" },
  { name: "Set", make: () => new Set([1, 2]), verdict: "lossy" },
  { name: "RegExp", make: () => /x/g, verdict: "lossy" },
  { name: "Error", make: () => new Error("boom"), verdict: "lossy" },
  { name: "NaN", make: () => NaN, verdict: "lossy" },
  { name: "Infinity", make: () => Infinity, verdict: "lossy" },
  { name: "-Infinity", make: () => -Infinity, verdict: "lossy" },
  { name: "negativeZero", make: () => -0, verdict: "lossy" },
  { name: "NaNNested", make: () => ({ n: NaN }), verdict: "lossy" },
  {
    name: "undefinedMember",
    make: () => ({ a: 1, b: undefined }),
    verdict: "lossy",
  },
  {
    name: "functionMember",
    make: () => ({ a: 1, fn: () => 0 }),
    verdict: "lossy",
  },
  {
    name: "symbolMember",
    make: () => ({ a: 1, s: Symbol("x") }),
    verdict: "lossy",
  },
  { name: "undefinedInArray", make: () => [1, undefined, 3], verdict: "lossy" },
  { name: "sparseArray", make: () => [1, , 3], verdict: "lossy" },
  {
    name: "Uint8Array",
    make: () => new Uint8Array([1, 2, 3]),
    verdict: "lossy",
  },
  { name: "classInstance", make: () => new Point(), verdict: "lossy" },
  {
    name: "classInstanceNested",
    make: () => ({ p: new Point() }),
    verdict: "lossy",
  },
  { name: "toJSONShadow", make: () => new WithToJson(), verdict: "lossy" },
  { name: "URL", make: () => new URL("https://x.dev/a"), verdict: "lossy" },
  {
    name: "nullPrototype",
    make: () => Object.assign(Object.create(null), { a: 1 }),
    verdict: "exact",
  },

  // — cannot travel at all: dropped to undefined, loudly —
  { name: "bareFunction", make: () => () => 42, verdict: "dropped" },
  { name: "bareSymbol", make: () => Symbol("s"), verdict: "dropped" },
  { name: "bigint", make: () => 10n, verdict: "dropped" },
  { name: "bigintNested", make: () => ({ n: 10n }), verdict: "dropped" },
  {
    name: "circular",
    make: () => {
      const a: Record<string, unknown> = { n: 1 };
      a.self = a;
      return a;
    },
    verdict: "dropped",
  },
];

Deno.test("return-value: every value class is exact, or the guard says what changed", () => {
  const wrong: string[] = [];
  for (const { name, make, verdict } of CLASSES) {
    const v = make();
    const r = serializeReturn(v, `fuzz:${name}`);
    const got: Verdict = r.dropped
      ? "dropped"
      : r.lossy.length > 0
      ? "lossy"
      : "exact";
    if (got !== verdict) {
      wrong.push(
        `${name}: expected ${verdict}, guard reported ${got}` +
          (r.lossy.length ? ` (${JSON.stringify(r.lossy)})` : ""),
      );
      continue;
    }
    // An "exact" verdict is a promise: the round-trip must be deep-equal.
    if (verdict === "exact" && v !== undefined) {
      assertEquals(
        r.value,
        JSON.parse(JSON.stringify(v)),
        `${name}: declared exact but the round-trip differs`,
      );
    }
    // A "lossy" verdict must NAME a path, or the report is useless.
    if (verdict === "lossy") {
      assert(r.lossy[0]!.path.startsWith("value"), `${name}: unnamed path`);
      assert(r.lossy[0]!.from.length > 0 && r.lossy[0]!.to.length > 0);
    }
  }
  assertEquals(
    wrong,
    [],
    "a value class crosses the wire with the wrong verdict — silent " +
      "corruption is exactly what this gate exists to prevent",
  );
});

Deno.test("return-value: a lossy value is named per PATH, not just flagged", () => {
  const r = serializeReturn(
    { keep: 1, when: new Date(0), deep: { bad: NaN, gone: undefined } },
    "cell:m",
  );
  assertEquals(r.dropped, false);
  const paths = r.lossy.map((l) => l.path).sort();
  assertEquals(paths, ["value.deep.bad", "value.deep.gone", "value.when"]);
  assertEquals(r.lossy.find((l) => l.path === "value.when")!.from, "Date");
  assertEquals(r.lossy.find((l) => l.path === "value.when")!.to, "string");
  assertEquals(r.lossy.find((l) => l.path === "value.deep.gone")!.to, "absent");
});

Deno.test("return-value: fuzz — random compositions never report a false EXACT", () => {
  let seed = SEED;
  const rnd = () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)]!;

  for (let round = 0; round < ROUNDS; round++) {
    // Build a random tree out of the classes above and predict its verdict
    // from its parts: a composite is exact only if every part is.
    const parts = Array.from(
      { length: 1 + Math.floor(rnd() * 4) },
      () => pick(CLASSES.filter((c) => c.name !== "circular")),
    );
    const obj: Record<string, unknown> = {};
    for (const [i, p] of parts.entries()) obj[`k${i}`] = p.make();
    const expectDropped = parts.some((p) =>
      p.verdict === "dropped" && /bigint/i.test(p.name)
    );
    // A bare function/symbol nested in an object is stripped, not fatal.
    //
    // `undefined` is the one class whose verdict DEPENDS on position, and this
    // oracle used to get it wrong: the table's "exact" is the verdict for the
    // BARE value (`return undefined` really does arrive as undefined), but as a
    // MEMBER the key vanishes entirely, which `findLossy` reports as
    // `absent` — deliberately, pinned by the hand-written test above
    // (`value.deep.gone`). The composite rule read the bare verdict, so every
    // seed that happened to draw `undefined` failed this fuzzer against
    // correct code (FUZZ_SEED=3 and 11 both did). A gate that goes red on the
    // behaviour another test demands is noise, and noise is how a real
    // failure gets waved through.
    const expectExact = !expectDropped &&
      parts.every((p) => p.verdict === "exact" && p.name !== "undefined");
    const repro = `FUZZ_SEED=${SEED} round ${round}: ${
      parts.map((p) => p.name).join("+")
    }`;
    const r = serializeReturn(obj, "fuzz:composite");
    if (expectDropped) {
      assertEquals(r.dropped, true, `expected dropped — ${repro}`);
      continue;
    }
    if (expectExact) {
      assertEquals(r.lossy, [], `false LOSSY on an exact value — ${repro}`);
      assertEquals(r.value, JSON.parse(JSON.stringify(obj)), repro);
    } else {
      assert(
        r.lossy.length > 0,
        `a composite containing ${
          parts.filter((p) => p.verdict !== "exact").map((p) => p.name).join(
            ",",
          )
        } reported EXACT — ${repro}`,
      );
    }
  }
});

// ── sync/async parity of the return contract ─────────────────────────

Deno.test("return-value: a SYNC method returning null resolves null, like the async one", async () => {
  // `if (result == null) return undefined` swallowed `null` — the standard
  // "not found" sentinel — so the same method written sync and async resolved
  // differently on every transport.
  const c = cell("retnull", {
    state: { n: 0 },
    methods: {
      findSync(_s: { n: number }) {
        return null;
      },
      // deno-lint-ignore require-await
      async findAsync(_s: { n: number }) {
        return null;
      },
      voidSync(s: { n: number }) {
        s.n++;
      },
      zeroSync(_s: { n: number }) {
        return 0;
      },
      emptySync(_s: { n: number }) {
        return "";
      },
      falseSync(_s: { n: number }) {
        return false;
      },
    },
  });
  const h = await bootCells([c]);
  try {
    assertEquals(await (c as Any).findSync(), null, "sync null must stay null");
    assertEquals(await (c as Any).findAsync(), null);
    assertEquals(
      await (c as Any).voidSync(),
      undefined,
      "void stays undefined",
    );
    assertEquals(await (c as Any).zeroSync(), 0);
    assertEquals(await (c as Any).emptySync(), "");
    assertEquals(await (c as Any).falseSync(), false);
  } finally {
    h.dispose();
  }
});
