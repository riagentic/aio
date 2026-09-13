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
  // The page is ~10k tokens: the whole of aio, once, instead of a docs crawl.
  // Past ~520 lines it stops being one page; under ~300 it cannot carry the
  // API. Raise either bound deliberately, or cut; do not let it drift.
  assert(page < 520, `the page has grown to ${page} lines — cut, or decide`);
  assert(
    page > 300,
    `the page is ${page} lines — too thin to replace the docs`,
  );
  assert(all < 800, `--task=all has grown to ${all} lines`);
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
  assert(rules.split("\n").length <= 14, "the rules stopped being compressed");
  assert(PAGE.indexOf(rules) < 400, "the rules are not at the top of the page");
});
