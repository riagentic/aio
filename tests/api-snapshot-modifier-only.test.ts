// An `async` / `*` modifier change is additive only when a person REVIEWED it.
//
// `renderToStream` had to become a plain function returning its generator (it
// takes the request's route and key at the call), with the same parameters and
// the same annotated `AsyncGenerator<…>` return type. The gate hashed the
// declaration's `isAsync` / `isGenerator` flags and called it BREAKING. But a
// modifier is not nothing even with the type unchanged: `async` → plain moves a
// throw from the returned promise to the call, `function*` → plain runs side
// effects at the call. So the digests may only PROVE a change modifier-only;
// harmless takes a reviewed entry naming the symbol and both digests.
//   - modifier-only, declared type identical, reviewed entry → additive;
//   - the same change with no entry (or an entry for other digests) → BREAKING;
//   - no return type annotation, a changed return type, or changed
//     parameters → BREAKING, entry or not.
import { assert, assertEquals } from "@std/assert";
import {
  diffSnapshots,
  MODIFIER_REVIEWED,
  modifierAlternates,
  modifierOnly,
  sigOf,
  type Snapshot,
} from "../scripts/api-snapshot.ts";

const param = (name: string, repr: string) => ({
  kind: "identifier",
  name,
  optional: false,
  tsType: { repr, kind: "keyword", value: repr },
});
const GEN = {
  repr: "AsyncGenerator",
  kind: "typeRef",
  value: { typeName: "AsyncGenerator", typeParams: [] },
};
const PROMISE = {
  repr: "Promise",
  kind: "typeRef",
  value: { typeName: "Promise", typeParams: [] },
};

type Def = Record<string, unknown>;
const fn = (def: Def) => [{ kind: "function", def }];

async function entryOf(def: Def) {
  const decls = fn(def);
  const alts = await modifierAlternates(decls);
  return {
    kind: "function",
    sig: await sigOf(decls),
    ...(alts.length ? { modifierAlts: alts } : {}),
  };
}

/** The diff's verdict — as `diffSnapshots` gives it (no reviewed entry for
 *  the synthetic `./x › f`), and as `modifierOnly` gives it WITH one. */
async function verdict(before: Def, after: Def) {
  const snap = async (def: Def): Promise<Snapshot> => ({
    $comment: "",
    entries: { "./x": { symbols: { f: await entryOf(def) } } },
  });
  const a = await entryOf(before), b = await entryOf(after);
  const diff = diffSnapshots(await snap(before), await snap(after));
  assertEquals(diff.length, 1, JSON.stringify(diff));
  const entryFor = (oldSig: string, newSig: string) => [{
    entry: "./x",
    symbol: "f",
    oldSig,
    newSig,
    reason: "test",
  }];
  return {
    unreviewed: diff[0]!,
    reviewed: modifierOnly("./x", "f", a, b, entryFor(a.sig, b.sig)),
    reviewedOtherDigests: modifierOnly(
      "./x",
      "f",
      a,
      b,
      entryFor(b.sig, a.sig),
    ),
    reviewedOtherSymbol: modifierOnly("./x", "g", a, b, entryFor(a.sig, b.sig)),
    // The right OLD digest, but the entry was reviewed for another NEW one:
    // the symbol changed again since the review, so it is judged afresh.
    reviewedOtherNewSig: modifierOnly(
      "./x",
      "f",
      a,
      b,
      entryFor(a.sig, "0000000000000000"),
    ),
  };
}

const params = [param("v", "string")];

Deno.test("a modifier-only change is additive only with a reviewed entry for exactly it", async () => {
  const cases: [Def, Def][] = [
    [
      {
        params,
        returnType: GEN,
        hasBody: true,
        isAsync: true,
        isGenerator: true,
      },
      { params, returnType: GEN, hasBody: true },
    ],
    [
      { params, returnType: GEN, hasBody: true },
      {
        params,
        returnType: GEN,
        hasBody: true,
        isAsync: true,
        isGenerator: true,
      },
    ],
    // async → plain: a throw moves from the promise to the call
    [
      { params, returnType: PROMISE, hasBody: true, isAsync: true },
      { params, returnType: PROMISE, hasBody: true },
    ],
  ];
  assertEquals(cases.length, 3);
  for (const [before, after] of cases) {
    const v = await verdict(before, after);
    assertEquals(v.unreviewed.breaking, true, v.unreviewed.line);
    assertEquals(v.reviewed, true);
    assertEquals(v.reviewedOtherDigests, false);
    assertEquals(v.reviewedOtherSymbol, false);
    assertEquals(v.reviewedOtherNewSig, false);
  }
});

Deno.test("no reviewed entry helps without a declared return type, or with a changed type or parameters", async () => {
  const cases: [Def, Def][] = [
    [{ params, hasBody: true, isAsync: true }, { params, hasBody: true }],
    [
      { params, hasBody: true, isAsync: true, isGenerator: true },
      { params, returnType: GEN, hasBody: true },
    ],
    [
      {
        params,
        returnType: GEN,
        hasBody: true,
        isAsync: true,
        isGenerator: true,
      },
      { params, returnType: PROMISE, hasBody: true },
    ],
    [
      {
        params,
        returnType: GEN,
        hasBody: true,
        isAsync: true,
        isGenerator: true,
      },
      { params: [param("v", "number")], returnType: GEN, hasBody: true },
    ],
  ];
  assertEquals(cases.length, 4);
  for (const [before, after] of cases) {
    const v = await verdict(before, after);
    assertEquals(v.unreviewed.breaking, true, v.unreviewed.line);
    assertEquals(v.reviewed, false, JSON.stringify(after));
  }
});

// The reviewed entry records the 1.0.10 change (async function* → a plain
// function), so it must name the digest the 1.0.10 SNAPSHOT carried. The
// current snapshot has moved on by an additive change (1.0.11's optional
// `opts` parameter), which check:api judges on its own — this entry must not
// be what excuses it, and the next test's end-to-end diff pins that it only
// ever matches its exact two digests.
const TAGGED_1_0_10 = await new Deno.Command("git", {
  args: ["rev-parse", "-q", "--verify", "refs/tags/v1.0.10-beta"],
  cwd: new URL("..", import.meta.url).pathname,
  stdout: "null",
  stderr: "null",
}).output().then((o) => o.success, () => false);

Deno.test({
  name:
    "renderToStream's reviewed entry names the digest the 1.0.10 snapshot carried",
  // aio-ok: a checkout without the v1.0.10-beta tag (a `git archive` copy)
  // has no 1.0.10 snapshot to read; the entry is then checked by the diff test.
  ignore: !TAGGED_1_0_10,
  fn: async () => {
    const entry = MODIFIER_REVIEWED.find((r) => r.symbol === "renderToStream")!;
    assert(entry.reason.length > 40);
    const o = await new Deno.Command("git", {
      args: ["show", "v1.0.10-beta:docs/api-snapshot.json"],
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(o.success, new TextDecoder().decode(o.stderr));
    const snapshot = JSON.parse(new TextDecoder().decode(o.stdout));
    assertEquals(
      snapshot.entries[entry.entry].symbols.renderToStream.sig,
      entry.newSig,
    );
  },
});

Deno.test("the alternatives are computed only for a declared return type, and never written", async () => {
  assertEquals(await modifierAlternates(fn({ params, hasBody: true })), []);
  assertEquals(
    (await modifierAlternates(fn({ params, returnType: GEN, hasBody: true })))
      .length,
    3,
  );
  const snapshot = await Deno.readTextFile(
    new URL("../docs/api-snapshot.json", import.meta.url),
  );
  assertEquals(snapshot.includes("modifierAlts"), false);
});

// End to end through the DIFF (not just the predicate): the reviewed list is
// what turns a modifier-only change additive — for exactly its digests, and
// never for an overloaded symbol.
Deno.test("diffSnapshots honours a reviewed entry for exactly its digests, and never for overloads", async () => {
  const before: Def = {
    params,
    returnType: GEN,
    hasBody: true,
    isAsync: true,
    isGenerator: true,
  };
  const after: Def = { params, returnType: GEN, hasBody: true };
  const a = await entryOf(before), b = await entryOf(after);
  const snap = (e: object): Snapshot => ({
    $comment: "",
    entries: { "./x": { symbols: { f: e as never } } },
  });
  const review = (oldSig: string, newSig: string) => [{
    entry: "./x",
    symbol: "f",
    oldSig,
    newSig,
    reason: "test",
  }];
  const verdictWith = (
    x: object,
    y: object,
    list: ReturnType<typeof review>,
  ) => {
    const d = diffSnapshots(snap(x), snap(y), list);
    assertEquals(d.length, 1, JSON.stringify(d));
    return d[0]!;
  };
  // The right digests: additive, and the line says why.
  const ok = verdictWith(a, b, review(a.sig, b.sig));
  assertEquals(ok.breaking, false, ok.line);
  assert(ok.line.includes("reviewed"), ok.line);
  // A wrong oldSig: the entry reviewed some OTHER change — BREAKING.
  const wrongOld = verdictWith(a, b, review("0000000000000000", b.sig));
  assertEquals(wrongOld.breaking, true, wrongOld.line);
  // An overloaded symbol on either side: never through this door.
  const multi = verdictWith(
    { ...a, sigs: [a.sig, "1111111111111111"] },
    b,
    review(a.sig, b.sig),
  );
  assertEquals(multi.breaking, true, multi.line);
  const multiAfter = verdictWith(
    a,
    { ...b, sigs: [b.sig, "2222222222222222"] },
    review(a.sig, b.sig),
  );
  assertEquals(multiAfter.breaking, true, multiAfter.line);
});
