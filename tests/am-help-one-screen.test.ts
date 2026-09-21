// am-help-one-screen.test.ts — bare `am help` is a SCREEN, not the manual.
//
// The item this pins was reported, marked "already done", and re-checked as
// not done: `helpSummary` did compress every entry to one line, and one line
// × 71 commands is 192 of them. "A claim with no test" — so here is the test.
// It measures the RENDERED output, because that is what a reader gets, and it
// holds the curated list honest against the real command table.
//
// The complement lives in am-help-covers-every-command.test.ts: that one
// proves the FULL list still names every command. A short default is only
// safe while the long one is one flag away, so neither test stands alone.

import { assert, assertEquals } from "@std/assert";
import { EVERYDAY } from "../src/am/am-help-text.ts";
import {
  HELP_TEXT,
  helpBlock,
  helpSummary,
  helpTail,
} from "../src/am/am-cmd-meta.ts";
import { styleWith } from "../src/diagnostics/fmt.ts";

const plain = styleWith(false);

/** What `am help` prints, minus colour: the summary plus the flags tail. */
const bare = (): string =>
  helpSummary(HELP_TEXT, plain, EVERYDAY) + "\n" + helpTail(HELP_TEXT, true);

/** The registry keys, read from source — importing src/am.ts would run its CLI. */
async function registeredCommands(): Promise<string[]> {
  const src = await Deno.readTextFile(new URL("../src/am.ts", import.meta.url));
  const from = src.indexOf("const COMMANDS");
  const body = src.slice(from, src.indexOf("\n};", from));
  return [...body.matchAll(/^ {2}([a-z][a-zA-Z]*):/gm)].map((m) => m[1]!);
}

/** The verb of each rendered entry row, in order. A row is `  <sig>  <desc>`;
 *  a wrapped description continues at the description column, not at 2. */
function rowVerbs(rendered: string): string[] {
  const verbs: string[] = [];
  for (const line of rendered.split("\n")) {
    const m = /^ {2}(\S+)/.exec(line);
    if (m) verbs.push(m[1]!);
  }
  return verbs;
}

Deno.test("am help fits one screen", () => {
  const lines = bare().split("\n").length;
  // A terminal window, not a scrollback. The number is a CEILING with room to
  // add a verb, not a target — if a change pushes past it, the question is
  // which row stopped being everyday, not whether to raise the ceiling.
  assert(
    lines <= 55,
    `bare \`am help\` is ${lines} lines — it has to fit a screen. ` +
      `Trim a verb from EVERYDAY (am-help-text.ts) rather than raising this.`,
  );
});

Deno.test("am help lists every everyday verb, exactly once", () => {
  // The rendered ORDER is the help text's own grouping (Onboard, Build & run,
  // Process, …), not EVERYDAY's array order — a reader wants the verbs where
  // the subject puts them. So this compares the SET, and the "once" is what
  // catches a flag variant (`dev --cdp`) sneaking in as a second `dev` row.
  const rows = rowVerbs(helpSummary(HELP_TEXT, plain, EVERYDAY));
  assertEquals(
    [...rows].sort(),
    [...EVERYDAY].sort(),
    "the rendered rows must be exactly EVERYDAY — none lost, none extra",
  );
  assertEquals(
    rows.length,
    new Set(rows).size,
    `a verb is rendered twice: ${rows.join(" ")}`,
  );
});

Deno.test("every everyday verb is a real command with a help entry", async () => {
  const commands = await registeredCommands();
  // An empty EVERYDAY would make the loop below prove nothing while passing —
  // and an empty one is exactly what a bad edit to am-help-text.ts produces.
  assert(EVERYDAY.length >= 10, `EVERYDAY has ${EVERYDAY.length} verbs`);
  for (const verb of EVERYDAY) {
    assert(
      commands.includes(verb),
      `EVERYDAY names "${verb}", which is not a command in am.ts`,
    );
    assert(
      helpBlock(HELP_TEXT, verb) !== null,
      `EVERYDAY names "${verb}", which has no entry in HELP_TEXT — the ` +
        `summary would print a row with no description`,
    );
  }
});

Deno.test("the everyday tier is a real cut of the full one", () => {
  const all = rowVerbs(helpSummary(HELP_TEXT, plain));
  for (const verb of EVERYDAY) {
    assert(all.includes(verb), `\`am help --commands\` lost "${verb}"`);
  }
  assert(
    all.length > EVERYDAY.length * 2,
    `the full list (${all.length} rows) must be much longer than the ` +
      `everyday one (${EVERYDAY.length}) — otherwise there is no tier`,
  );
});

Deno.test("the brief tail keeps what applies to every command", () => {
  const tail = helpTail(HELP_TEXT, true);
  // The two that are not about one flag: the --json contract (every command
  // takes it) and the Flags: line (which names the rest, so nothing is lost).
  assert(tail.includes("--json:"), "the --json contract must survive");
  assert(tail.includes("Flags:"), "the global flags line must survive");
  assert(
    !/(^|\n)--app:/.test(tail),
    "a paragraph about ONE flag belongs to `am help <command>` / --all",
  );
  // …and the full tail still has it, so nothing was deleted from the text.
  assert(
    /(^|\n)--app:/.test(helpTail(HELP_TEXT)),
    "--all must still explain --app",
  );
});
