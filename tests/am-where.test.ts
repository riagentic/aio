// `am where <file>` — make an invisible property inspectable.
//
// Field report: "aio has roughly six execution contexts that all look like
// ordinary TypeScript, and almost nothing in the source tells you which one you
// are in. Every expensive bug in this file is a row in that table read wrong,
// and the app cannot see the rows."
//
// The graph validator already computes the answer — `GraphResult.modules` is
// what the UI entry reaches, `eager` is the subset the browser links statically
// — which is exactly how it distinguishes a blocking import from a deferred
// one. This is a presentation layer over data aio had already built, so the
// verdict is derived and never guessed.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { importChain, whereRules } from "../src/am/am-cmd-where.ts";
import type { GraphResult, ModuleNode } from "../src/server/graph-validator.ts";
import { context, SIDE } from "../src/diagnostics/contexts.ts";

/** A graph shaped like a real one: App → cell → util, plus a lazily imported
 *  chunk the browser may never load. */
function graph(): GraphResult {
  const node = (path: string, deps: string[]): [string, ModuleNode] => [
    path,
    { path, hash: "", deps, valid: true, errors: [] },
  ];
  return {
    valid: true,
    errors: [],
    modules: new Map([
      node("/a/App.tsx", ["/a/cell.ts", "/a/lazy.ts"]),
      node("/a/cell.ts", ["/a/util.ts"]),
      node("/a/util.ts", []),
      node("/a/lazy.ts", []),
    ]),
    eager: new Set(["/a/App.tsx", "/a/cell.ts", "/a/util.ts"]),
    durationMs: 0,
  };
}

Deno.test("am where: the chain is the answer to WHY this is in the browser", () => {
  // A verdict with no chain is a claim, and a claim is what sends people
  // looking in the wrong file. The shortest path is the one to print.
  assertEquals(importChain(graph(), "/a/App.tsx", "/a/util.ts"), [
    "/a/App.tsx",
    "/a/cell.ts",
    "/a/util.ts",
  ]);
  assertEquals(importChain(graph(), "/a/App.tsx", "/a/App.tsx"), [
    "/a/App.tsx",
  ]);
  assertEquals(importChain(graph(), "/a/App.tsx", "/a/nowhere.ts"), null);
});

Deno.test("am where: a cycle does not hang the walk", () => {
  const g = graph();
  g.modules.get("/a/util.ts")!.deps = ["/a/cell.ts"];
  assert(importChain(g, "/a/App.tsx", "/a/util.ts"));
  assertEquals(importChain(g, "/a/App.tsx", "/a/missing.ts"), null);
});

Deno.test("am where: each verdict names the rules that follow from it", () => {
  // The rules ARE the columns of the table in docs/basics/where-code-runs.md.
  // A command and a doc that answer differently is worse than either alone.
  const eager = whereRules("browser-eager", false);
  assert(
    eager.rules.some((r) => r.includes("`Deno.*`")),
    eager.rules.join("|"),
  );
  assert(eager.rules.some((r) => r.includes("THROWS")), "hidden fields");
  assert(eager.rules.some((r) => r.includes("subscribes")), "tracked reads");

  // Deferred is the subtle one: `Deno.*` is safe here ONLY while nothing
  // static-imports the file, and that is a property of OTHER files.
  const deferred = whereRules("browser-deferred", false);
  assert(
    deferred.rules.some((r) => r.includes("ONLY while nothing static")),
    deferred.rules.join("|"),
  );
  assert(
    deferred.rules.some((r) => r.includes("*.server.ts")),
    "names the fix that makes the property permanent",
  );

  // Server context has to name the ONE exception, or the answer is wrong for
  // every sync/localFirst cell — and it names it in the VOCABULARY's words,
  // not a paraphrase, which is the whole point of there being a vocabulary.
  const server = whereRules("server-only", false);
  const sync = context("a sync method");
  assert(
    server.rules.some((r) =>
      r.includes(sync.name) && r.includes(sync.surprise)
    ),
    server.rules.join("|"),
  );
  assert(server.headline.includes(SIDE.server), server.headline);

  // Two honest possibilities, said as two.
  assert(
    whereRules("unreached", false).rules.some((r) => r.includes("dead code")),
  );
});

Deno.test("am where: the filename wins, whatever the graph says", () => {
  // `*.server.ts` is the one place aio makes the boundary visible, and it is
  // true regardless of reachability — the bundler marks those external.
  for (const v of ["browser-eager", "server-only", "unreached"] as const) {
    const r = whereRules(v, true);
    assert(r.headline.includes("the context is in the filename"), r.headline);
    assert(r.headline.includes(SIDE.server), r.headline);
    assert(r.rules.some((x) => x.includes("static import")), "names the trap");
  }
});

Deno.test("am where: the verdicts are rendered from THE vocabulary", () => {
  // The failure this prevents: `am where`, the docs table and the error
  // strings drifting into three answers that agreed on the day they were
  // written. Every rule text must be composed of the vocabulary's own words.
  for (const v of ["browser-eager", "server-only", "unreached"] as const) {
    const r = whereRules(v, false);
    assert(
      r.headline.includes(SIDE.client) || r.headline.includes(SIDE.server),
      `every verdict must name which SIDE it is on: ${r.headline}`,
    );
  }
  // …and a context that does not exist is a typo in a message, which is
  // exactly what the vocabulary exists to make impossible.
  assertThrows(() => context("the renderer process"));
});

Deno.test("am where: a CELL FILE is two contexts, and says so", () => {
  // Found by running `am where src/cell.ts` on a scaffolded app. A cell file
  // is browser-eager (its definition is linked into the bundle) AND the home
  // of methods that run on the server — and the answer said only the first:
  //
  //   `Deno.*` and `@std/*`: NO — this code is in a browser
  //
  // …from which a reader correctly concludes something false about their async
  // methods. That is the exact confusion this command exists to remove.
  const plain = whereRules("browser-eager", false, false);
  const cells = whereRules("browser-eager", false, true);
  assertEquals(
    cells.rules.length,
    plain.rules.length + 1,
    "the cell note is ADDITIVE — nothing that was true stops being said",
  );
  const note = cells.rules.at(-1)!;
  assert(note.includes("DEFINES CELLS"), note);
  assert(note.includes(context("an async method").name), note);
  assert(note.includes(SIDE.server), note);
  assert(note.includes("may use `Deno.*`"), "the correction is the point");
  assert(note.includes("*.server.ts"), "…and it names where the imports go");

  // Only where it is true: a server-context file already says `Deno.*` is
  // fine, so repeating it would be noise.
  assertEquals(
    whereRules("server-only", false, true).rules,
    whereRules("server-only", false, false).rules,
  );
});

Deno.test("am where: `unknown` when no graph could be BUILT — never a guess", () => {
  // Field report §8.1, found in three minutes of using the tool built to close
  // §4. Run from outside the project, `am where <a .tsx component>` answered
  //
  //   verdict: "server-only" · "`Deno.*`, `@std/*`, the filesystem: yes"
  //
  // …the opposite of the truth, with three confident rules and no hedge — and
  // it contradicted the aiol rule the SAME release shipped ("a .tsx file is
  // client context by construction"), so two halves of one release disagreed
  // about one file. Its own output already said `entry: null, modules: 0`.
  //
  // The class, in the reporter's words: "a confident answer where 'I don't
  // know' was available." Which is this project's own standard, from
  // `reportHiddenRead`: a bug that yields a plausible value is worse than one
  // that stops the page.
  const r = whereRules("unknown", false);
  assert(r.headline.includes("unknown"), r.headline);
  assert(
    !r.headline.includes(SIDE.server) && !r.headline.includes(SIDE.client),
    `"unknown" must not name a side — that is the whole bug: ${r.headline}`,
  );
  assert(
    r.rules.some((x) => x.includes("NOT a verdict about the file")),
    "it has to say it is not answering, not merely answer vaguely",
  );
  assert(
    r.rules.some((x) => x.includes("--entry=")),
    "…and name the flag that gets a real answer — undiscoverable from a wrong one",
  );
  // No rule may claim a capability. Every other verdict does; this one cannot,
  // because it knows nothing.
  assert(
    !r.rules.some((x) => /: yes$/.test(x)),
    `"unknown" must grant nothing: ${r.rules.join(" | ")}`,
  );
});
