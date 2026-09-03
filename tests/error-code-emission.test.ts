// `AioErrorCode` is a PUBLIC union, and at beta1 it freezes: a member can
// never be removed again. So the only thing that can go wrong afterwards is
// what had already gone wrong — a member that names a failure the framework
// does not produce, documented in `docs/debugging/errors.md` as if it did.
//
// Four were dead. `MACHINE_BLOCKED` belonged to the `machine:` cell key,
// removed in alpha27 (src/state/removals-core.ts); a guarded action reports as
// the `action-guarded` diagnostic event instead. `UI_FREEZE`,
// `TRANSPORT_STALL` and `LOOP_SATURATED` are vitals thresholds, and a
// threshold breach reports on the diagnostic bus — it is an observation about
// the process, not the failure of one call. An app could write
// `catch (e) { if (errorCode(e) === "UI_FREEZE") … }` from the docs and wait
// forever.
//
// They cannot be deleted, so they are marked `@deprecated` at their source and
// in the docs — and THIS test is what keeps that marking true. It reads the
// call sites, not a hand-kept list, so a code that gains a producer (good) or
// silently loses one (the original bug) fails here on the same day.
// (audit a16/10)
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";

const SRC = fromFileUrl(new URL("../src/", import.meta.url));
const ERROR_TS = fromFileUrl(
  new URL("../src/diagnostics/error.ts", import.meta.url),
);

async function* tsFiles(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory) yield* tsFiles(path);
    else if (e.name.endsWith(".ts")) yield path;
  }
}

/** Comments removed — a code NAMED in prose is not a code PRODUCED. Naive on
 *  purpose: the only thing searched for afterwards is a quoted SCREAMING_CASE
 *  token, which cannot hide inside a URL or a regex. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Every code some module outside `error.ts` actually names in live code.
 *
 *  Deliberately NOT `createAioError\("CODE"` — several codes are chosen by an
 *  expression (`over ? "BUDGET_REDUCE" : "BUDGET_EFFECT"` in dispatch.ts) and
 *  a matcher that only saw the literal call would have called those dead too.
 *  The question this answers is the audit's: does any producing module name
 *  this code at all? */
async function emittedCodes(): Promise<Set<string>> {
  const found = new Set<string>();
  for await (const path of tsFiles(SRC)) {
    if (path.endsWith("/diagnostics/error.ts")) continue; // the declaration
    const text = code(await Deno.readTextFile(path));
    for (const m of text.matchAll(/"([A-Z][A-Z_]+)"/g)) found.add(m[1]!);
  }
  return found;
}

/** The union's members, in declaration order, and which carry `@deprecated`. */
async function unionMembers(): Promise<
  { all: string[]; deprecated: Set<string> }
> {
  const text = await Deno.readTextFile(ERROR_TS);
  const start = text.indexOf("export type AioErrorCode =");
  // The union ends at the first `| "NAME";` line — NOT at the first `;` in the
  // slice, which lands inside a jsdoc sentence.
  const body = text.slice(start).split(/^\s*\|\s*"[A-Z_]+";\s*$/m)[0]! +
    text.slice(start).match(/^\s*\|\s*"[A-Z_]+";\s*$/m)![0];
  const all: string[] = [];
  const deprecated = new Set<string>();
  // A member is `| "NAME"`. It is deprecated when the jsdoc block immediately
  // above it says so — the same block a reader of the type sees in their
  // editor, so this cannot pass while the editor tooltip lies.
  const lines = body.split("\n");
  let sawDeprecated = false;
  for (const line of lines) {
    const m = /^\s*\|\s*"([A-Z_]+)"/.exec(line);
    if (m) {
      all.push(m[1]!);
      if (sawDeprecated) deprecated.add(m[1]!);
      sawDeprecated = false;
      continue;
    }
    if (line.includes("@deprecated")) sawDeprecated = true;
    else if (line.trim().startsWith("*") || line.trim().startsWith("/**")) {
      /* still inside the same jsdoc block — keep the flag */
    } else if (line.trim().startsWith("//")) {
      /* a section banner never clears it either */
    } else sawDeprecated = false;
  }
  return { all, deprecated };
}

Deno.test("error codes: every @deprecated member is exactly a never-emitted one", async () => {
  const emitted = await emittedCodes();
  const { all, deprecated } = await unionMembers();

  const dead = all.filter((c) => !emitted.has(c)).sort();
  assertEquals(
    dead,
    [...deprecated].sort(),
    "A code with no `createAioError` call site anywhere in src/ must be " +
      "marked @deprecated on the union (and in docs/debugging/errors.md), and " +
      "nothing else may be. Either you removed the last producer of a code — " +
      "mark it, and say so in the docs — or you gave a dead code a producer, " +
      "in which case drop its @deprecated tag and the docs' note.",
  );
});

Deno.test("error codes: the four known-dead ones are still dead, and the network pair is alive", async () => {
  const emitted = await emittedCodes();
  // Pinned by NAME as well as by the structural rule above, because these four
  // are the ones the docs promised and could not deliver. If one of them ever
  // gains a producer, that is a deliberate act and this line is where it is
  // recorded.
  for (
    const dead of [
      "MACHINE_BLOCKED",
      "UI_FREEZE",
      "TRANSPORT_STALL",
      "LOOP_SATURATED",
    ]
  ) {
    assertEquals(
      emitted.has(dead),
      false,
      `${dead} gained a producer — drop its @deprecated tag and update ` +
        `docs/debugging/errors.md, which currently says it is never emitted.`,
    );
  }
  // …and the two codes an app actually branches on ARE produced. Without this
  // half, "no dead codes" would also pass on a build that emits nothing.
  assertEquals(
    emitted.has("ACCESS_DENIED"),
    true,
    "ACCESS_DENIED is the code a denied call carries to the caller — see " +
      "tests/wire-error-code.test.ts",
  );
  assertEquals(emitted.has("ACTION_REFUSED"), true);
});

Deno.test("error codes: every union member maps to a source, and no source is orphaned", async () => {
  const { createAioError } = await import("../src/diagnostics/error.ts");
  const { all } = await unionMembers();
  const text = await Deno.readTextFile(ERROR_TS);
  const sourceStart = text.indexOf("export type AioErrorSource =");
  const sourceBody = text.slice(sourceStart).split(
    /^\s*\|\s*"[a-z]+";\s*$/m,
  )[0]! + text.slice(sourceStart).match(/^\s*\|\s*"([a-z]+)";\s*$/m)![0];
  const sources = new Set(
    [...sourceBody.matchAll(/^\s*\|\s*"([a-z]+)"/gm)].map((m) => m[1]!),
  );
  // `all` is PARSED out of error.ts's source, so a refactor of the union's
  // formatting could hand this loop an empty list and it would pass having
  // checked nothing — the instrument failing silently, not the union. Prove
  // the parse first: a floor, and the anchors an app actually branches on.
  assert(
    all.length >= 20,
    `only ${all.length} AioErrorCode members parsed out of error.ts — the ` +
      `union has 25; unionMembers() stopped reading the declaration`,
  );
  for (const anchor of ["ACCESS_DENIED", "ACTION_REFUSED", "MACHINE_BLOCKED"]) {
    assert(
      all.includes(anchor),
      `unionMembers() lost "${anchor}" — the parser broke, not the union`,
    );
  }
  for (const code of all) {
    // `CODE_TO_SOURCE` is a `Record<AioErrorCode, …>`, so the compiler already
    // requires an entry — this checks the entry names a source that EXISTS in
    // the public union, which nothing else does.
    const src = createAioError(
      code as Parameters<typeof createAioError>[0],
      "x",
      {},
    ).source;
    assertEquals(
      sources.has(src),
      true,
      `${code} maps to source "${src}", which is not a member of AioErrorSource`,
    );
  }
});
