#!/usr/bin/env -S deno run -A
/**
 * @module
 * aiol — aio linter and project validator.
 *
 * Scans an aio project and reports errors, warnings, and optimization hints.
 * Checks cell definitions, import graphs, naming conventions, memo usage,
 * and framework best practices.
 *
 * ```sh
 * deno run -A aiol/mod.ts [project-dir]
 * ```
 */

import { buildContext } from "./context.ts";
import { ALL_CHECKS } from "./checks.ts";
import type { Issue, LintReport, Severity } from "./types.ts";
import { colorEnabled } from "../src/diagnostics/color.ts";
import { nearestOf } from "../src/state/cell-helpers.ts";
import {
  count,
  mark,
  styleWith,
  tally,
  termWidth,
  type Tone,
  wrap,
} from "../src/diagnostics/fmt.ts";
/** The programmatic surface (alpha70 names): `lintProject(dir)` returns a
 *  `LintReport`. */
export type { Issue, LintReport, SafeFixFn, Severity } from "./types.ts";
import denoJson from "../deno.json" with { type: "json" };

// Single source of truth — aiol shares the framework version (deno.json).
const VERSION = denoJson.version;

// ── Colors ──────────────────────────────────────────────────────────

// THE framework colour decider, not a third private copy. aiol used to run
// its own (`NO_COLOR` || `CI` → off), which disagreed with the rest of aio in
// both directions: it ignored `FORCE_COLOR` (so `aiol | less -R` in CI was
// plain no matter what you asked for) and it painted a redirected file that
// was not a terminal. `--no-color` is aiol's own flag and still wins.
const useColor = colorEnabled && !Deno.args.includes("--no-color");
const st = styleWith(useColor);
// ── Severity formatting ─────────────────────────────────────────────

// Severity → tone is the ONLY mapping left. The three tables that used to sit
// here — a glyph per severity, a colour per severity, a 5-character LABEL per
// severity — were a fourth private copy of what `fmt.mark()` decides for every
// surface, and the labels ("ERROR", "WARN ", "HINT ") restated in words what
// the coloured glyph already said.
const TONE: Record<Severity, Tone> = {
  error: "bad",
  warn: "warn",
  hint: "note",
};

function formatIssue(issue: Issue, showFixable = false): string {
  const tone = TONE[issue.severity];
  const location = issue.file
    ? (issue.line ? `${issue.file}:${issue.line}` : issue.file)
    : "";
  // `[fixable]` = --safe-fix rewrites it. `[manual]` = the safe fix DECLINES
  // this site on purpose (with the reason) — without the distinction, a
  // declined site kept rendering [fixable] forever and read as a broken tool.
  const badge = showFixable && issue.safeFix
    ? "  " + st.green("[fixable]")
    : issue.manual
    ? "  " + st.yellow("[manual]")
    : "";
  // The LOCATION leads, the way every compiler and every editor puts it, and
  // it appears ONCE. It used to be printed twice on every line — inside the
  // message the check composed, and again dimmed at the end of the row — with
  // the message itself unwrapped past the right edge in between.
  const head = `  ${mark(tone, st)}  ${
    location ? st.underline(location) : st.dim(issue.area)
  }${location ? "  " + st.dim(issue.area) : ""}${badge}`;
  const room = termWidth() - 5;
  // A check that composed `<file>: <what>` into its message now says the file
  // twice — once as the location above, once inside the sentence. Strip the
  // echo rather than ask 40 checks to stop doing it.
  const said = issue.file && issue.message.startsWith(issue.file + ":")
    ? issue.message.slice(issue.file.length + 1).replace(/^\s*\d+:\s*/, "")
      .trimStart()
    : issue.message;
  const body = wrap(said, room).map((l) => "     " + l).join("\n");
  const manual = issue.manual
    ? "\n" +
      wrap(issue.manual, room).map((l) => "     " + st.yellow(l)).join("\n")
    : "";
  const fix = issue.fix
    ? "\n" +
      wrap(issue.fix, room).map((l, i) => "     " + st.cyan(i === 0 ? l : l))
        .join("\n")
    : "";
  return `${head}\n${body}${manual}${fix}`;
}

// ── Output ──────────────────────────────────────────────────────────

/** Print a lint report — human-readable by default, machine-readable with
 *  `json` (which always keeps every issue, including hints). `hideHints`
 *  silences hint-severity lines in the human report only. */
export function printReport(
  report: LintReport,
  json: boolean,
  showFixable = false,
  hideHints = false,
): void {
  if (json) {
    console.log(JSON.stringify(
      {
        version: VERSION,
        stats: report.stats,
        passed: report.passed,
        issues: report.issues,
        summary: {
          errors: report.issues.filter((i) => i.severity === "error").length,
          warnings: report.issues.filter((i) => i.severity === "warn").length,
          hints: report.issues.filter((i) => i.severity === "hint").length,
        },
      },
      null,
      2,
    ));
    return;
  }

  console.log(`\n${st.bold("aiol")}  ${st.dim(VERSION)}\n`);

  // Passed checks
  if (report.passed.length) {
    for (const p of report.passed) {
      console.log(`  ${mark("ok", st)} ${st.dim(p)}`);
    }
    console.log();
  }

  // Group issues by severity
  const errors = report.issues.filter((i) => i.severity === "error");
  const warns = report.issues.filter((i) => i.severity === "warn");
  const hints = report.issues.filter((i) => i.severity === "hint");

  if (errors.length) {
    for (const issue of errors) console.log(formatIssue(issue, showFixable));
    console.log();
  }
  if (warns.length) {
    for (const issue of warns) console.log(formatIssue(issue, showFixable));
    console.log();
  }
  // Hints are "sub-optimal but works" — suppressible with --no-hints so a
  // project that has consciously accepted them can have a 0-noise run (hints
  // never affect the exit code, only errors do).
  if (hints.length && !hideHints) {
    for (const issue of hints) console.log(formatIssue(issue, showFixable));
    console.log();
  }

  // Summary bar
  const total = report.issues.length;
  const e = errors.length;
  const w = warns.length;
  const h = hints.length;

  // No 60-column `─` rule: the house style has no frames, and a fixed-width
  // one in a 200-column terminal looked like a mistake.
  console.log(
    "  " + st.dim(
      [
        count(report.stats.filesScanned, "file"),
        count(report.stats.cellsFound, "cell"),
        count(report.stats.testsFound, "test"),
      ].join(" · "),
    ),
  );

  const fixable = report.issues.filter((i) => i.safeFix).length;

  // With --no-hints, hint-only projects read as clean; the count is still noted
  // (dimmed) so nothing is hidden silently — you know they're there, muted.
  const hintNote = hideHints && h
    ? "  " +
      st.dim(`(${count(h, "hint")} hidden — drop --no-hints to see)`)
    : "";
  if (total === 0) {
    // The verdict claims exactly what was checked: aiol is fmt-agnostic on
    // purpose, and "clean project!" read as a stronger promise than it was —
    // a contributor who trusted it committed an unformatted tree that CI then
    // rejected (a field report). Architecture is aiol's scope; formatting is
    // `deno fmt`'s.
    console.log(
      `  ${mark("ok", st)} ${st.bold("No architectural issues found")}  ${
        st.dim("(formatting is deno fmt's job — run it before a commit)")
      }`,
    );
  } else if (hideHints && e === 0 && w === 0) {
    console.log(
      `  ${mark("ok", st)} ${st.bold("No errors or warnings")}${hintNote}`,
    );
  } else {
    console.log(
      "  " + tally([
        [e, ["error", "errors"], "bad"],
        [w, ["warning", "warnings"], "warn"],
        [hideHints ? 0 : h, ["hint", "hints"], "note"],
      ], { style: st }) + hintNote,
    );
    if (fixable > 0 && !showFixable) {
      console.log(
        `  ${st.green(`${fixable} auto-fixable`)} ${st.dim("— run")} ${
          st.cyan("aiol --safe-fix")
        } ${st.dim("to apply")}`,
      );
    }
  }
  console.log();
}

// ── Safe fix execution ──────────────────────────────────────────────

async function applySafeFixes(
  report: LintReport,
  projectDir: string,
  /** Where narration goes — stderr under --json, so stdout stays parseable. */
  say: (msg: string) => void = console.log,
): Promise<number> {
  const fixable = report.issues.filter((i) => i.safeFix);
  let applied = 0;
  for (const issue of fixable) {
    try {
      const ok = await issue.safeFix!(projectDir);
      if (ok) {
        applied++;
        say(
          `  ${mark("ok", st)} ${st.green("fixed")}  ${
            st.dim(issue.area)
          } ${issue.message}`,
        );
      }
    } catch (e) {
      say(
        `  ${mark("bad", st)} ${st.red("failed")} ${
          st.dim(issue.area)
        } ${issue.message}: ${e}`,
      );
    }
  }
  return applied;
}

// ── CLI ─────────────────────────────────────────────────────────────

/** Run all aiol checks against a project directory and return a structured
 *  report. (alpha70: `lint` → `lintProject`, `Report` → `LintReport` — the
 *  bare names collided with `aio/extras` `checkCells` (ex-`lint`) and with
 *  every app's own `Report` type.) */
export async function lintProject(projectDir: string): Promise<LintReport> {
  const { ctx, report } = await buildContext(projectDir);
  for (const check of ALL_CHECKS) {
    await check(ctx);
  }
  // Sort: errors first, then warnings, then hints
  const order: Record<Severity, number> = { error: 0, warn: 1, hint: 2 };
  report.issues.sort((a, b) => order[a.severity] - order[b.severity]);
  return report;
}

/** Every flag aiol accepts. One list, so `--help` and the refusal below can
 *  never disagree about what exists. */
const FLAGS = [
  "--safe-fix",
  "--no-hints",
  "--quiet-hints",
  "--json",
  "--no-color",
  "--help",
  "-h",
  "--version",
  "-v",
] as const;

/** The accepted flag closest to `given`, or null. Levenshtein ≤ 3 over a
 *  ten-word vocabulary — cheap, and it catches the real misses (`--safefix`,
 *  `--safe_fix`, `--fix`).
 *  @internal CLI plumbing pinned by tests/aiol-no-hints.test.ts — not API. */
export function nearestFlag(given: string): string | null {
  // THE "did you mean" of this repo (src/state/cell-helpers.ts), not a second
  // Levenshtein with its own threshold. The two implementations here were
  // character-for-character the same recurrence written two different ways,
  // and only the bound differed — so the bound is what this passes.
  return nearestOf(given, FLAGS, 4);
}

if (import.meta.main) {
  const args = Deno.args.filter((a) => !a.startsWith("-"));
  const flags = new Set(Deno.args.filter((a) => a.startsWith("-")));

  // An unknown flag is a REFUSAL, not a no-op. `aiol . --safefix` used to lint,
  // fix nothing, and exit 0 — the caller reads "clean" and ships. Every other
  // surface in this project refuses an unknown key with a did-you-mean; the
  // linter that enforces that must not be the exception.
  const unknown = [...flags].filter((f) =>
    !(FLAGS as readonly string[]).includes(f)
  );
  if (unknown.length > 0) {
    for (const f of unknown) {
      const near = nearestFlag(f);
      console.error(
        `aiol: unknown flag ${f}${near ? ` — did you mean ${near}?` : ""}`,
      );
    }
    console.error(
      `Known flags: ${FLAGS.join(" ")}   (--help for what they do)`,
    );
    Deno.exit(2);
  }

  const json = flags.has("--json");
  const safeFix = flags.has("--safe-fix");
  const hideHints = flags.has("--no-hints") || flags.has("--quiet-hints");

  if (flags.has("--help") || flags.has("-h")) {
    console.log(`aiol v${VERSION} — aio project linter

Usage: deno run -A aiol/mod.ts [project-dir] [flags]

Flags:
  --safe-fix     Auto-fix safe issues (config additions, dead code removal)
  --no-hints     Hide "hint" issues for a 0-noise run (count still noted; exit
                 code is unaffected — only errors fail)
  --json         Output as JSON (always includes hints)
  --no-color     Disable color output
  --version, -v  Print the version
  --help, -h     Show this help

An unknown flag is refused (exit 2) with the flag it probably meant — a flag
that silently does nothing is worse than one that fails.

Scans an aio project directory and reports:
  ✗ errors   — will break at runtime
  ⚠ warnings — likely bugs or performance issues
  · hints    — sub-optimal but works

Issues marked [fixable] can be auto-fixed with --safe-fix.
Only harmless changes: missing config, unused imports. Never changes behavior.
`);
    Deno.exit(0);
  }

  if (flags.has("--version") || flags.has("-v")) {
    console.log(`aiol v${VERSION}`);
    Deno.exit(0);
  }

  const projectDir = args[0] ?? Deno.cwd();

  try {
    await Deno.stat(projectDir);
  } catch {
    console.error(`Error: directory not found: ${projectDir}`);
    Deno.exit(1);
  }

  const report = await lintProject(projectDir);

  // The report the EXIT CODE and the final printout are computed from. With
  // --safe-fix this is a RE-LINT of the now-fixed tree: the pre-fix report
  // used to decide the exit, so a run that successfully fixed every error
  // still exited 1 — and the report-only leftovers were never shown at all
  // (the owner saw "N fixes applied", a red exit, and no way to tell which).
  let finalReport = report;

  if (safeFix) {
    // Under --json, stdout must carry ONE parseable document and nothing else.
    // The human progress lines used to be printed around it on stdout, so
    // `aiol . --json --safe-fix | jq` could not parse its own output. Progress
    // is narration, not the result: it belongs on stderr.
    const say = json ? console.error : console.log;
    const fixable = report.issues.filter((i) => i.safeFix).length;
    if (fixable === 0) {
      say(`  ${st.dim("No auto-fixable issues found.")}`);
      printReport(report, json, true, hideHints);
    } else {
      say(
        `\n${st.bold("aiol")}  ${st.dim(VERSION)}  ${
          st.dim("applying safe fixes")
        }\n`,
      );
      const applied = await applySafeFixes(report, projectDir, say);
      say(
        `\n  ${
          st.green(st.bold(count(applied, "fix", "fixes") + " applied"))
        }\n`,
      );
      // What REMAINS is the truth the caller acts on — print it (report-only
      // findings must stay visible) and judge the exit from it.
      finalReport = await lintProject(projectDir);
      printReport(finalReport, json, true, hideHints);
    }
  } else {
    printReport(report, json, true, hideHints);
  }

  // Exit code: 1 if errors REMAIN, 0 otherwise.
  const hasErrors = finalReport.issues.some((i) => i.severity === "error");
  Deno.exit(hasErrors ? 1 : 0);
}
