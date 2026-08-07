#!/usr/bin/env -S deno run --allow-read
// check-docs.ts — verify version strings are consistent across all docs
// Usage: deno run --allow-read scripts/check-docs.ts [expected-version]
// Skips changelog.md (historical) and upgrade.md (migration references)

import { walk } from "https://deno.land/std@0.208.0/fs/walk.ts";

const DOCS_DIR = new URL("../docs/", import.meta.url).pathname;
const VERSION_RE = /v(\d+\.\d+\.\d+)/g;
const SKIP_FILES = new Set(["changelog.md", "upgrade.md"]);

async function main(): Promise<void> {
  const expected = Deno.args[0] ?? await detectVersion();
  if (!expected) {
    console.error("Usage: check-docs.ts <version>  (e.g. 0.7.0)");
    Deno.exit(1);
  }

  const issues: string[] = [];
  const seen = new Map<string, string[]>();

  async function checkFile(path: string, label: string): Promise<void> {
    const content = await Deno.readTextFile(path);
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const match of lines[i]!.matchAll(VERSION_RE)) {
        const v = match[1]!;
        const loc = `${label}:${i + 1}`;
        if (!seen.has(v)) seen.set(v, []);
        seen.get(v)!.push(loc);
        if (v !== expected) {
          issues.push(`  ${loc}  found v${v} (expected v${expected})`);
        }
      }
    }
  }

  for await (
    const entry of walk(DOCS_DIR, {
      exts: [".md"],
      maxDepth: 2,
      includeDirs: false,
    })
  ) {
    const basename = entry.path.split("/").pop() ?? "";
    if (SKIP_FILES.has(basename)) continue;
    await checkFile(entry.path, entry.path.replace(DOCS_DIR, ""));
  }

  // Also check README.md at repo root
  try {
    const readmePath = new URL("../../README.md", import.meta.url).pathname;
    await checkFile(readmePath, "README.md");
  } catch { /* not found */ }

  console.log(`Version check: v${expected}`);
  console.log(`Found ${seen.size} version(s) across docs:\n`);
  for (const [v, locs] of [...seen.entries()].sort()) {
    const status = v === expected ? "✓" : "✗";
    console.log(
      `  ${status} v${v}  (${locs.length} occurrence${
        locs.length > 1 ? "s" : ""
      })`,
    );
  }

  // Inline doc references: a `docs/<path>.md` cited in a src/ comment is a
  // promise — every anchor the field followed was accurate, which is why they
  // are trusted (a field report). One dangling ref erodes that, so a
  // citation of a nonexistent page is a hard gate.
  const refIssues = await checkSrcDocRefs();
  console.log(
    `Inline doc refs: ${
      refIssues.length ? `${refIssues.length} dangling` : "all resolve"
    }`,
  );

  // Retired spellings must not survive in LIVE docs. The snippet type-check
  // gate cannot catch these: a deprecated-but-still-working form (the old
  // selector spread signature) type-checks by design, and prose/tables
  // (`call({ timeout })` in an API table) are invisible to it. This is the
  // prose-level complement — a small denylist of spellings the one-vocabulary
  // work retired, hard-gated outside the historical dirs.
  const retiredIssues = await checkRetiredSpellings();
  console.log(
    `Retired spellings: ${
      retiredIssues.length ? `${retiredIssues.length} found` : "none"
    }`,
  );

  // R2.2: every AioErrorCode must be documented in docs/debugging/errors.md, so
  // a new code can never ship without an operator-facing explanation.
  const codeIssues = await checkErrorCodes();
  console.log(
    `\nError-code coverage: ${
      codeIssues.length ? `${codeIssues.length} undocumented` : "all documented"
    }`,
  );

  // Version-string drift is ADVISORY: docs legitimately reference historical
  // versions (migration notes) and example CLI output, so it warns but never
  // gates. Error-code coverage is EXACT, so it is the hard gate.
  if (issues.length) {
    console.log(
      `\nVersion references differing from v${expected} ` +
        `(review — historical/example mentions are expected):\n${
          issues.join("\n")
        }`,
    );
  }
  if (refIssues.length) {
    console.log(
      `\nDangling doc references in src/ (must fix — write the page or fix ` +
        `the path):\n${refIssues.join("\n")}`,
    );
    Deno.exit(1);
  }
  if (codeIssues.length) {
    console.log(
      `\nUndocumented error codes (must fix):\n${codeIssues.join("\n")}`,
    );
    Deno.exit(1);
  }
  if (retiredIssues.length) {
    console.log(
      `\nRetired spellings in live docs (must fix — teach the current ` +
        `vocabulary, or move the page to upgrade/):\n${
          retiredIssues.join("\n")
        }`,
    );
    Deno.exit(1);
  }
  console.log("\n✓ All error codes documented.");
}

/** Spellings the framework retired that live docs must not teach. Each entry
 *  is [pattern, why]. Lines that TALK ABOUT the rename (naming the new
 *  spelling too) are allowed — a migration note is not a stale teaching. */
const RETIRED_SPELLINGS: Array<[RegExp, string]> = [
  [/\bcompile:remote:/, "the compile:remote:* task family → `deno task build`"],
  [/\bdev:remote:/, "the dev:remote:* task family → `deno task dev` + flags"],
  [/\b(?:dev|compile):service\b/, "`service` is spelled `server` (alpha52)"],
  [/\bcall\(\s*\{\s*timeout\s*[,:}?]/, "call()'s `timeout` → `timeoutMs`"],
  [/\{\s*timeout\?,\s*retries\?/, "call()'s `timeout` → `timeoutMs`"],
];

/** Historical dirs may show old APIs on purpose; everything else is live. */
async function checkRetiredSpellings(): Promise<string[]> {
  const issues: string[] = [];
  for await (
    const entry of walk(DOCS_DIR, {
      exts: [".md"],
      includeDirs: false,
      skip: [/\/upgrade\//, /\/specs\//, /\/release-notes\//],
    })
  ) {
    const rel = entry.path.replace(DOCS_DIR, "");
    if (rel === "content.md") continue; // generated index — mirrors sources
    const lines = (await Deno.readTextFile(entry.path)).split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      for (const [re, why] of RETIRED_SPELLINGS) {
        if (!re.test(line)) continue;
        // A line that also carries the NEW spelling (or explicitly talks
        // about migrating off the old one) is a migration note, not teaching.
        if (
          /timeoutMs|--migrate-tasks|deprecated|retired|alpha52|migration/
            .test(line)
        ) {
          continue;
        }
        issues.push(`  ${rel}:${i + 1}  ${why}  →  ${line.trim()}`);
      }
    }
  }
  return issues;
}

/** Every `docs/….md` path mentioned in src/ code must exist on disk. */
async function checkSrcDocRefs(): Promise<string[]> {
  const root = new URL("..", import.meta.url).pathname;
  const issues: string[] = [];
  const seen = new Map<string, string>(); // path → first citing file
  async function walk(dir: string): Promise<void> {
    for await (const e of Deno.readDir(dir)) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) await walk(p);
      else if (e.isFile && /\.(ts|tsx)$/.test(e.name)) {
        const src = await Deno.readTextFile(p);
        for (const m of src.matchAll(/\bdocs\/[\w./-]+\.md/g)) {
          if (!seen.has(m[0])) seen.set(m[0], p.slice(root.length));
        }
      }
    }
  }
  await walk(`${root}src`);
  for (const [ref, file] of seen) {
    try {
      await Deno.stat(`${root}${ref}`);
    } catch {
      issues.push(`  ${ref} (cited in ${file}) does not exist`);
    }
  }
  return issues;
}

/** Assert every `AioErrorCode` value defined in src/error.ts appears in
 *  docs/debugging/errors.md. Returns one message per undocumented code. */
async function checkErrorCodes(): Promise<string[]> {
  const errorTs = await Deno.readTextFile(
    new URL("../src/diagnostics/error.ts", import.meta.url).pathname,
  );
  const union = errorTs.match(/export type AioErrorCode =([\s\S]*?);/);
  if (!union) return ["  could not parse AioErrorCode union from src/error.ts"];
  const codes = [...union[1]!.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]!);
  const errorsMd = await Deno.readTextFile(
    new URL("../docs/debugging/errors.md", import.meta.url).pathname,
  );
  return codes
    .filter((code) => !errorsMd.includes(code))
    .map((code) => `  ${code} is not documented in docs/debugging/errors.md`);
}

async function detectVersion(): Promise<string | undefined> {
  try {
    // Root CHANGELOG.md is the canonical changelog (see .katana/docs.md); its
    // top heading names the current release, e.g. "## 1.0.0-alpha15 — …".
    const changelog = await Deno.readTextFile(
      new URL("../CHANGELOG.md", import.meta.url).pathname,
    );
    const match = changelog.match(/^## v?(\d+\.\d+\.\d+)/m);
    return match?.[1];
  } catch {
    return undefined;
  }
}

main();
