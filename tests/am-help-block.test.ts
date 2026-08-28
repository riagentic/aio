// `am <cmd> --help` / `am help <cmd>` print THAT command's block, not all ~170
// lines. Every --help used to route to the full text, whatever came before.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { cmdHelp, HELP_TEXT, helpBlock } from "../src/am/am-cmd-meta.ts";
import type { GlobalFlags } from "../src/am/am-types.ts";

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

Deno.test("helpBlock: one command's entries with their continuation lines", () => {
  const b = helpBlock(HELP_TEXT, "logs")!;
  assertStringIncludes(b, "  logs [filter]");
  assert(!b.includes("errors "), "the next entry is not part of the block");
  // Several entries for one verb (surface, surface --full, …) all belong.
  const s = helpBlock(HELP_TEXT, "surface")!;
  assertEquals(s.split("\n").filter((l) => /^ {2}surface/.test(l)).length, 5);
  assertEquals(helpBlock(HELP_TEXT, "nonesuch"), null);
});

Deno.test("cmdHelp(['logs']) prints the block, not the whole text", () => {
  const one = capture(() => cmdHelp(["logs"], {} as GlobalFlags, ["logs"]));
  const all = capture(() => cmdHelp([], {} as GlobalFlags, ["logs"]));
  const oneLines = one.out.join("\n").split("\n").length;
  const allLines = all.out.join("\n").split("\n").length;
  assert(oneLines < 10, `one command: ${oneLines} lines`);
  assert(allLines > 100, `full help: ${allLines} lines`);
  assertEquals(one.err, []);
  // A command with no entry of its own, or an unknown word: says so, full
  // text. (alpha70: no verb has an alias any more — `help` itself is the
  // one mapped command without a help entry.)
  const alias = capture(() => cmdHelp(["zzz"], {} as GlobalFlags, ["zzz"]));
  assertStringIncludes(alias.err.join(), "no help entry of its own");
  assert(alias.out.join("\n").split("\n").length > 100);
  const bad = capture(() => cmdHelp(["nonesuch"], {} as GlobalFlags, []));
  assertStringIncludes(bad.err.join(), 'unknown command "nonesuch"');
});
