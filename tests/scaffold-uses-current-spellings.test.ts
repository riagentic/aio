// A scaffold that writes a RETIRED spelling ships a broken app on day one.
//
// Flags are refused rather than degraded — argv is read before anything boots
// — so a generated task carrying a removed flag would fail on a fresh app's
// very first run, with a refusal naming a flag the user never typed. Nothing
// else catches it: the removal sweeps read `src/`, not the strings the
// scaffolder emits, and no test runs a generated task.
//
// The registry already knows every retired flag, so the live scaffold is held
// to it directly — the same shape as `am pin`'s preflight, pointed at the one
// source of tasks a user never wrote themselves.
//
// `legacyStandardTasks` is deliberately NOT checked. It records what the
// pre-alpha52 scaffold emitted, kept so `am fix --migrate-tasks` can tell a
// pristine old task from a user-customized one and rewrite it. Its strings
// must keep the OLD spellings, retired flags included: "correcting" them would
// make the migration stop recognizing the tasks it exists to upgrade, and the
// retired flag would then survive in real projects. This test was written
// after nearly making that edit.

import { assert, assertEquals } from "@std/assert";
import { standardTasks, TARGETS, TEMPLATES } from "../src/am/am-cmd-create.ts";
import { REMOVALS } from "../src/state/removals.ts";

const retiredFlags = REMOVALS.filter((r) => r.kind === "cli-flag").map((r) =>
  r.key
);

Deno.test("scaffold: no generated task uses a retired flag", () => {
  // Guard on the guard: an emptied registry or template list would make every
  // assertion below vacuous.
  assert(
    retiredFlags.length >= 4,
    `the registry lists ${retiredFlags.length} retired flags — expected at ` +
      `least the alpha76 set`,
  );
  assert(TEMPLATES.length >= 3, `only ${TEMPLATES.length} templates`);
  assert(TARGETS.length >= 5, `only ${TARGETS.length} targets`);

  let checked = 0;
  const seen = new Set<string>();
  for (const template of TEMPLATES) {
    for (const target of TARGETS) {
      for (const source of [true, false]) {
        const tasks = standardTasks(source, target, template);
        for (const [name, line] of Object.entries(tasks)) {
          checked++;
          seen.add(name);
          for (const flag of retiredFlags) {
            // Word-boundary: `--server-url=<url>` is a DIFFERENT, current
            // spelling from the bare `--server-url` that was retired, and a
            // substring match would condemn it.
            const bare = new RegExp(`${flag}(?![=\\w-])`);
            assertEquals(
              bare.test(line),
              false,
              `template "${template}" target "${target}" task "${name}" uses ` +
                `the retired ${flag}:\n  ${line}\n` +
                `A scaffolded app fails on its first run.`,
            );
          }
        }
      }
    }
  }

  // The sweep must have reached the real task set.
  for (const must of ["dev", "build", "compile", "test", "am"]) {
    assert(
      seen.has(must),
      `the sweep never saw "${must}" — standardTasks changed shape and this ` +
        `test is checking nothing`,
    );
  }
  assert(checked > 100, `only ${checked} task lines checked`);
  assert(seen.size >= 12, `only ${seen.size} distinct task names`);
});
