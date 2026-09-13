// The CI recipe has to stay TRUE, or it is worse than no recipe.
//
// A copy-pasteable workflow (report 5 §8.9) is read once and then trusted for
// years. Every line of it is a claim about this repo — that a task exists,
// that it runs both halves, that a version floor is what aio actually
// requires — and each one rots silently the day someone renames something.
//
// So the claims are checked against their sources, not against a memory of
// them.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { MIN_DENO } from "../src/server/deno-version.ts";
import { standardTasks } from "../src/am/am-cmd-create.ts";

const DOC = await Deno.readTextFile(
  new URL("../docs/build/ci.md", import.meta.url),
);

Deno.test("every task the workflow runs is one the scaffold creates", () => {
  const tasks = standardTasks(false, "browser") as Record<string, string>;
  const run = [...DOC.matchAll(/- run: deno task ([a-z:]+)/g)].map((m) =>
    m[1]!
  );
  assert(run.length >= 5, `only ${run.length} task invocations in the recipe`);
  const distinct = [...new Set(run)];
  assert(distinct.length >= 4, `only ${distinct.length} distinct tasks`);
  for (const t of distinct) {
    assert(
      t in tasks,
      `the recipe runs \`deno task ${t}\`, which the scaffold does not create ` +
        `— it creates: ${Object.keys(tasks).join(", ")}`,
    );
  }
});

Deno.test("the pinned Deno version is aio's actual floor", () => {
  const pins = [...DOC.matchAll(/deno-version: "([^"]+)"/g)].map((m) => m[1]!);
  assert(pins.length > 0, "the workflow pins no Deno version");
  const floor = MIN_DENO.split(".").slice(0, 2).join(".");
  for (const p of pins) {
    assert(
      p === floor || p === MIN_DENO,
      `the recipe pins Deno ${p}; aio's floor is ${MIN_DENO}. A recipe that ` +
        `pins below the floor fails on the first run, and one that pins above ` +
        `it silently stops testing the version aio claims to support`,
    );
  }
});

Deno.test("the two-halves claims match the tasks they describe", () => {
  // The whole reason the page exists: `deno check` and `deno lint` on their
  // own are green on the failure modes aio is most often reported for.
  const tasks = standardTasks(false, "browser") as Record<string, string>;
  assertStringIncludes(tasks.check!, "deno check");
  assertStringIncludes(tasks.check!, "am check");
  assertStringIncludes(tasks.lint!, "deno lint");
  assertStringIncludes(tasks.lint!, "aiol");
  assertStringIncludes(DOC, "deno check src/ tests/ && am check");
  assertStringIncludes(DOC, "deno lint src/ && aiol");
});

Deno.test("it says what a headless runner cannot do", () => {
  // The two exceptions are the part a reader acts on at 2am, and both were
  // learned the expensive way.
  assertStringIncludes(DOC, "xvfb-run");
  assert(
    /Electron tests need a display/i.test(DOC),
    "a switch cannot substitute for a display — the recipe has to say so",
  );
  assertStringIncludes(DOC, "deno.lock");
});
