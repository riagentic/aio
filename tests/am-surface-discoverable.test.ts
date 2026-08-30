// Every am command has to be findable in `am help`.
//
// Four were not: `fix` — the command you run after a git clone, the single most
// load-bearing repair in the tool — plus `link`, `auth` and `report`. They
// worked; nobody could find them. A command that exists and cannot be
// discovered is indistinguishable from a missing feature, and it is worse than
// one: the cost was already paid, and the user still writes the workaround.
import { assert, assertEquals } from "@std/assert";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/** Aliases: the canonical spelling is documented, the alias deliberately is
 *  not — listing both doubles the help for no new capability.
 *
 *  Each one is a word the surface used to spend and no longer needs:
 *    ls → instances · logs → log · new → add
 *    tt → timetravel      (the only abbreviation in a surface that spells out)
 *    tables → sql --tables (one fixed query, not a second command)
 *    update → upgrade      (one verb; the OBJECT says am-itself or an app)
 *    release → publish     (the same act; "publish" names what it produces) */
const ALIASES = new Set([
  "ls",
  "logs",
  "new",
  "tt",
  "tables",
  "update",
  // release → publish (one verb; "publish" is what it does to the channel
  // directory, and it is the word the docs use)
  "release",
]);

async function amCommands(): Promise<string[]> {
  const src = await Deno.readTextFile(`${REPO}/src/am.ts`);
  const table = src.match(/const COMMANDS[^=]*=\s*\{([\s\S]*?)\n\};/)?.[1];
  assert(table, "COMMANDS table not found — did it move?");
  return [...table.matchAll(/^\s{2}([a-z][\w-]*)\s*:/gm)].map((m) => m[1]!);
}

async function helpText(): Promise<string> {
  const p = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", `${REPO}/src/am.ts`, "help"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  return new TextDecoder().decode(p.stdout) +
    new TextDecoder().decode(p.stderr);
}

Deno.test("am: every command appears in `am help`", async () => {
  const help = await helpText();
  const missing: string[] = [];
  for (const cmd of await amCommands()) {
    if (ALIASES.has(cmd)) continue;
    // Word-boundary match: `am` must not be satisfied by "am help" prose, so
    // the command has to appear as its own word at the start of a help line
    // or right after a group's indent.
    const shown = new RegExp(`^\\s{2}${cmd}\\b`, "m").test(help) ||
      new RegExp(`^\\s{2}\\w+ ${cmd}\\b`, "m").test(help);
    if (!shown) missing.push(cmd);
  }
  assertEquals(
    missing,
    [],
    "these commands exist but `am help` never mentions them — a user cannot " +
      `find them:\n  ${missing.join("\n  ")}`,
  );
});

Deno.test("am: help does not advertise commands that do not exist", async () => {
  // The other direction, and the reason this file exists twice over: the first
  // draft of the new help block listed `auth reset` and `auth sessions`, which
  // are not real subcommands. Help that lies is worse than help that is short.
  const help = await helpText();
  const known = new Set(await amCommands());
  const advertised = [...help.matchAll(/^\s{2}([a-z][\w-]*)\b/gm)]
    .map((m) => m[1]!)
    // `am` is the binary, not a subcommand: the footer of the compact list
    // names the command to type next (`am help <command>`), and it sits at the
    // same indent as an entry. Excluded by name so the gate keeps doing its
    // real job — catching an advertised subcommand that does not exist.
    .filter((w) => !["json", "app", "entry", "wait", "am"].includes(w));
  const unknown = [...new Set(advertised)].filter((w) => !known.has(w));
  assertEquals(
    unknown,
    [],
    `help lists commands that are not in COMMANDS:\n  ${unknown.join("\n  ")}`,
  );
});
