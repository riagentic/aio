// Two rules that were louder than they were right.
//
// BOTH ARE THE SAME FAILURE. A tool that contradicts its own documentation, or
// that takes away something the user relies on, does not merely annoy — it
// teaches people to stop reading its output, and the rest of that output is
// load-bearing.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { checkOldWayPerfBudget } from "../aiol/checks.ts";
import { legacyReplacement, migrateTasks } from "../src/am/am-cmd-fix.ts";

type Finding = { level: string; msg: string };

/** Run rule 23 over one synthetic source file. */
function lint(content: string): Finding[] {
  const found: Finding[] = [];
  // deno-lint-ignore no-explicit-any
  const ctx: any = {
    tsFiles: [{ relative: "src/app.ts", name: "app.ts", content }],
    cells: [{ name: "models", methodNames: ["scan", "load"] }],
    report: (level: string, _area: string, msg: string) =>
      found.push({ level, msg }),
    pass: () => {},
  };
  checkOldWayPerfBudget(ctx);
  return found;
}

Deno.test("rule 23: `timeout: 0` is the OLD way and is still reported", () => {
  // The shape that means "forever" — exactly what `long:` replaces, and the
  // one people copy out of the retired example.
  const f = lint(
    `export const cfg = { perfBudget: { methods: { "models:scan": { timeout: 0 } } } };`,
  );
  assertEquals(f.length, 1, "the case the rule exists for went silent");
  assertStringIncludes(f[0]!.msg, 'long: ["scan"]');
});

Deno.test("rule 23: a real NUMBER is the documented right tool, and is SILENT", () => {
  // docs/state/methods.md says a specific ceiling "still works and is the right
  // tool for a specific NUMBER". The rule reported it anyway. One app had ten
  // of sixteen as genuine ceilings on work that is quick by nature — where
  // `long:` would DELETE the limit — so they stayed, and so did ten permanent
  // warnings (llama.master §2).
  for (const ms of ["5000", "250", "60000"]) {
    assertEquals(
      lint(
        `const cfg = { perfBudget: { methods: { "models:scan": { timeout: ${ms} } } } };`,
      ),
      [],
      `timeout: ${ms} is a ceiling, not the old way`,
    );
  }
});

Deno.test("rule 23: a deliberate `timeout: 0` can be acknowledged", () => {
  // It reported directly instead of routing through `isSuppressed`, so there
  // was nowhere to put the acknowledgement — the finding was permanent
  // whatever you did.
  const f = lint(
    `const cfg = {\n` +
      `  // aio-ok: this one really is unbounded and long: would move it\n` +
      `  perfBudget: { methods: { "models:scan": { timeout: 0 } } },\n` +
      `};`,
  );
  assertEquals(f, [], "the marker every other rule honours did nothing here");
});

Deno.test("am fix: a pristine task is KEPT, and the advice names its replacement", () => {
  // Deleting a task someone runs BY NAME is the one irreversible thing
  // `am fix` does. "Pristine" is a fact about the COMMAND — it says nothing
  // about whether `dev:browser` is in the app's README, its CLAUDE.md and
  // everyone's fingers (llama.master §4). The neighbouring check already gets
  // this right for customized tasks ("kept, review manually").
  const current = {
    "dev:browser": "deno run -A src/app.ts --client=browser",
    "dev": "deno run -A src/app.ts",
  };
  const expected = { "dev": "deno run -A src/app.ts", "fmt": "deno fmt" };
  const legacy = [{ "dev:browser": "deno run -A src/app.ts --client=browser" }];
  const m = migrateTasks(current, expected, legacy);
  assert(
    m.deleted.includes("dev:browser"),
    "it must still be REPORTED as superseded",
  );
  assertEquals(
    m.tasks["dev:browser"],
    "deno run -A src/app.ts --client=browser",
    "…and still be in deno.json, with its command intact",
  );
  assert(m.added.includes("fmt"), "the new matrix still arrives");
});

Deno.test("the advice is a command, not a category", () => {
  // "the one vocabulary covers it" is true and useless. What a reader needs is
  // the line to type instead.
  assertEquals(
    legacyReplacement("dev:browser"),
    "deno task dev --client=browser",
  );
  assertEquals(
    legacyReplacement("dev:electron"),
    "deno task dev --client=electron",
  );
  assertEquals(
    legacyReplacement("compile:android"),
    "deno task build --targets=android",
  );
  assertEquals(
    legacyReplacement("dev:remote:cli"),
    "deno task dev --client=cli",
    "the remote: infix is not a target",
  );
  // `service` is the retired spelling of `server` — the advice must use the
  // word that works today.
  assertEquals(
    legacyReplacement("dev:service"),
    "deno task dev --client=server",
  );
  // An unknown shape gets the honest generic answer rather than a guess.
  assertStringIncludes(legacyReplacement("whatever:thing"), "deno task");
});
