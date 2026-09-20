/**
 * @module
 * `am migrate` — what THIS app has to change to move forward.
 *
 * A field report (report 1 §22.7) asked for `am migrate --from=alpha76`. The
 * machinery for it already existed and had no front door: `REMOVALS` carries
 * every retired spelling with its hint and its upgrade guide, `removalsInSource`
 * finds them in real source, and `aiol --safe-fix` rewrites the ones that can
 * be rewritten. What was missing was one command that runs them over the app in
 * front of you and answers the question people actually ask.
 *
 * WHY IT SCANS RATHER THAN LISTS. "Everything removed since alpha76" is a
 * changelog, and the changelog already exists. The useful answer is the
 * intersection with YOUR code — usually far shorter, and always actionable.
 * An app that uses none of it gets told so in one line, which is the most
 * common and most reassuring outcome.
 *
 * `--from` narrows the registry to what was removed AFTER that release, so an
 * app already on 1.0.0-beta is not shown alpha27's restructure. Omitted, it is read
 * from the app's own pin, because the version the app is actually on is a fact
 * the tool can look up and a person has to remember.
 */
import { relative } from "@std/path";
import { parseVersion } from "./am-versions.ts";
import type { GlobalFlags } from "./am-types.ts";
import { detectMode, fail, out } from "./am-output.ts";
import {
  isFixturePath,
  type Removal,
  REMOVALS,
  removalsInFile,
} from "../state/removals.ts";
import { appSourceFiles } from "./app-source-scope.ts";
import { DENO_JSON_NAMES, readFrameworkPinSync } from "../server/deno-json.ts";

/** Order a release series so `--from` can mean "after this".
 *
 *  The vocabulary is `alpha<N>` / `beta<N>` / a bare release. Anything this
 *  cannot read sorts LAST, so an unrecognised `--from` shows everything rather
 *  than silently hiding rows — a migration tool that under-reports is worse
 *  than one that over-reports, because the app boots and then explodes. */
export function seriesRank(series: string): number {
  // ONE ORDERING (am-versions.ts): the bare series (`alpha27`, `beta`) is the
  // tagged release with its `1.0.0-` prefix elided, and everything else is a
  // version string. From 1.0.0-beta on a release is `MAJOR.MINOR.PATCH-beta`
  // (no digit after the word) until the suffix is dropped, so the rank has to
  // be the version order itself, not a hand-rolled tier table keyed on `\d+`
  // — that table read `1.0.1-beta` as "unknown" and showed EVERY removal.
  const s = series.trim().toLowerCase();
  const v = parseVersion(/^(alpha|beta|rc)\d*$/.test(s) ? `1.0.0-${s}` : s);
  if (!v) return Number.MAX_SAFE_INTEGER;
  const tier = v.pre === ""
    ? 3
    : { alpha: 0, beta: 1, rc: 2 }[v.pre as "alpha"] ?? 0;
  return (((v.major * 1000 + v.minor) * 1000 + v.patch) * 4 + tier) * 1000 +
    Math.min(v.preNum, 999);
}

/** Removals that landed AFTER `from`. No `from` = all of them. */
export function removalsAfter(from: string | undefined): Removal[] {
  if (!from) return [...REMOVALS];
  const floor = seriesRank(from);
  if (floor === Number.MAX_SAFE_INTEGER) return [...REMOVALS];
  return REMOVALS.filter((r) => seriesRank(r.removedIn) > floor);
}

export type MigrateFinding = {
  /** A test or fixture path: the old spelling is probably deliberate there. */
  fixture: boolean;
  file: string;
  line: number;
  key: string;
  removedIn: string;
  hint: string;
  guide: string;
  /** A RENAME, so `aiol --safe-fix` can rewrite it (the registry carries the
   *  new spelling in `now`). */
  fixable: boolean;
  text: string;
};

/** Scan `root` for retired spellings removed after `from`. */
export async function scanMigrations(
  root: string,
  from: string | undefined,
): Promise<MigrateFinding[]> {
  const wanted = new Set(removalsAfter(from).map((r) => r.key));
  const found: MigrateFinding[] = [];
  // The same scope `am pin` reads (app-source-scope.ts): never deps or build
  // output, never what the app declares is not its code.
  for await (const file of appSourceFiles(root)) {
    let text: string;
    try {
      text = await Deno.readTextFile(file);
    } catch {
      continue; // aio-ok: a file that vanished mid-scan is not a finding
    }
    // A whole file, so `removalsInFile`: a cell-config key counts only inside
    // a cell config literal. Given whole files, the block-shaped
    // `removalsInSource` reported `{ seed: number; actions: string[] }` and
    // `perf: { reduce: 0.4 }` as retired cell keys — a migration report full
    // of things that are not migrations is one nobody finishes reading, and
    // the real row goes unread with them.
    const hits = removalsInFile(text);
    for (const hit of hits) {
      if (!wanted.has(hit.removal.key)) continue;
      const rel = relative(root, file) || file;
      // A retired spelling in a TEST is usually a fixture — an app's own
      // upgrade test feeding the old shape on purpose — not a config the app
      // boots with. The registry already draws that line for `am pin`, which
      // WARNS on these and REFUSES on the rest; here they are simply marked,
      // so a reader can see them without their being counted as work.
      const fixture = isFixturePath(rel);
      found.push({
        fixture,
        file: rel,
        line: hit.line,
        key: hit.removal.key,
        removedIn: hit.removal.removedIn,
        hint: hit.removal.hint,
        guide: hit.removal.guide,
        fixable: hit.removal.now !== undefined,
        text: hit.text.slice(0, 160),
      });
    }
  }
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** Is there a FILE at this path? A plain predicate, so the refusal that
 *  follows is written beside the question rather than inside a `catch` wide
 *  enough to swallow it. @internal */
function existsFile(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false; // aio-ok: "not there" is the answer, not an error
  }
}

/** `am migrate [--from=<release>]` — the retired spellings THIS app still uses. */
export async function cmdMigrate(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const root = Deno.cwd();
  // IS THERE AN APP HERE AT ALL — asked before anything is walked.
  //
  // The scan root is the cwd, and a cwd that is not an app excludes nothing
  // (the scope is read from the app's own deno.json / .gitignore), so this
  // command used to answer two ways at once: in `~` or a checkout's parent it
  // printed the clean bill — the most common and most reassuring outcome, so
  // nothing looked wrong — and from `/` it first recursed the entire
  // filesystem to get there. `am pin`, the sibling over the same scope, has
  // always asked. Same question, same sentence.
  if (!DENO_JSON_NAMES.some((n) => existsFile(`${root}/${n}`))) {
    fail(
      `No ${DENO_JSON_NAMES.join(" or ")} in ${root}.\n` +
        `am migrate scans an app's own source, so it has to run inside one.`,
      mode,
      "cd <your app>   ·   am create <name>",
    );
  }
  const explicit = args.find((a) => a.startsWith("--from="))?.slice(7);
  // No `--from`: the app's own pin. A version the tool can look up is not a
  // thing to make someone remember, and the wrong answer here silently hides
  // rows.
  const pinned = explicit
    ? undefined
    : readFrameworkPinSync(root).pin ?? undefined;
  const from = explicit ?? pinned;
  const findings = await scanMigrations(root, from);

  if (mode === "json") {
    out({
      from: from ?? null,
      fromSource: explicit ? "flag" : pinned ? "pin" : null,
      findings,
    }, mode);
    if (findings.length) Deno.exit(1);
    return;
  }

  const since = from ? `since ${from}` : "in the whole registry";
  if (findings.length === 0) {
    out(
      `✓ nothing to migrate — this app uses no spelling retired ${since}` +
        (explicit || pinned
          ? ""
          : `\n  (no aio pin found here, so every removal was considered)`),
      mode,
    );
    return;
  }
  const lines: string[] = [
    `${findings.length} retired spelling${
      findings.length === 1 ? "" : "s"
    } still in use (${since}):`,
    "",
  ];
  for (const f of findings) {
    lines.push(
      `  ${f.file}:${f.line}  ${f.key}   [removed in ${f.removedIn}]${
        f.fixable ? "  [fixable]" : ""
      }${f.fixture ? "  [test fixture — probably deliberate]" : ""}`,
      `      ${f.text}`,
      `      fix: ${f.hint}`,
      `      see: ${f.guide}`,
      "",
    );
  }
  const fixable = findings.filter((f) => f.fixable).length;
  if (fixable) {
    lines.push(
      `${fixable} of these are rewritten by:  deno task lint -- --safe-fix`,
      "",
    );
  }
  out(lines.join("\n"), mode);
  // Non-zero: this is a gate someone can put in CI, and a migration report that
  // exits 0 is one a pipeline scrolls past.
  Deno.exit(1);
}
