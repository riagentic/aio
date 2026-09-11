/**
 * @module
 * `am migrate` — what THIS app has to change to move forward.
 *
 * A field report (wallet report §22.7) asked for `am migrate --from=alpha76`. The
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
 * app already on beta1 is not shown alpha27's restructure. Omitted, it is read
 * from the app's own pin, because the version the app is actually on is a fact
 * the tool can look up and a person has to remember.
 */
import { join, relative } from "@std/path";
import type { GlobalFlags } from "./am-types.ts";
import { detectMode, out } from "./am-output.ts";
import {
  _cellCallSpans,
  isFixturePath,
  type Removal,
  REMOVALS,
  removalsInSource,
} from "../state/removals.ts";
import { codeText } from "../diagnostics/code-mask.ts";
import { readFrameworkPinSync } from "../server/deno-json.ts";

/** Source files an app's own code lives in — the ones a removal can be in.
 *
 *  `dep/`, `node_modules/` and `dist/` are somebody else's code or a build
 *  product, and a hit in one of them is not something the reader can act on. */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "dep",
  ".git",
  ".aio",
  "build",
  "target",
]);

/** Order a release series so `--from` can mean "after this".
 *
 *  The vocabulary is `alpha<N>` / `beta<N>` / a bare release. Anything this
 *  cannot read sorts LAST, so an unrecognised `--from` shows everything rather
 *  than silently hiding rows — a migration tool that under-reports is worse
 *  than one that over-reports, because the app boots and then explodes. */
export function seriesRank(series: string): number {
  const s = series.trim().toLowerCase().replace(/^v?1\.0\.0-/, "");
  const m = /^(alpha|beta|rc)(\d+)$/.exec(s);
  if (m) {
    const tier = { alpha: 0, beta: 1, rc: 2 }[m[1] as "alpha"] ?? 0;
    return tier * 100_000 + Number(m[2]);
  }
  if (/^\d+\.\d+/.test(s)) return 3 * 100_000; // a real release, after them all
  return Number.MAX_SAFE_INTEGER;
}

/** Removals that landed AFTER `from`. No `from` = all of them. */
export function removalsAfter(from: string | undefined): Removal[] {
  if (!from) return [...REMOVALS];
  const floor = seriesRank(from);
  if (floor === Number.MAX_SAFE_INTEGER) return [...REMOVALS];
  return REMOVALS.filter((r) => seriesRank(r.removedIn) > floor);
}

/** Every `.ts`/`.tsx` file under `dir` that is the app's own. */
async function* sourceFiles(dir: string): AsyncGenerator<string> {
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dir)];
  } catch {
    return; // aio-ok: an unreadable directory is not a migration finding
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      yield* sourceFiles(full);
    } else if (e.isFile && /\.tsx?$/.test(e.name)) yield full;
  }
}

/** The file with everything OUTSIDE a `cell(…)` argument list blanked.
 *
 *  Same length and same newlines, so a line number from the blanked text is a
 *  line number in the original. When the file declares no cell at all the
 *  result is entirely blank, which is the right answer: no cell, no cell
 *  config. */
export function cellConfigOnly(text: string): string {
  const code = codeText(text);
  const spans = _cellCallSpans(code);
  const out = text.split("");
  for (let i = 0; i < out.length; i++) {
    if (spans.some(([s, e]: [number, number]) => i >= s && i < e)) continue;
    if (out[i] !== "\n") out[i] = " ";
  }
  // A file with a `cell(` whose argument list never closes yields one span to
  // end-of-file — the same fallback `_cellCallSpans` documents — so this can
  // still over-report there. Over-reporting inside a cell call is the safe
  // direction; under-reporting is an app that boots and then explodes.
  return out.join("");
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
  for await (const file of sourceFiles(root)) {
    let text: string;
    try {
      text = await Deno.readTextFile(file);
    } catch {
      continue; // aio-ok: a file that vanished mid-scan is not a finding
    }
    // A whole file is NOT what `removalsInSource` documents itself as taking.
    // Its contract: with no `cell(` in the text, every line counts as cell
    // config, because `aiol` hands it one already-extracted config block.
    // Given whole files it reported `{ seed: number; actions: string[] }` and
    // `perf: { reduce: 0.4 }` as retired cell keys — a migration report full
    // of things that are not migrations is one nobody finishes reading, and
    // the real row goes unread with them.
    //
    // So the file is handed over TWICE, each time as the thing the contract
    // describes. Everything outside a `cell(…)` argument list is blanked (same
    // length, newlines kept, so line numbers survive) for the cell-config
    // rows; the untouched text serves the rows that carry their own pattern,
    // which are ordinary API shapes and correctly found anywhere.
    const hits = [
      ...removalsInSource(text).filter((h) => h.removal.kind !== "cell-config"),
      ...removalsInSource(cellConfigOnly(text)).filter((h) =>
        h.removal.kind === "cell-config"
      ),
    ];
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

/** `am migrate [--from=<release>]` — the retired spellings THIS app still uses. */
export async function cmdMigrate(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const root = Deno.cwd();
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
