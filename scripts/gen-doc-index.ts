// gen-doc-index.ts — generate docs/content.md, the master table of contents:
// every doc page with its title and first sentence, grouped by section.
// Generated (never hand-edited) so it CANNOT drift: `deno task update:docs`
// rewrites it, `deno task update:docs -- --check` gates freshness in CI.
import { walk } from "jsr:@std/fs@1/walk";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = `${ROOT}docs/content.md`;

/** Section order + display names. Directories not listed sort last. */
const SECTIONS: [string, string, string][] = [
  ["basics", "Start here", "install, first app, concepts, architecture"],
  ["state", "State — cells", "the core: cells, methods, workflows, scheduling"],
  ["ui", "UI — AIR renderer", "components, signals, routing, forms"],
  ["persistence", "Persistence & sync", "SQLite, CRDT, offline"],
  ["auth", "Auth", "users, tokens, per-user visibility"],
  [
    "testing",
    "Testing",
    "cell tests, semantic UI tests, driving the live app, linter",
  ],
  ["clients", "Clients", "browser, electron, the am manager"],
  ["build", "Build & deploy", "targets, dev mode, imports, scaling"],
  ["debugging", "Debugging & production", "errors, vitals, monitoring"],
  ["examples", "Walkthroughs", "complete apps, start to finish"],
  ["upgrade", "Upgrade guides", "version-to-version migration notes"],
  ["specs", "Design specs", "decision records — background, not manuals"],
];

/** Pages that belong to one section but are indispensable from another.
 *
 *  `am surface` / `am trigger` observe and drive a RUNNING app the same way
 *  `testUI` drives an in-process one — it is the primary dev-loop tool, not an
 *  ops utility, and filing it only under Clients meant people found it after
 *  they needed it. It stays where it is documented; it is listed where
 *  it is looked for. */
const CROSS_LINKS: Record<string, { path: string; note: string }[]> = {
  testing: [{
    path: "clients/app-manager.md",
    note:
      "`am surface` / `am trigger` — observe and drive a RUNNING app, no selectors, no driver: the same loop as `testUI`, against the real thing",
  }],
};

function firstSentence(body: string): string {
  let inFence = false;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (
      !line || line.startsWith("#") ||
      line.startsWith(">") || line.startsWith("|") || line.startsWith("<!--") ||
      line.startsWith("-") || line.startsWith("*")
    ) continue;
    const clean = line
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // strip links
      .replace(/[*_`]/g, "");
    const cut = clean.search(/\.\s|\.$/);
    const s = cut === -1 ? clean : clean.slice(0, cut + 1);
    return s.length > 120 ? s.slice(0, 117) + "…" : s;
  }
  return "";
}

/** A TASK-shaped index, above the domain-shaped one.
 *
 *  The list below is organised the way the docs are WRITTEN — by subject. That
 *  is the right shape once you know the subject exists. Two field reports
 *  navigated 180 files by `grep` and named `CLAUDE.md` as the only door; a
 *  third had its whole architecture decided by `state/real-time.md`, which it
 *  found by accident, four levels down. The question people actually arrive
 *  with is "I want to ___", and nothing answered it.
 *
 *  Curated by hand, deliberately: an auto-generated task list would only
 *  restate whatever the headings happen to say. Kept short — a second index
 *  that lists everything is just the first index again. Every target is
 *  checked by `check:docs`, so a renamed page breaks the gate rather than
 *  rotting here. */
const TASK_INDEX: string[] = [
  "## I want to…",
  "",
  "| I want to…                                   | Read                                                 |",
  "| -------------------------------------------- | ---------------------------------------------------- |",
  "| build my first app                           | [Quickstart](basics/quickstart.md)                   |",
  "| understand what a cell IS                    | [Core concepts](basics/concepts.md)                  |",
  "| know where my code runs (browser? server?)   | [Where code runs](basics/where-code-runs.md)         |",
  "| test my UI without selectors                 | [UI testing](testing/ui-testing.md)                  |",
  "| drive or debug a RUNNING app                 | [`am`](clients/app-manager.md), [agents](AGENTS.md)  |",
  "| stream, or write state many times a second   | [Real-time state](state/real-time.md)                |",
  "| style it, or use the component kit           | [Theme](ui/theme.md), [`aio/ui` kit](ui/README.md)    |",
  "| persist, migrate or back up data             | [Persistence](persistence/README.md)                 |",
  "| sync across clients, or work offline         | [CRDT sync](persistence/crdt.md), [offline](persistence/offline.md) |",
  "| ship desktop, Android or a single binary     | [Targets](build/targets.md)                          |",
  "| see why the browser bundle refuses an import | [Imports](build/imports.md)                          |",
  "| add users, logins or tokens                  | [Auth](auth/auth.md)                                 |",
  "",
];

export async function generate(): Promise<string> {
  const bySection = new Map<
    string,
    { path: string; title: string; desc: string }[]
  >();
  for await (
    const entry of walk(`${ROOT}docs`, { exts: [".md"], includeDirs: false })
  ) {
    const rel = entry.path.slice(`${ROOT}docs/`.length);
    if (rel === "content.md" || rel.startsWith("api-ref/")) continue;
    const section = rel.includes("/") ? rel.split("/")[0]! : "(root)";
    const text = await Deno.readTextFile(entry.path);
    const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim() ??
      rel.split("/").pop()!.replace(".md", "");
    const list = bySection.get(section) ?? [];
    list.push({ path: rel, title, desc: firstSentence(text) });
    bySection.set(section, list);
  }

  const lines: string[] = [
    "# aio documentation — contents",
    "",
    "> GENERATED by `deno task update:docs` — do not edit by hand.",
    "> Every doc page, grouped by section, in reading order.",
    "",
    ...TASK_INDEX,
  ];
  const known = new Set(SECTIONS.map(([d]) => d));
  const order = [
    ...SECTIONS,
    ...[...bySection.keys()].filter((d) => !known.has(d)).sort()
      .map((d) => [d, d, ""] as [string, string, string]),
  ];
  for (const [dir, name, tagline] of order) {
    const docs = bySection.get(dir);
    if (!docs) continue;
    lines.push(`## ${name}${tagline ? ` — ${tagline}` : ""}`, "");
    // READMEs first, then alphabetical
    docs.sort((a, b) =>
      Number(b.path.endsWith("README.md")) -
        Number(a.path.endsWith("README.md")) || a.path.localeCompare(b.path)
    );
    for (const d of docs) {
      lines.push(`- [${d.title}](${d.path})${d.desc ? ` — ${d.desc}` : ""}`);
    }
    for (const x of CROSS_LINKS[dir] ?? []) {
      const title = bySection.get(x.path.split("/")[0]!)
        ?.find((d) => d.path === x.path)?.title ?? x.path;
      lines.push(`- ↗ [${title}](${x.path}) — ${x.note}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const content = await generate();
  if (Deno.args.includes("--check")) {
    const current = await Deno.readTextFile(OUT).catch(() => "");
    if (current !== content) {
      console.error(
        "✗ docs/content.md is stale — run `deno task update:docs` and commit",
      );
      Deno.exit(1);
    }
    console.log("✓ docs/content.md is up to date");
  } else {
    await Deno.writeTextFile(OUT, content);
    console.log(`✓ wrote docs/content.md`);
  }
}
