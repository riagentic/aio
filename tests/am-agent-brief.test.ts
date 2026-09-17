// `am agent` is the one page a model is most likely to read and least likely
// to check. That makes a wrong line in it worse than a missing one: it sends
// the reader to a dead end with full confidence, and the reader has no reason
// to doubt the CLI's own description of itself.
//
// This file pins the SHAPE of the brief — which commands exist, how `--task`
// slices it, that the default page stands on its own (it starts a new app
// with `am create`, and covers the model, the API, testing, debugging and
// shipping), that the rules protecting the user come first, and the budget.
// tests/am-agent-truth.test.ts pins the FACTS: flags per verb, snippets that
// compile and run, API names, config keys, docs paths.
import { assert, assertEquals } from "@std/assert";
import {
  agentBrief,
  agentsMdScaffold,
  BRIEF_SECTIONS,
  BRIEF_TASKS,
  levelSections,
  minSections,
  pickSections,
} from "../src/am/am-agent-text.ts";

/** The registry keys, read from source — importing src/am.ts runs its CLI. */
async function registeredCommands(): Promise<string[]> {
  const src = await Deno.readTextFile(new URL("../src/am.ts", import.meta.url));
  const from = src.indexOf("const COMMANDS");
  const body = src.slice(from, src.indexOf("\n};", from));
  return [...body.matchAll(/^ {2}([a-z][a-zA-Z]*):/gm)].map((m) => m[1]!);
}

const PAGE = agentBrief({ version: "test" });
const ALL = agentBrief({ version: "test", task: "all" });
const MIN = agentBrief({ version: "test", level: "min" });
const SCAFFOLD = agentsMdScaffold("demo");

/** Every `am <verb>` spelled in a text, deduped. */
function verbsNamed(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(/\bam ([a-z][a-zA-Z]*)/g)].map((m) => m[1]!),
    ),
  ];
}

Deno.test("am agent: every verb the brief names is a real command", async () => {
  const known = await registeredCommands();
  assert(known.length > 20, `command map looks unreadable: ${known.length}`);
  const named = verbsNamed(ALL);
  assert(
    named.length > 50,
    `brief names too few verbs to be the brief: ${named.length}`,
  );
  assertEquals(
    named.filter((v) => !known.includes(v)),
    [],
    `am agent names commands that do not exist`,
  );
});

Deno.test("am agent: the scaffolded AGENTS.md names real commands too", async () => {
  const known = await registeredCommands();
  const named = verbsNamed(SCAFFOLD);
  assert(named.length >= 5, `scaffold names too few verbs: ${named.length}`);
  assertEquals(
    named.filter((v) => !known.includes(v)),
    [],
    `the scaffolded AGENTS.md names commands that do not exist`,
  );
  // It must not undo rule 2: a browser client opens a tab nobody can close.
  assert(
    !SCAFFOLD.includes("--client=browser"),
    "AGENTS.md steers to a browser tab",
  );
  assert(SCAFFOLD.includes("am start --client=server-only"));
});

Deno.test("am agent: the page covers every verb group am offers", async () => {
  // A model that reads only the page must meet (nearly) the whole CLI. The
  // few left to `am help` are the manual/installer ones.
  const known = await registeredCommands();
  const notOnPage = [
    "ui",
    "lab",
    "uninstall",
    "remove",
    "installed",
    "version",
    "help",
  ];
  const page = verbsNamed(PAGE);
  assertEquals(
    known.filter((v) => !page.includes(v) && !notOnPage.includes(v)),
    [],
    "the default page never mentions these verbs",
  );
});

Deno.test("am agent: --task reaches every section, and nothing else", () => {
  assert(BRIEF_SECTIONS.length >= 12, "too few sections to index");
  assertEquals(BRIEF_TASKS, BRIEF_SECTIONS.map((s) => s.slug));
  assertEquals(new Set(BRIEF_TASKS).size, BRIEF_TASKS.length, "duplicate slug");
  for (const s of BRIEF_SECTIONS) {
    const one = agentBrief({ version: "test", task: s.slug });
    assert(one.includes(s.body), `--task=${s.slug} did not print its section`);
    const leaked = BRIEF_SECTIONS.filter((o) =>
      o.slug !== s.slug && one.includes(o.body)
    );
    assertEquals(
      leaked.map((o) => o.slug),
      [],
      `--task=${s.slug} leaked sections`,
    );
  }
  // The historical slugs keep working.
  for (
    const slug of [
      "rules",
      "model",
      "tasks",
      "loop",
      "ui",
      "test",
      "debug",
      "docs",
    ]
  ) {
    assert(BRIEF_TASKS.includes(slug), `--task=${slug} disappeared`);
  }
});

Deno.test("am agent: the default page is the page sections; all is everything", () => {
  const page = BRIEF_SECTIONS.filter((s) => s.page);
  const deep = BRIEF_SECTIONS.filter((s) => !s.page);
  assert(deep.length > 0 && page.length >= 10);
  assertEquals(pickSections(), page);
  assertEquals(pickSections("all"), BRIEF_SECTIONS);
  for (const s of page) assert(PAGE.includes(s.body), `page lacks ${s.slug}`);
  for (const s of deep) {
    assert(!PAGE.includes(s.body), `page leaks deep ${s.slug}`);
  }
  assert(BRIEF_SECTIONS.length >= 10);
  for (const s of BRIEF_SECTIONS) {
    assert(ALL.includes(s.body), `all lacks ${s.slug}`);
  }
  // Page sections come first, so --list and --task=all read in page order.
  assertEquals(BRIEF_SECTIONS.slice(0, page.length), page);
});

Deno.test("am agent: the page stands on its own — it starts a new app with am create", () => {
  const slugs = BRIEF_SECTIONS.filter((s) => s.page).map((s) => s.slug);
  for (
    const must of [
      "rules",
      "model",
      "new",
      "cell",
      "ui",
      "data",
      "test",
      "tasks",
      "debug",
      "ship",
    ]
  ) {
    assert(slugs.includes(must), `the page has no ${must} section`);
  }
  // The build-a-new-app flow sits near the top, right after the model.
  assert(slugs.indexOf("new") <= 2, "the new-app flow is buried");
  for (
    const must of [
      "am create <name>",
      "--template=",
      "am start --client=server-only",
      "deno task test",
      "deno task check",
      "deno task compile",
      "testCell(",
      "testUI(",
      "aio.run(",
      "cell(",
      "DONE =",
    ]
  ) {
    assert(PAGE.includes(must), `the page never says ${must}`);
  }
});

Deno.test("am agent: the brief stays inside its context budget", () => {
  const page = PAGE.split("\n").length;
  const all = ALL.split("\n").length;
  const min = MIN.split("\n").length;
  // The page is ~10k tokens: the whole of aio, once, instead of a docs crawl.
  // Markdown structure (headings, fences, a table) costs lines, so the page
  // runs ~620; past ~700 it stops being one page; under ~300 it cannot carry
  // the API. `--min` is for a small context window: ~250 lines, never past
  // 320, never so thin it drops the three shapes. Raise a bound deliberately,
  // or cut; do not let it drift.
  assert(page < 700, `the page has grown to ${page} lines — cut, or decide`);
  assert(
    page > 300,
    `the page is ${page} lines — too thin to replace the docs`,
  );
  assert(all < 950, `--max has grown to ${all} lines`);
  assert(min < 320, `--min has grown to ${min} lines — it is the SMALL one`);
  assert(min > 150, `--min is ${min} lines — too thin to build with`);
  const wide = ALL.split("\n").filter((l) => [...l].length > 110);
  assertEquals(
    wide,
    [],
    "lines wider than 110 columns wrap badly in a terminal",
  );
});

Deno.test("am agent: the rules that protect the user come FIRST", () => {
  // A model that reads only the top of what it is handed still has to get the
  // destructive habits. Order is load-bearing here, not cosmetic.
  assertEquals(BRIEF_SECTIONS[0]?.slug, "rules");
  const rules = BRIEF_SECTIONS[0]!.body;
  for (
    const must of [
      "pkill",
      "am stop",
      "am instances",
      "--client=server-only",
      "--display=current",
      "am expect",
      "--json",
    ]
  ) {
    assert(rules.includes(must), `the rules section never mentions ${must}`);
  }
  assert(rules.split("\n").length <= 20, "the rules stopped being compressed");
  assert(PAGE.indexOf(rules) < 600, "the rules are not at the top of the page");
  assert(MIN.indexOf(rules) < 600, "…and of the minimal page");
});

Deno.test("am agent --min: the compact renditions, in page order, and nothing deep except the loop", () => {
  const mins = minSections();
  assert(mins.length >= 8, `too few minimal sections: ${mins.length}`);
  // The rules and the model are the same text at every size — a small window
  // still gets the habits that protect the machine, uncompressed.
  assertEquals(mins[0]?.slug, "rules");
  assertEquals(mins[0]?.min, mins[0]?.body);
  assertEquals(mins[1]?.slug, "model");
  // Every min rendition is printed; no full body of a section that HAS a
  // compact form leaks in; a deep section is on the minimal page only when it
  // stands in for a page section (the loop for the verb table).
  for (const s of mins) assert(MIN.includes(s.min!), `--min lacks ${s.slug}`);
  assert(BRIEF_SECTIONS.length >= 12, "no sections to check");
  for (const s of BRIEF_SECTIONS) {
    if (s.min !== undefined && s.min !== s.body) {
      assert(!MIN.includes(s.body), `--min printed the FULL ${s.slug}`);
    }
    if (s.min === undefined) {
      assert(!MIN.includes(s.body), `--min leaks ${s.slug}`);
    }
  }
  assert(
    mins.some((s) => s.slug === "loop"),
    "the loop stands in for am's verb table",
  );
  // The three shapes a small window must hold: a cell, a component, a test.
  for (
    const must of [
      "cell(",
      "export default function App",
      "testCell(",
      "testUI(",
    ]
  ) {
    assert(MIN.includes(must), `--min never shows ${must}`);
  }
  // Page order is preserved on the minimal page.
  const order = mins.map((s) => MIN.indexOf(s.min!));
  assertEquals(
    order,
    [...order].sort((a, b) => a - b),
    "min sections out of page order",
  );
  assertEquals(levelSections("medium").map((x) => x.section), pickSections());
  assertEquals(levelSections("max").map((x) => x.section), pickSections("all"));
});

Deno.test("am agent: Markdown that renders — one H2 per section, fenced code, balanced fences", () => {
  assert(BRIEF_SECTIONS.length >= 12, "no sections to check");
  for (const s of BRIEF_SECTIONS) {
    assert(s.body.startsWith("## "), `${s.slug} does not start with an H2`);
    if (s.min !== undefined) {
      assert(
        s.min.startsWith("## "),
        `${s.slug}.min does not start with an H2`,
      );
    }
    for (const text of [s.body, s.min ?? ""]) {
      const fences = text.split("\n").filter((l) => l.startsWith("```")).length;
      assertEquals(fences % 2, 0, `${s.slug}: unbalanced code fence`);
    }
  }
  // Every snippet is a fenced block headed by its path.
  for (
    const path of [
      "src/app.ts",
      "src/cell.ts",
      "src/App.tsx",
      "tests/notes.test.tsx",
    ]
  ) {
    assert(ALL.includes(`// ${path}`), `no fenced snippet for ${path}`);
  }
  assert(ALL.startsWith("# aio test — AGENT BRIEF"), "the brief has no H1");
});
