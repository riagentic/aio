// Every command `am` will run has a help entry — checked against the registry
// itself, not against a hand-kept second list.
//
// `am` has two lists of its commands: the `COMMANDS` map in src/am.ts (what
// runs) and `HELP_TEXT` (what is documented). Nothing tied them, and they had
// already drifted: `am tables` ran fine and `am help tables` answered
// "no help entry of its own — see the full list", which is the framework
// telling a user their correct command does not exist. A verb you can type is
// a verb the help must name.

import { assert, assertEquals } from "@std/assert";
import { HELP_TEXT, helpBlock, helpSummary } from "../src/am/am-cmd-meta.ts";
import { styleWith } from "../src/diagnostics/fmt.ts";

/** The registry keys, read from source — importing src/am.ts would run its CLI. */
async function registeredCommands(): Promise<string[]> {
  const src = await Deno.readTextFile(
    new URL("../src/am.ts", import.meta.url),
  );
  const from = src.indexOf("const COMMANDS");
  const body = src.slice(from, src.indexOf("\n};", from));
  return [...body.matchAll(/^ {2}([a-z][a-zA-Z]*):/gm)].map((m) => m[1]!);
}

Deno.test("am help: every registered command has a help entry", async () => {
  const missing = (await registeredCommands()).filter((c) =>
    c !== "help" && !helpBlock(HELP_TEXT, c)
  );
  assertEquals(
    missing,
    [],
    "these commands run but `am help <cmd>` cannot find them — add an " +
      "entry to HELP_TEXT: " +
      missing.join(", "),
  );
});

Deno.test("am help: the summary lists every command, one line each", async () => {
  const summary = helpSummary(HELP_TEXT, styleWith(false));
  const lines = summary.split("\n");
  const missing = (await registeredCommands()).filter((c) =>
    c !== "help" && !lines.some((l) => new RegExp(`^ {2}${c}\\b`).test(l))
  );
  assertEquals(
    missing,
    [],
    `the compact list drops commands the full text has — the summary is ` +
      `DERIVED from HELP_TEXT, so a miss here is a parse bug, not a doc gap: ` +
      missing.join(", "),
  );
  // The point of the summary: a signature and ONE line each, never a
  // paragraph. Counted rather than merely iterated — a loop that asserts
  // nothing when the list is empty proves nothing about a list.
  const rows = lines.filter((l) => l.startsWith("  ") && l.trim());
  assert(
    rows.length >= 50,
    `expected the whole command list, got ${rows.length} rows`,
  );
  assertEquals(
    rows.filter((l) => l.split(/ {2,}/).filter(Boolean).length > 2),
    [],
    "a summary row is a signature and one description — nothing else",
  );
});
