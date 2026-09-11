// A test file that mutates the process env at MODULE level poisons every file
// that runs after it.
//
// `deno test` runs the whole suite in one process. A `Deno.env.set(…)` in a
// module body runs once, when that file is imported, and nothing ever puts it
// back — so it is in force for the rest of the run. MEASURED, with a probe file
// whose only job is to print the variable:
//
//   deno test tls-anchor-stability.test.ts probe.test.ts
//     → PROBE AIO_APPS_DIR=/tmp/aio-tls-sandbox-214af7ae5c8d2c09
//   deno test probe.test.ts tls-anchor-stability.test.ts
//     → PROBE AIO_APPS_DIR=<unset>
//
// Two files did it with `AIO_APPS_DIR`, the variable that relocates the entire
// data root, and the sandbox they pointed at is deleted before the files that
// inherit it get there. It cost one real, thoroughly misleading failure:
// `am-instance-isolation.test.ts` spawns `am`, `Deno.Command` merges the parent
// env by default, and `am --instance` yields to an explicit `AIO_APPS_DIR` by
// design — so the flag under test was correctly ignored, the test correctly
// went red, and the cause was three hundred files away.
//
// Inside a test body the same call is fine: the test owns the process for its
// duration and can restore it in a `finally`. `src/testing/env-pin.ts` is the
// spelling that does both for a whole file.
import { assert, assertEquals } from "@std/assert";

const DIRS = ["tests", "tests/sync"] as const;
const SELF = "no-module-level-env-mutation.test.ts";

/** `Deno.env.set(` / `.delete(` at column 0 — i.e. in the module body, not
 *  inside any function, test or block. Indentation is the whole signal: every
 *  legitimate use in this repo sits inside something. */
const MODULE_LEVEL = /^Deno\.env\.(set|delete)\s*\(/m;

async function scan(): Promise<string[]> {
  const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  const bad: string[] = [];
  for (const dir of DIRS) {
    for await (const e of Deno.readDir(`${root}/${dir}`)) {
      if (!e.isFile || !/\.tsx?$/.test(e.name) || e.name === SELF) continue;
      const text = await Deno.readTextFile(`${root}/${dir}/${e.name}`);
      const m = MODULE_LEVEL.exec(text);
      if (!m) continue;
      const line = text.slice(0, m.index).split("\n").length;
      bad.push(`${dir === "tests" ? "" : "sync/"}${e.name}:${line}`);
    }
  }
  return bad.sort();
}

Deno.test("no test file mutates the process env at module level", async () => {
  const bad = await scan();
  assertEquals(
    bad,
    [],
    `these set a process env var when the FILE is imported, so it stays set ` +
      `for every file after them in the same run. Move the pin inside the ` +
      `tests — \`pinnedTest({ VAR: value })\` from src/testing/env-pin.ts ` +
      `wraps a whole file and restores on the way out:\n` +
      bad.map((b) => `  ${b}`).join("\n"),
  );
});

Deno.test("the gate catches the shape it is named for", async () => {
  // Column 0 is caught; anything nested is not. A gate that also fired on the
  // legitimate in-test use would be turned off within a week.
  assert(MODULE_LEVEL.test(`const a = 1;\nDeno.env.set("X", "y");\n`));
  assert(MODULE_LEVEL.test(`Deno.env.delete("X");\n`));
  assert(!MODULE_LEVEL.test(`  Deno.env.set("X", "y");\n`), "indented is fine");
  assert(
    !MODULE_LEVEL.test(
      `Deno.test("t", () => {\n  Deno.env.set("X", "y");\n});`,
    ),
    "inside a test body is fine",
  );
  assert(!MODULE_LEVEL.test(`const x = Deno.env.get("X");\n`), "get is fine");

  // And the walk reaches a real population, so silence means "clean", not
  // "looked at nothing".
  const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  let files = 0;
  for await (const e of Deno.readDir(`${root}/tests`)) {
    if (e.isFile && /\.tsx?$/.test(e.name)) files++;
  }
  assert(files > 500, `the scan saw only ${files} test files`);
});
