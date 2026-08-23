// Task names read verb-first, always.
//
// The surface had grown two grammars: `test:core`, `lint:aio`, `check:graph`,
// `dev:electron` (verb first, qualifier second) alongside `api:check`,
// `docs:check`, `release:check`, `coverage:check` (reversed). Both are
// defensible in isolation; together they are something to remember, and the
// person typing has to recall which half of the name comes first for THIS
// command. A reversed name is not a small thing — it is a second grammar.
//
// The rule, and this test:
//
//   • a bare verb is the default instance      `check`, `test`, `dev`
//   • `verb:qualifier` is a specific instance  `check:api`, `test:core`
//   • the qualifier NEVER leads                (never `api:check`)
//
// For an app's scaffolded tasks the qualifier is narrower still: it is a TARGET
// name, so the suffix vocabulary is one closed set (`dev:electron`,
// `compile:android`, `install:electron`, `install:android`).
import { assert, assertEquals } from "@std/assert";
import { standardTasks } from "../src/am/am-cmd-create.ts";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/** Verbs a task name may lead with. Adding one is a deliberate act: it widens
 *  the vocabulary every reader has to hold. */
const VERBS = new Set([
  "bench",
  "build",
  "check",
  // `clean:tmp` — stop orphaned test apps, remove ownerless temp homes and
  // stale lock dirs. "clean" is the verb every build tool uses for it.
  "clean",
  // `fmt` is the verb Deno (and Go before it) uses for "format", and
  // `deno task fmt` was the one gate in the release kata with no task behind
  // it — a gap people tripped over, and a grammar hole: every other gate is a
  // task. Widening the vocabulary by one word is the smaller cost.
  "fmt",
  "compile",
  "dev",
  "discover",
  "example",
  "install",
  "lab",
  "lint",
  "ship",
  "soak",
  "test",
  "update",
  "validate",
]);

/** Bare names that are TOOLS, not actions — `deno task am status` runs a
 *  program whose own first argument is the verb. A tool may not take a
 *  qualifier: `am:something` would be a third grammar. */
const TOOLS = new Set(["am", "amui", "doctor", "docs", "preflight"]);

function taskNames(json: string): string[] {
  const parsed = JSON.parse(json) as { tasks?: Record<string, unknown> };
  return Object.keys(parsed.tasks ?? {});
}

Deno.test("tasks: the framework's own task names lead with a verb", async () => {
  const names = taskNames(await Deno.readTextFile(`${REPO}/deno.json`));
  assert(names.length > 10, "task list looks empty — did the parse break?");
  const reversed: string[] = [];
  for (const name of names) {
    const [head, ...rest] = name.split(":");
    if (rest.length === 0) {
      if (!VERBS.has(head!) && !TOOLS.has(head!)) {
        reversed.push(`${name} (bare name is neither a known verb nor a tool)`);
      }
      continue;
    }
    if (TOOLS.has(head!)) {
      reversed.push(
        `${name} (a tool takes its verb as an ARGUMENT, not a suffix)`,
      );
    } else if (!VERBS.has(head!)) {
      reversed.push(
        `${name} → did you mean ${rest.join(":")}:${head}? the verb leads`,
      );
    }
  }
  assertEquals(
    reversed,
    [],
    `task names must read verb-first:\n  ${reversed.join("\n  ")}`,
  );
});

Deno.test("tasks: a scaffolded app's qualified tasks are qualified by TARGET", () => {
  // The app-facing set is the one a user types every day, so its suffix
  // vocabulary is deliberately narrower than the framework's: the qualifier is
  // always the target the task acts on.
  const TARGETS = new Set([
    "browser",
    "electron",
    "android",
    "cli",
    "server",
  ]);
  const bad: string[] = [];
  for (const target of ["browser", "electron", "android", "cli", "server"]) {
    const tasks = standardTasks(false, target as "browser");
    for (const name of Object.keys(tasks)) {
      const [head, ...rest] = name.split(":");
      if (rest.length === 0) continue;
      if (!VERBS.has(head!)) bad.push(`${name} (verb must lead)`);
      else if (!TARGETS.has(rest.join(":"))) {
        bad.push(`${name} (qualifier "${rest.join(":")}" is not a target)`);
      }
    }
  }
  assertEquals(
    [...new Set(bad)],
    [],
    `scaffolded task names must be verb:target:\n  ${bad.join("\n  ")}`,
  );
});

Deno.test("tasks: the scaffold stays on a diet", () => {
  // Every task is something a reader has to skim past to find the one they
  // want. alpha52 deleted the per-target explosion (dev:browser, dev:electron,
  // compile:remote:cli, …) on purpose; this keeps it deleted.
  for (const target of ["browser", "electron", "android", "cli", "server"]) {
    const tasks = Object.keys(standardTasks(false, target as "browser"));
    assert(
      tasks.length <= 12,
      `${target}: ${tasks.length} scaffolded tasks — the diet was 10 ` +
        `(${tasks.join(", ")})`,
    );
  }
});
