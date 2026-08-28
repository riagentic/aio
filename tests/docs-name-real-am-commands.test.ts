// Every `am <verb>` a doc teaches must be a verb `am help` DOCUMENTS.
//
// The existing doc gate (scripts/check-docs.ts) checks verbs against the
// COMMANDS map. Until alpha70 that map also held aliases (`update`, `new`,
// `ls`, `log`, `tt`, `release`), so a doc could teach a spelling `am help`
// never shows: docs/basics/quickstart.md said `am update` where the help text
// says `am upgrade`. alpha70 dropped the aliases (they answer with the new
// spelling, exit 1 — src/state/removals.ts); the documented surface is the
// help text; docs must spell what it spells.
import { assert, assertEquals } from "@std/assert";
import { walk } from "https://deno.land/std@0.208.0/fs/walk.ts";
import { HELP_TEXT } from "../src/am/am-cmd-meta.ts";
import { commandIssues, loadTaskNames } from "../scripts/check-docs.ts";

const ROOT = new URL("../", import.meta.url).pathname;

/** The verbs the help text documents: the first word of each entry line, plus
 *  every `am <word>` its prose names (short spellings such as `am tt`). */
export function helpVerbs(text: string): Set<string> {
  const verbs = new Set<string>();
  for (const m of text.matchAll(/^ {2}([a-z][\w-]*)/gm)) verbs.add(m[1]!);
  for (const m of text.matchAll(/\bam ([a-z][\w-]*)/g)) verbs.add(m[1]!);
  return verbs;
}

Deno.test("help documents the verbs the docs teach", async () => {
  const verbs = helpVerbs(HELP_TEXT);
  assert(verbs.has("upgrade") && verbs.has("surface"), "help parse works");
  assert(verbs.has("logs") && verbs.has("timetravel"), "the one spelling");
  for (const gone of ["new", "update", "ls", "log", "tt", "release"]) {
    assert(
      !verbs.has(gone),
      `\`${gone}\` is a dropped alias — help must not teach it`,
    );
  }
  const tasks = await loadTaskNames();
  const docs: { rel: string; lines: string[] }[] = [];
  for await (
    const e of walk(`${ROOT}docs`, { exts: [".md"], includeDirs: false })
  ) {
    const rel = e.path.replace(ROOT, "");
    // Dated specs, release notes and upgrade guides are history — they quote
    // the spellings that were retired. A guide teaches the current one.
    if (
      rel.startsWith("docs/specs/") || rel.startsWith("docs/release-notes/") ||
      rel.startsWith("docs/upgrade/")
    ) continue;
    if (/\/(changelog|upgrade)\.md$/.test(rel)) continue;
    docs.push({
      rel,
      lines: (await Deno.readTextFile(e.path)).split("\n"),
    });
  }
  docs.push({
    rel: "README.md",
    lines: (await Deno.readTextFile(`${ROOT}README.md`)).split("\n"),
  });
  const issues = commandIssues(docs, verbs, tasks).filter((i) =>
    i.includes("is not an am verb")
  );
  assertEquals(issues, [], "docs must spell the verb `am help` documents");
});
