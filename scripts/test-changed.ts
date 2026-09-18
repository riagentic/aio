#!/usr/bin/env -S deno run -A
/**
 * test-changed.ts — run only the test files that can see what you changed.
 *
 *   deno run -A scripts/test-changed.ts [--base=<git ref>]
 *
 * "Changed" is the working tree against `--base` (default HEAD), plus
 * untracked files. A test file is AFFECTED when it is itself changed, or when
 * any file it imports — followed transitively through relative imports — is
 * changed. The affected files then run through the same sharded runner as
 * the full suite (scripts/test-shards.ts), so this is a subset of the release
 * gate with identical flags, never a different kind of run.
 *
 * It is a tool for the edit loop, not a gate: a test can depend on a file it
 * does not import (a fixture it reads, a script it spawns), and those are
 * invisible here. The full `deno task test` stays the release gate.
 */
import { dirname, join, relative, resolve } from "@std/path";
import { discover } from "./test-shards.ts";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/** Relative import/export/dynamic-import specifiers in a module. Pure. */
export function relativeImports(src: string): string[] {
  const out: string[] = [];
  const re =
    /(?:^|[^\w$.])(?:import|export)\s[^'"`;]*?from\s*["']([^"']+)["']|(?:^|[^\w$.])import\s*\(?\s*["']([^"']+)["']/gm;
  for (const m of src.matchAll(re)) {
    const spec = m[1] ?? m[2];
    if (spec && (spec.startsWith("./") || spec.startsWith("../"))) {
      out.push(spec);
    }
  }
  return out;
}

/** The repo-relative files `file` reaches through relative imports. */
async function closure(
  file: string,
  cache: Map<string, string[]>,
): Promise<Set<string>> {
  const seen = new Set<string>();
  const stack = [file];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    let deps = cache.get(f);
    if (!deps) {
      let text = "";
      try {
        text = await Deno.readTextFile(join(ROOT, f));
      } catch { /* a generated or deleted path — no edges */ }
      deps = relativeImports(text).map((s) =>
        relative(ROOT, resolve(dirname(join(ROOT, f)), s))
      );
      cache.set(f, deps);
    }
    stack.push(...deps);
  }
  return seen;
}

async function git(args: string[]): Promise<string[]> {
  const r = await new Deno.Command("git", { args, cwd: ROOT, stdout: "piped" })
    .output();
  return new TextDecoder().decode(r.stdout).split("\n").filter(Boolean);
}

if (import.meta.main) {
  const base = Deno.args.find((a) => a.startsWith("--base="))?.slice(7) ??
    "HEAD";
  const changed = new Set([
    ...await git(["diff", "--name-only", base]),
    ...await git(["ls-files", "--others", "--exclude-standard"]),
  ]);
  if (changed.size === 0) {
    console.log(`nothing changed against ${base} — nothing to test`);
    Deno.exit(0);
  }
  const tests = await discover(["tests", "amui/src"]);
  const cache = new Map<string, string[]>();
  const affected: string[] = [];
  for (const t of tests) {
    for (const f of await closure(t, cache)) {
      if (changed.has(f)) {
        affected.push(t);
        break;
      }
    }
  }
  if (affected.length === 0) {
    console.log(
      `${changed.size} changed file(s), and no test imports any of them. ` +
        `(A test that READS a file without importing it is invisible here — ` +
        `run \`deno task test\` when in doubt.)`,
    );
    Deno.exit(0);
  }
  console.log(
    `${changed.size} changed file(s) → ${affected.length} of ${tests.length} ` +
      `test files import them`,
  );
  const r = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", join(ROOT, "scripts", "test-shards.ts"), ...affected],
    cwd: ROOT,
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  Deno.exit(r.code);
}
