// ONE answer to a mistyped flag, and one help text that documents it.
//
// `am` used to have three: `am logs --zzz` refused, `am status --zzz` /
// `am instances --zzz` / `am timeline --zzz` / `am snapshot --zzz` /
// `am top --zzz` silently accepted it, and `am state --zzz` read it as a STATE
// PATH and answered with the value at that path (undefined) — a typo reported
// as an absent value. The flags now live in one table (src/am/am-flags.ts) and
// one gate in `main()` reads it.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  didYouMean,
  GLOBAL_FLAGS,
  PASSTHROUGH,
  unknownFlagError,
  unknownFlags,
  VERB_FLAGS,
} from "../src/am/am-flags.ts";
import { TEMPLATES } from "../src/am/am-help-text.ts";
import {
  cmdHelp,
  HELP_TEXT,
  helpBlock,
  helpSummary,
  helpTail,
} from "../src/am/am-cmd-meta.ts";
import type { GlobalFlags } from "../src/am/am-types.ts";
import { styleWith } from "../src/diagnostics/fmt.ts";

/** The registry keys, read from source — importing src/am.ts would run its CLI. */
async function registeredCommands(): Promise<string[]> {
  const src = await Deno.readTextFile(new URL("../src/am.ts", import.meta.url));
  const from = src.indexOf("const COMMANDS");
  const body = src.slice(from, src.indexOf("\n};", from));
  return [...body.matchAll(/^ {2}([a-z][a-zA-Z]*):/gm)].map((m) => m[1]!);
}

function capture(fn: () => void): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const [l, e] = [console.log, console.error];
  console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => err.push(a.map(String).join(" "));
  try {
    fn();
  } finally {
    console.log = l;
    console.error = e;
  }
  return { out, err };
}

// The structural half: the table cannot fall behind the command map. A verb
// added to `am` with no entry here would silently get NO flag checking — the
// exact hole this replaces, one command at a time.
Deno.test("am flags: every registered command is in the table", async () => {
  const missing = (await registeredCommands()).filter((c) =>
    !(c in VERB_FLAGS) && !(c in PASSTHROUGH)
  );
  assertEquals(
    missing,
    [],
    "these verbs run but no one decided which flags they take — add them to " +
      "VERB_FLAGS (or to PASSTHROUGH, with the reason): " + missing.join(", "),
  );
});

// The behavioural half, over EVERY gated verb rather than the six that were
// measured: a bogus flag is refused, whoever the verb is.
Deno.test("am flags: every gated verb refuses --zzz", () => {
  const verbs = Object.keys(VERB_FLAGS);
  // A loop over an empty table asserts nothing. The table IS the fix, so its
  // size is part of the claim.
  assert(verbs.length >= 40, `the flag table holds ${verbs.length} verbs`);
  // The six the audit measured, by name — a refactor that drops one from the
  // table would otherwise silently un-gate exactly the verbs this is about.
  for (
    const measured of [
      "status",
      "instances",
      "timeline",
      "snapshot",
      "top",
      "state",
    ]
  ) {
    assert(verbs.includes(measured), `${measured} left the table`);
    assertStringIncludes(
      unknownFlagError(measured, ["--zzz"])!,
      `am ${measured}: unknown flag --zzz`,
    );
  }
  const accepted: string[] = [];
  for (const verb of verbs) {
    const err = unknownFlagError(verb, ["--zzz"]);
    if (err === null) accepted.push(verb);
    else assertStringIncludes(err, "unknown flag --zzz");
  }
  assertEquals(accepted, [], `these verbs still swallow --zzz: ${accepted}`);
});

Deno.test("am flags: the gate is exact — globals, own flags, values, `--`", () => {
  // A verb's own flag, in both spellings.
  assertEquals(unknownFlags("surface", ["--full", "--depth=2"]), []);
  assertEquals(unknownFlags("cost", ["--cell=todos", "--keys"]), []);
  // Globals everywhere — the five every scripted caller actually types, by
  // name, and then the whole list (which the named five prove is populated).
  for (const g of ["--app", "--port", "--home", "--json", "--wait"]) {
    assert(GLOBAL_FLAGS.includes(g), `${g} is no longer a global flag`);
    assertEquals(unknownFlags("status", [`${g}=x`]), [], g);
  }
  assert(GLOBAL_FLAGS.length >= 20, `${GLOBAL_FLAGS.length} global flags`);
  for (const g of GLOBAL_FLAGS) {
    assertEquals(unknownFlags("status", [`${g}=x`]), [], g);
  }
  // Another verb's flag is not this verb's.
  assertEquals(unknownFlags("status", ["--keys"]), ["--keys"]);
  // Positionals, negative numbers and the end-of-options marker are not flags.
  assertEquals(unknownFlags("expect", ["count", "eq", "-1"]), []);
  assertEquals(unknownFlags("state", ["--", "--zzz"]), []);
  // A forwarding verb judges nothing — its flags belong to deno / the app.
  assertEquals(unknownFlags("start", ["--env-file=.env", "--expose"]), []);
  assertEquals(unknownFlags("create", ["--template=todo"]), []);
});

Deno.test("am flags: a near miss is named", () => {
  assertEquals(didYouMean("--lnies", "status"), "--lines");
  assertEquals(didYouMean("--jsno", "status"), "--json");
  assertEquals(didYouMean("--dept", "surface"), "--depth");
  assertStringIncludes(
    unknownFlagError("status", ["--lnies=5"])!,
    "did you mean --lines?",
  );
  // Not everything gets a guess — a suggestion three edits away is noise.
  assertEquals(didYouMean("--qqqqqqqq", "status"), null);
});

// `am help <cmd> --json` used to answer with the whole command LIST: the json
// branch ran before the argument was read.
Deno.test("am help <cmd> --json answers about THAT command", () => {
  const one = capture(() =>
    cmdHelp(["logs"], { json: true } as GlobalFlags, ["logs", "status"])
  );
  const doc = JSON.parse(one.out.at(-1)!) as { command: string; help: string };
  assertEquals(doc.command, "logs");
  assertStringIncludes(doc.help, "logs [filter]");
  assert(!doc.help.includes("status "), "one command, not the list");
  // With no argument it is still the list.
  const all = capture(() =>
    cmdHelp([], { json: true } as GlobalFlags, ["logs", "status"])
  );
  assertEquals(
    (JSON.parse(all.out.at(-1)!) as { commands: string[] }).commands,
    ["logs", "status"],
  );
});

// The compact help dropped the global flags entirely: the `--json:` footnote
// and the `Flags:` block sit at column 0, so the summary parser read them as a
// heading and glued their indented continuation onto the `help` entry.
Deno.test("am help: the compact form still documents the global flags", () => {
  const tail = helpTail(HELP_TEXT);
  assertStringIncludes(tail, "--json:");
  assertStringIncludes(tail, "Flags: --app=X");
  const summary = helpSummary(HELP_TEXT, styleWith(false));
  const helpRow = summary.split("\n").find((l) => /^ {2}help\b/.test(l))!;
  assert(
    !helpRow.includes("machine-readable"),
    `the help entry swallowed the --json footnote: ${helpRow}`,
  );
  const printed = capture(() => cmdHelp([], {} as GlobalFlags, ["help"]));
  const text = printed.out.join("\n");
  assertStringIncludes(text, "Flags: --app=X");
  assertStringIncludes(text, "--home: target the instance");
});

// `am help` advertised `--template=counter|todo` while `--template=cli` worked
// and `--template=vue` answered "choose: counter, todo, cli" — a third copy of
// a list that already existed. The copies are gone: TEMPLATES is declared once
// in am-help-text.ts and the help interpolates it, so this can assert the
// rendered text directly instead of reading a source file with a regex to hold
// two declarations equal.
Deno.test("am help: the template list is the one am create accepts", () => {
  assertStringIncludes(
    helpBlock(HELP_TEXT, "create")!,
    `--template=${TEMPLATES.join("|")}`,
  );
});
