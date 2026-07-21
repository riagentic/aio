// Docs stale-terms gate — a denylist of REMOVED APIs and configs that keep
// resurfacing in prose ("docs drift"): Deno.Kv persistence, the pre-v2 cell
// styles (`actions:`/`reduce:`/`machine:`/`generators:`), the feature-era
// composition helpers, dead entry points. Two of these lies shipped in one
// week — the import gates can't see prose, so this one reads it.
//
// docs/upgrade/ and docs/specs/ are historical and intentionally show old
// APIs — they are skipped. Migration prose is legitimate: conditional terms
// (Deno.Kv) pass when the same line says legacy/migrat/removed/history.
import { assert } from "@std/assert";

const ROOT = new URL("..", import.meta.url);

const FENCE_RE =
  /```(?:ts|tsx|typescript|js|jsx|javascript)\b[^\n]*\n[\s\S]*?```/g;

/** Substrings banned ANYWHERE in a doc (prose, code, tables). */
const BANNED_EVERYWHERE: [term: string, reason: string][] = [
  ['"unstable": ["kv"]', "Deno.Kv removed — persistence is SQLite-only"],
  ["--unstable-kv", "Deno.Kv removed — persistence is SQLite-only"],
  ["Deno.openKv", "Deno.Kv removed — persistence is SQLite-only"],
  ["data.kv", "the data.kv surface died with Deno.Kv — use db/table config"],
  ["composeMiddleware", "feature-era API removed — cells compose directly"],
  ["useFeature", "feature-era API removed — import the cell and call methods"],
  ["bindFeature", "feature-era API removed — bindCell / aio.run cells"],
  ["composeFeatures", "feature-era API removed — pass cells to aio.run"],
  ["testFeature", "feature-era API removed — use testCell"],
  ["aio/adapters", "entry point removed — hooks live in aio/air"],
  ["aio/react", "entry point removed — react interop is island() in aio/air"],
  ['"aio/boot"', "entry point removed — boot via aio.run"],
  ["to-v2.md", "renamed — the migration guide is docs/upgrade/restructure.md"],
];

/** Banned only when the term appears on a line WITHOUT migration context —
 * the legacy auto-migration story ("legacy Deno.Kv data migrates…") is real. */
const BANNED_UNLESS_MIGRATION: [term: string, reason: string][] = [
  ["Deno.Kv", "Deno.Kv removed — mention it only as legacy/migration history"],
];
const MIGRATION_CONTEXT = /legacy|migrat|removed|history/i;

/** Cell-config keys banned inside ts/tsx code blocks (prose may name them
 * when explaining the migration). `actions:`+`reduce:` must BOTH appear —
 * `reduce:` alone is a legit perfBudget key. */
const BANNED_CONFIG_KEYS: [re: RegExp, name: string, reason: string][] = [
  [
    /^\s*generators\s*:/m,
    "generators:",
    "removed in v2 — workflows are plain async methods",
  ],
  [
    /^\s*machine\s*:/m,
    "machine:",
    "removed in v2 — guard with a status field, one `if` per method",
  ],
];

async function* markdownFiles(dir: URL): AsyncGenerator<URL> {
  for await (const e of Deno.readDir(dir)) {
    if (
      e.name === "api-ref" || e.name === "node_modules" ||
      e.name === "upgrade" || e.name === "specs"
    ) continue;
    const child = new URL(e.isDirectory ? `${e.name}/` : e.name, dir);
    if (e.isDirectory) yield* markdownFiles(child);
    else if (e.name.endsWith(".md")) yield child;
  }
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

Deno.test("docs never mention removed APIs as if they were current", async () => {
  const files: URL[] = [new URL("README.md", ROOT)];
  for await (const f of markdownFiles(new URL("docs/", ROOT))) files.push(f);
  assert(files.length > 30, "doc walk found too few files — walker broke?");

  const problems: string[] = [];
  for (const file of files) {
    const rel = file.href.slice(ROOT.href.length);
    const text = await Deno.readTextFile(file);

    for (const [term, reason] of BANNED_EVERYWHERE) {
      let at = -1;
      while ((at = text.indexOf(term, at + 1)) !== -1) {
        problems.push(`${rel}:${lineOf(text, at)}: "${term}" — ${reason}`);
      }
    }

    for (const [term, reason] of BANNED_UNLESS_MIGRATION) {
      let at = -1;
      while ((at = text.indexOf(term, at + 1)) !== -1) {
        const start = text.lastIndexOf("\n", at) + 1;
        const end = text.indexOf("\n", at);
        const line = text.slice(start, end === -1 ? undefined : end);
        if (!MIGRATION_CONTEXT.test(line)) {
          problems.push(`${rel}:${lineOf(text, at)}: "${term}" — ${reason}`);
        }
      }
    }

    for (const fence of text.matchAll(FENCE_RE)) {
      const code = fence[0];
      const fenceLine = lineOf(text, fence.index);
      for (const [re, name, reason] of BANNED_CONFIG_KEYS) {
        if (re.test(code)) {
          problems.push(
            `${rel}:${fenceLine}: code block uses \`${name}\` — ${reason}`,
          );
        }
      }
      // actions: + reduce: TOGETHER = a pre-v2 cell config sample.
      if (/^\s*actions\s*:/m.test(code) && /^\s*reduce\s*:/m.test(code)) {
        problems.push(
          `${rel}:${fenceLine}: code block uses \`actions:\` + \`reduce:\` — ` +
            `removed in v2, methods are the one style`,
        );
      }
    }
  }

  assert(
    problems.length === 0,
    `stale term(s) in docs — these APIs are gone; rewrite to the current ` +
      `API or frame as migration history:\n  ${problems.join("\n  ")}`,
  );
});
