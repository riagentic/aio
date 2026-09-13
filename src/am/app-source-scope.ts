/**
 * @module
 * What is THIS app's source — the one answer `am pin`, `am migrate` and aiol
 * share.
 *
 * A field report (report 9 §2b, §4): an app kept a read-only copy of two other
 * projects under `examples/` — 726 MB of vendored third-party source, untracked
 * and excluded from `fmt` in its deno.json. `am pin` walked into it and
 * produced 64 of 66 false "removed API" refusals; aiol hinted "move it under
 * src/", the one thing that must not happen. Each tool drew the line one
 * directory differently, and neither had a way to be told.
 *
 * The app ALREADY says it, in files it already has:
 *
 *   • deno.json `exclude` — not the app's code for every Deno subcommand;
 *   • deno.json `fmt.exclude` — "I do not format this", which nobody says
 *     about their own shipped code;
 *   • `.gitignore` — not part of the repository at all.
 *
 * So this reads those, and nothing new is invented. Deliberately NOT honoured:
 * "untracked in git". A brand-new app before its first commit is entirely
 * untracked, and a scan that skips everything reports a clean bill on code it
 * never read — the silent wrong answer this codebase refuses.
 *
 * The split is the usual one: {@linkcode sourceScopeFrom} is pure (config
 * object + gitignore text in, a decider out) so every rule is pinned by a test
 * without a filesystem; {@linkcode appSourceScope} is the thin reader.
 */

import { globToRegExp, join, relative } from "@std/path";
import { readDenoJson } from "../server/deno-json.ts";

/** Why a path is not the app's code — for a message, e.g. `deno.json fmt.exclude`. */
export type ExcludedBy =
  | "deno.json exclude"
  | "deno.json fmt.exclude"
  | ".gitignore";

/** The decider: is `rel` (relative to the app root, `/`-separated) somebody
 *  else's code? Returns the declaration that says so, or null. */
export interface SourceScope {
  excludedBy(rel: string, isDir: boolean): ExcludedBy | null;
}

/** Directories that are never an app's own source, whatever the app declares:
 *  the framework link, package caches, build output, VCS and tool state. The
 *  union of what `am pin` and `am migrate` each skipped on their own. */
export const NEVER_APP_SOURCE: ReadonlySet<string> = new Set([
  "dep",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "target",
  ".git",
  ".aio",
]);

type Rule = {
  re: RegExp;
  negate: boolean;
  /** Match against the whole relative path (else: any single path segment). */
  anchored: boolean;
  dirOnly: boolean;
  by: ExcludedBy;
};

const isGlob = (s: string) => /[*?[\]{}]/.test(s);

function matcher(pattern: string): RegExp {
  if (isGlob(pattern)) {
    return globToRegExp(pattern, { extended: true, globstar: true });
  }
  const esc = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${esc}$`);
}

/** deno.json's spelling: a path or glob relative to the config's directory,
 *  optionally `!`-negated. `./examples/`, `examples` and `examples/**` all
 *  name the directory. */
function denoRule(entry: string, by: ExcludedBy): Rule | null {
  let p = entry.trim();
  const negate = p.startsWith("!");
  if (negate) p = p.slice(1);
  p = p.replace(/^\.\//, "").replace(/\/\*\*$/, "").replace(/\/+$/, "");
  if (p === "" || p === ".") return null;
  return { re: matcher(p), negate, anchored: true, dirOnly: false, by };
}

/** `.gitignore`'s spelling, the common subset: `name`, `name/` (directories
 *  only), `/name` (root-anchored), a `a/b` path (anchored — git's own rule for
 *  a pattern with an inner slash), globs, and `!` negation. */
function gitRule(line: string): Rule | null {
  let p = line.trim();
  if (p === "" || p.startsWith("#")) return null;
  const negate = p.startsWith("!");
  if (negate) p = p.slice(1);
  const dirOnly = p.endsWith("/");
  p = p.replace(/\/+$/, "").replace(/\/\*\*$/, "");
  const anchored = p.startsWith("/") || p.includes("/");
  p = p.replace(/^\/+/, "");
  if (p === "") return null;
  return { re: matcher(p), negate, anchored, dirOnly, by: ".gitignore" };
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** The decider from what the app declares. Pure. */
export function sourceScopeFrom(
  denoJson: Record<string, unknown> | null,
  gitignore: string | null,
): SourceScope {
  const fmt = denoJson?.fmt as { exclude?: unknown } | undefined;
  const rules: Rule[] = [
    ...strings(denoJson?.exclude).map((e) => denoRule(e, "deno.json exclude")),
    ...strings(fmt?.exclude).map((e) => denoRule(e, "deno.json fmt.exclude")),
    ...(gitignore ?? "").split("\n").map(gitRule),
  ].filter((r): r is Rule => r !== null);

  return {
    excludedBy(rel, isDir) {
      const segs = rel.replaceAll("\\", "/").split("/").filter(Boolean);
      // A rule matches a path when it matches the path or any ancestor —
      // excluding a directory excludes what is under it, so `examples` covers
      // `examples/opencode/src/cell.ts`. The LAST matching rule wins, so a
      // later `!third_party/ours` re-includes what `third_party` excluded
      // (Deno's reading; git would not re-include under an ignored parent, and
      // scanning more is the safe side of that difference).
      let hit: ExcludedBy | null = null;
      for (const r of rules) {
        let matched = false;
        for (let n = 1; n <= segs.length && !matched; n++) {
          if (r.dirOnly && !(n < segs.length || isDir)) continue;
          const subject = r.anchored
            ? segs.slice(0, n).join("/")
            : segs[n - 1]!;
          matched = r.re.test(subject);
        }
        if (matched) hit = r.negate ? null : r.by;
      }
      return hit;
    },
  };
}

/** Read the app's declarations. An unreadable or unparseable deno.json counts
 *  as declaring nothing: scanning MORE is the safe direction for a check whose
 *  miss is an app that explodes at boot, and the config error itself is
 *  reported loudly by every command that needs the config. */
export async function appSourceScope(root: string): Promise<SourceScope> {
  let config: Record<string, unknown> | null = null;
  try {
    config = (await readDenoJson(root))?.config ?? null;
  } catch {
    /* aio-ok: reported by the commands that need the config — see above */
  }
  const gitignore = await Deno.readTextFile(join(root, ".gitignore")).catch(
    () => null,
  );
  return sourceScopeFrom(config, gitignore);
}

/** Every `.ts`/`.tsx` that is the app's own source: never a dot-directory, a
 *  {@linkcode NEVER_APP_SOURCE} directory, or a path the app excludes. */
export async function* appSourceFiles(
  root: string,
  scope?: SourceScope,
): AsyncGenerator<string> {
  const s = scope ?? await appSourceScope(root);
  const walk = async function* (d: string): AsyncGenerator<string> {
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(d));
    } catch {
      return; // aio-ok: an unreadable directory is not a finding for a source scan
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || NEVER_APP_SOURCE.has(e.name)) continue;
      const p = join(d, e.name);
      if (s.excludedBy(relative(root, p), e.isDirectory)) continue;
      if (e.isDirectory) yield* walk(p);
      else if (e.isFile && /\.tsx?$/.test(e.name)) yield p;
    }
  };
  yield* walk(root);
}
