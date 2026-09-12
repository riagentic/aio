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
  [
    "release-notes",
    "Release notes",
    "the alpha19–29 long-form notes; since then the CHANGELOG entry is the note",
  ],
];

/** Directories (and the docs root) whose pages are filed under another
 *  section's heading. Two root pages are "start here" material and `deploy/`
 *  is the second half of "build". Without this they fell through to bare
 *  `## (root)` / `## deploy` headings at the very end of the index. */
const HOMED: Record<string, string> = {
  "(root)": "basics",
  deploy: "build",
};

/** Sections FOLDED behind their own README: the index shows the README, the
 *  newest few entries, and a count — not every page.
 *
 *  Upgrade guides are one page per release, 77 of them and counting; release
 *  notes are the alpha19–29 era's, before the CHANGELOG became the release
 *  note. Listed flat they were 85 of ~270 index lines — a third of the
 *  contents page given to history nobody reads top-down. The pages stay
 *  (they are the migration record); the README in each folder lists every
 *  one, and `update:docs` regenerates that list too so it cannot drift. */
const FOLDED: Record<string, { newest: number }> = {
  upgrade: { newest: 3 },
  "release-notes": { newest: 0 },
};

/** Newest-first rank of a guide or note by the release it targets.
 *  `from-alpha76-to-alpha77.md` → alpha77; `RELEASE_NOTES-v1.0.0-alpha28.md`
 *  → alpha28; the beta line by its triple. Non-release pages (README,
 *  restructure) rank lowest and keep their place at the top by name. */
function releaseRank(path: string): number {
  const name = path.split("/").pop()!.replace(/\.md$/, "");
  const target = name.startsWith("from-")
    ? name.slice(name.lastIndexOf("-to-") + 4)
    : name.replace(/^RELEASE_NOTES-/, "");
  const m = /^v?(?:(\d+)\.(\d+)(?:\.(\d+))?)?-?(alpha|beta|rc)?(\d*)$/.exec(
    target,
  );
  if (!m || (!m[1] && !m[4])) return -1;
  const tier = { alpha: 0, beta: 1, rc: 2 }[m[4] ?? ""] ?? 3;
  const ma = Number(m[1] ?? "1"), mi = Number(m[2] ?? "0");
  const pa = Number(m[3] ?? "0");
  return (((ma * 1000 + mi) * 1000 + pa) * 4 + tier) * 1000 +
    Number(m[5] || 0);
}

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

/** Rewrite the generated block of a folded section's README — everything
 *  between the two marker comments — with every page, newest first. The prose
 *  around the markers is hand-written and untouched. `--check` compares
 *  instead of writing, exactly like content.md. */
async function writeFoldedList(
  readmeRel: string,
  pages: { path: string; title: string; desc: string }[],
): Promise<void> {
  const file = `${ROOT}docs/${readmeRel}`;
  const text = await Deno.readTextFile(file);
  const START = "<!-- generated:start (deno task update:docs) -->";
  const END = "<!-- generated:end -->";
  const a = text.indexOf(START), b = text.indexOf(END);
  const dir = readmeRel.slice(0, readmeRel.lastIndexOf("/") + 1);
  if (a < 0 || b < 0 || b < a) {
    // A HAND-WRITTEN list (upgrade/README.md curates one line per guide —
    // "nothing breaks" / "breaks" — which no generator can write). Then the
    // contract is coverage: every page in the folder is linked from it, or
    // this fails loud. Written-but-unlinked is the failure mode a folded
    // section makes possible, and the index is the only place that can see it.
    const missing = pages.filter((p) =>
      !text.includes(p.path.slice(dir.length))
    );
    if (missing.length > 0) {
      throw new Error(
        `docs/${readmeRel} does not link ${missing.length} page(s) in its ` +
          `folder — add them (it is the only index a folded section has): ` +
          missing.map((p) => p.path.slice(dir.length)).join(", "),
      );
    }
    return;
  }
  // Title only, no first sentence: `deno fmt` re-wraps a long list item, and
  // a generated block that fmt rewrites can never pass its own `--check`.
  const body = pages.map((p) => `- [${p.title}](${p.path.slice(dir.length)})`)
    .join("\n");
  // Blank lines around the list: that is how `deno fmt` lays a list after an
  // HTML comment, and the generated block must already be what fmt would emit.
  const next = `${text.slice(0, a + START.length)}\n\n${body}\n\n${
    text.slice(b)
  }`;
  if (next === text) return;
  if (Deno.args.includes("--check")) {
    console.error(
      `✗ docs/${readmeRel} generated list is stale — run \`deno task update:docs\``,
    );
    Deno.exit(1);
  }
  await Deno.writeTextFile(file, next);
}

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
    const section = HOMED[rel.includes("/") ? rel.split("/")[0]! : "(root)"] ??
      (rel.includes("/") ? rel.split("/")[0]! : "(root)");
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
    const fold = FOLDED[dir];
    if (fold) {
      const readme = docs.find((d) => d.path.endsWith("README.md"));
      const rest = docs.filter((d) => d !== readme && releaseRank(d.path) >= 0)
        .sort((a, b) => releaseRank(b.path) - releaseRank(a.path));
      const other = docs.filter((d) => d !== readme && releaseRank(d.path) < 0);
      if (readme) {
        lines.push(
          `- [${readme.title}](${readme.path}) — every one, newest first` +
            ` (${rest.length} ${rest.length === 1 ? "page" : "pages"})`,
        );
      }
      for (const d of rest.slice(0, fold.newest)) {
        lines.push(`- [${d.title}](${d.path})${d.desc ? ` — ${d.desc}` : ""}`);
      }
      for (const d of other) {
        lines.push(`- [${d.title}](${d.path})${d.desc ? ` — ${d.desc}` : ""}`);
      }
      if (readme) await writeFoldedList(readme.path, rest);
    } else {
      for (const d of docs) {
        lines.push(`- [${d.title}](${d.path})${d.desc ? ` — ${d.desc}` : ""}`);
      }
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
