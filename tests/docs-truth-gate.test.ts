// The doc→code gate, tested against the defects that produced it.
//
// `scripts/check-docs.ts` used to check code→docs only (a new error code must
// be documented, a page cited from src/ must exist). The other direction was
// unchecked, and an audit walked straight through it: the docs promised
// commands with no binary behind them, imported symbols no export entry
// serves, and tabled an "API" that was members of a plain function. Every one
// of those is mechanically decidable — `am`'s COMMANDS map, deno.json's tasks,
// and docs/api-snapshot.json are all machine-readable — so the gate now reads
// them and the docs are checked against code instead of against care.
//
// This file pins the gate itself. The checkers are pure (docs in, issue lines
// out), so each defect is a fixture rather than a temp docs tree, and a gate
// that stops biting fails HERE rather than the next time someone reads a page.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  commandIssues,
  type DocFile,
  entryOf,
  loadAmVerbs,
  loadAndroidAlias,
  loadSurface,
  loadTaskNames,
  symbolIssues,
} from "../scripts/check-docs.ts";

const doc = (rel: string, body: string): DocFile[] => [
  { rel, lines: body.split("\n") },
];

// ── The sources of truth are read from CODE, never allowlisted ────────

Deno.test("the gate's three sources of truth all parse", async () => {
  const surface = await loadSurface();
  const verbs = await loadAmVerbs();
  const tasks = await loadTaskNames();
  const android = await loadAndroidAlias();

  // A parse that silently yields nothing is a gate that cannot fail; each
  // loader throws on an empty parse, and these assertions pin the shape.
  assert(surface.has("."), "api-snapshot must carry the root entry");
  assert(surface.has("./air"), "api-snapshot must carry ./air");
  assert(verbs.has("surface") && verbs.has("trigger") && verbs.has("create"));
  assert(!verbs.has("doctor"), "`am doctor` does not exist — see src/am.ts");
  assert(tasks.has("check:docs"), "repo tasks come from deno.json");
  assert(
    tasks.has("publish"),
    "scaffolded app tasks come from standardTasks()",
  );
  assert(
    android.has("initStandalone"),
    "the android `aio` alias target must export initStandalone",
  );
});

Deno.test("entryOf maps aio specifiers onto export entries", () => {
  assertEquals(entryOf("aio"), ".");
  assertEquals(entryOf("aio/air"), "./air");
  assertEquals(entryOf("@riagentic/aio/testing"), "./testing");
  assertEquals(entryOf("./local.ts"), null);
  assertEquals(entryOf("@std/assert"), null);
});

// ── Commands ──────────────────────────────────────────────────────────

Deno.test("gate catches a command with no binary behind it", async () => {
  const [verbs, tasks] = [await loadAmVerbs(), await loadTaskNames()];
  // install.sh installs exactly ONE binary, `am`. `aio ship` / `aio build` /
  // `aio doctor` appeared ~65 times across docs and source strings and have
  // never been runnable by anyone.
  for (const ghost of ["aio ship", "aio build", "aio doctor"]) {
    const found = commandIssues(
      doc("fixture.md", `Run \`${ghost}\` to publish.`),
      verbs,
      tasks,
    );
    assertEquals(found.length, 1, `\`${ghost}\` must be caught`);
    assertStringIncludes(found[0]!, "there is no `aio` binary");
  }
});

Deno.test("gate catches an am verb that is not in the COMMANDS map", async () => {
  const [verbs, tasks] = [await loadAmVerbs(), await loadTaskNames()];
  const found = commandIssues(
    doc("fixture.md", "Diagnose with `am doctor`."),
    verbs,
    tasks,
  );
  assertEquals(found.length, 1);
  assertStringIncludes(found[0]!, "`am doctor` is not an am verb");
});

Deno.test("gate catches a deno task that neither the repo nor a scaffold has", async () => {
  const [verbs, tasks] = [await loadAmVerbs(), await loadTaskNames()];
  // The `dev:*` / `compile:*` task matrix was retired in alpha52; the flags
  // pass through the single `dev` task instead.
  const found = commandIssues(
    doc("fixture.md", "```sh\ndeno task dev:expose\n```"),
    verbs,
    tasks,
  );
  assertEquals(found.length, 1);
  assertStringIncludes(found[0]!, "`deno task dev:expose`");
});

Deno.test("gate accepts every real verb and task", async () => {
  const [verbs, tasks] = [await loadAmVerbs(), await loadTaskNames()];
  const body = [
    "`am create my-app`, `am surface 0`, `am trigger 0 App/Btn click`,",
    "then `deno task dev`, `deno task build`, `deno task ship`,",
    "`deno task check:docs`. Placeholders are not verbs: `am <verb>`,",
    "`deno task <name>`.",
  ].join("\n");
  assertEquals(commandIssues(doc("fixture.md", body), verbs, tasks), []);
});

Deno.test("gate allows prose that names a retired command to SAY it is retired", async () => {
  const [verbs, tasks] = [await loadAmVerbs(), await loadTaskNames()];
  // docs/clients/browser.md tells the reader `am interact`/`am click`/`am dom`
  // were removed in favour of the semantic surface. Refusing that sentence
  // would force the docs to go silent about the change, which is the failure
  // mode the retirement note exists to prevent.
  const body = "The older commands (`am interact`, `am click`, `am dom`)\n" +
    "were removed — the semantic surface supersedes them.";
  assertEquals(commandIssues(doc("fixture.md", body), verbs, tasks), []);
  // …but the same verbs with no retirement sentence are still caught.
  assertEquals(
    commandIssues(doc("fixture.md", "Try `am interact`."), verbs, tasks).length,
    1,
  );
});

// ── Symbols ───────────────────────────────────────────────────────────

Deno.test("gate catches a fenced import of a symbol no entry exports", async () => {
  const [surface, android] = [await loadSurface(), await loadAndroidAlias()];
  const found = symbolIssues(
    doc("fixture.md", '```ts\nimport { notAThing } from "aio";\n```'),
    surface,
    android,
  );
  assertEquals(found.length, 1);
  assertStringIncludes(found[0]!, '`notAThing` is not exported from "aio"');
});

Deno.test("gate catches a dead export specifier", async () => {
  const [surface, android] = [await loadSurface(), await loadAndroidAlias()];
  // `aio/react`, `aio/adapters/air` and `aio/boot` were all real once and are
  // named by upgrade guides on purpose; the historical dirs are skipped by the
  // walker, so a LIVE page spelling one is the failure this catches.
  for (const dead of ["aio/react", "aio/adapters/air", "aio/boot"]) {
    const found = symbolIssues(
      doc("fixture.md", `\`\`\`ts\nimport { useCell } from "${dead}";\n\`\`\``),
      surface,
      android,
    );
    assertEquals(found.length, 1, dead);
    assertStringIncludes(found[0]!, "is not an export entry");
  }
});

Deno.test("gate catches an API table row for something you cannot hold", async () => {
  const [surface, android] = [await loadSurface(), await loadAndroidAlias()];
  // The audit's find: a whole "Dispatch Introspection" table for members of
  // `dispatch`, when what the app hands you (`app.dispatch`) is a plain
  // function with no such members.
  const table = [
    "| API                        | Description |",
    "| -------------------------- | ----------- |",
    "| `dispatch.getQueueDepth()` | Queue depth |",
  ].join("\n");
  const found = symbolIssues(doc("fixture.md", table), surface, android);
  assertEquals(found.length, 1);
  assertStringIncludes(found[0]!, "neither an exported symbol nor a");
});

Deno.test("gate catches an API table row for an unexported function", async () => {
  const [surface, android] = [await loadSurface(), await loadAndroidAlias()];
  const table = [
    "| API              | Description |",
    "| ---------------- | ----------- |",
    "| `unexported(x)`  | Nope        |",
  ].join("\n");
  const found = symbolIssues(doc("fixture.md", table), surface, android);
  assertEquals(found.length, 1);
  assertStringIncludes(found[0]!, "is in no export entry");
});

Deno.test("gate allows the android-only `aio` alias, derived from the build", async () => {
  const [surface, android] = [await loadSurface(), await loadAndroidAlias()];
  // In an android bundle `bundleFrameworkEntries()` resolves `"aio"` to
  // src/standalone-air.ts, so `initStandalone` IS importable there and the
  // targets doc is telling the truth. The allowance is computed from that
  // build table, not hand-listed, so it cannot outlive the aliasing.
  assertEquals(
    symbolIssues(
      doc("fixture.md", '```ts\nimport { initStandalone } from "aio";\n```'),
      surface,
      android,
    ),
    [],
  );
});

Deno.test("gate leaves counter-example prose alone but checks fences", async () => {
  const [surface, android] = [await loadSurface(), await loadAndroidAlias()];
  // docs/build/imports.md teaches the server-only boundary by SHOWING the
  // wrong import inline. A fence is what gets copied; prose is where the
  // counter-example lives.
  const prose = '**Wrong:** `import { createDB } from "aio"` in a cell.';
  assertEquals(symbolIssues(doc("fixture.md", prose), surface, android), []);
  const fence = '```ts\nimport { createDB } from "aio";\n```';
  assertEquals(
    symbolIssues(doc("fixture.md", fence), surface, android).length,
    1,
    "createDB moved to aio/server in alpha37 — a fence must not teach the old form",
  );
});

// ── The real tree ─────────────────────────────────────────────────────

Deno.test("check:docs is green on the real docs tree", async () => {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", "scripts/check-docs.ts"],
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout } = await cmd.output();
  const out = new TextDecoder().decode(stdout);
  assertEquals(code, 0, `check:docs failed:\n${out}`);
  assertStringIncludes(out, "Commands in docs: all resolve");
  assertStringIncludes(out, "Symbols in docs: all resolve");
});
