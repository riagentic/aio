// Doc-imports drift gate — kills the "documented import doesn't exist" bug
// class permanently. A random-check round once found FOUR doc code blocks
// importing symbols from the wrong entry (useAio from "aio", isScheduleEffect
// from the wrong module, a PRIVATE helper, …) — copy-pasting the docs threw
// at import time. This test extracts every `import … from "aio…"` inside
// fenced code blocks across docs/, README.md, and CLAUDE.md and asserts each
// named symbol exists in that entry's API snapshot (the same source of truth
// the api:check gate uses).
import { assert } from "@std/assert";

const ROOT = new URL("..", import.meta.url);

type Snapshot = {
  entries: Record<string, { symbols: Record<string, unknown> }>;
};

function loadSnapshot(): Snapshot {
  return JSON.parse(
    Deno.readTextFileSync(new URL("docs/api-snapshot.json", ROOT)),
  );
}

/** "aio" → ".", "aio/air" → "./air", "aio/air/compat" → "./air/compat" */
function specToEntry(spec: string): string {
  return spec === "aio" ? "." : "./" + spec.slice("aio/".length);
}

// Fences marked `ts no-check` are intentional pseudo-imports (e.g. the
// android bundle resolving "aio" to the standalone runtime) — skipped.
const FENCE_RE =
  /```(ts|tsx|typescript|js|jsx|javascript)\b([^\n]*)\n([\s\S]*?)```/g;
const IMPORT_RE =
  /import\s+(type\s+)?(?:([A-Za-z_$][\w$]*)\s*,\s*)?(?:\{([^}]*)\}|([A-Za-z_$][\w$]*)|\*\s+as\s+[A-Za-z_$][\w$]*)?\s*from\s*["'](aio(?:\/[\w./-]+)?)["']/g;

async function* markdownFiles(dir: URL): AsyncGenerator<URL> {
  for await (const e of Deno.readDir(dir)) {
    // upgrade guides intentionally show OLD (removed) APIs in before/after
    // blocks — checking them against today's surface is meaningless.
    if (
      e.name === "api-ref" || e.name === "node_modules" || e.name === "upgrade"
    ) continue;
    const child = new URL(
      e.isDirectory ? `${e.name}/` : e.name,
      dir,
    );
    if (e.isDirectory) yield* markdownFiles(child);
    else if (e.name.endsWith(".md")) yield child;
  }
}

Deno.test("every aio import in doc code blocks names a real exported symbol", async () => {
  const snap = loadSnapshot();
  const problems: string[] = [];

  const files: URL[] = [
    new URL("README.md", ROOT),
    new URL("CLAUDE.md", ROOT),
  ];
  for await (const f of markdownFiles(new URL("docs/", ROOT))) files.push(f);
  assert(files.length > 30, "doc walk found too few files — walker broke?");

  let checkedImports = 0;
  for (const file of files) {
    let text: string;
    try {
      text = await Deno.readTextFile(file);
    } catch {
      continue;
    }
    const rel = file.href.slice(ROOT.href.length);
    for (const fence of text.matchAll(FENCE_RE)) {
      if (fence[2]!.includes("no-check")) continue;
      const code = fence[3]!;
      for (const im of code.matchAll(IMPORT_RE)) {
        const [, , defaultName, named, bareDefault, spec] = im;
        const entryKey = specToEntry(spec!);
        // jsx-runtime is compiler plumbing (no hand-written imports expected);
        // unknown entries are themselves a finding.
        const entry = snap.entries[entryKey];
        if (!entry) {
          problems.push(`${rel}: import from "${spec}" — no such entry point`);
          continue;
        }
        checkedImports++;
        const names: string[] = [];
        if (named) {
          for (const part of named.split(",")) {
            const clean = part.trim().replace(/^type\s+/, "");
            if (!clean) continue;
            names.push(clean.split(/\s+as\s+/)[0]!.trim());
          }
        }
        // Default imports from aio entries don't exist (no default exports) —
        // except doc pseudo-code importing an app's own App; only flag when
        // the specifier is an aio entry.
        if (defaultName || bareDefault) {
          problems.push(
            `${rel}: default import "${
              defaultName ?? bareDefault
            }" from "${spec}" — aio entries have no default export`,
          );
        }
        for (const n of names) {
          if (!(n in entry.symbols)) {
            problems.push(`${rel}: "${n}" is not exported from "${spec}"`);
          }
        }
      }
    }
  }

  assert(
    checkedImports > 50,
    `only ${checkedImports} imports checked — regex broke?`,
  );
  assert(
    problems.length === 0,
    `doc code block(s) import symbols that don't exist — copy-pasting these ` +
      `docs throws at import time:\n  ${problems.join("\n  ")}\n` +
      `fix the doc, or api:update if the export genuinely changed.`,
  );
});
