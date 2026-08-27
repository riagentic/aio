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
import type { Issue, Report, Severity } from "./types.ts";
export type { Issue, Report, SafeFixFn, Severity } from "./types.ts";
import denoJson from "../deno.json" with { type: "json" };

// Single source of truth — aiol shares the framework version (deno.json).
const VERSION = denoJson.version;

// ── Colors ──────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  magenta: "\x1b[35m",
} as const;

const isCI = !!Deno.env.get("CI");
const noColor = !!Deno.env.get("NO_COLOR") || Deno.args.includes("--no-color");
const useColor = !noColor && !isCI;
const c = (code: string, text: string) =>
  useColor ? `${code}${text}${C.reset}` : text;

// ── Severity formatting ─────────────────────────────────────────────

const SEVERITY_ICON: Record<Severity, string> = {
  error: "✗",
  warn: "⚠",
  hint: "·",
};
const SEVERITY_COLOR: Record<Severity, string> = {
  error: C.red,
  warn: C.yellow,
  hint: C.cyan,
};
const SEVERITY_LABEL: Record<Severity, string> = {
  error: "ERROR",
  warn: "WARN ",
  hint: "HINT ",
};

function formatIssue(issue: Issue, showFixable = false): string {
  const icon = SEVERITY_ICON[issue.severity];
  const color = SEVERITY_COLOR[issue.severity];
  const label = SEVERITY_LABEL[issue.severity];
  const location = issue.file
    ? (issue.line ? `${issue.file}:${issue.line}` : issue.file)
    : "";
  const loc = location ? ` ${c(C.dim, location)}` : "";
  const fix = issue.fix ? `\n     ${c(C.dim, `→ ${issue.fix}`)}` : "";
  // `[fixable]` = --safe-fix rewrites it. `[manual]` = the safe fix DECLINES
  // this site on purpose (with the reason) — without the distinction, a
  // declined site kept rendering [fixable] forever and read as a broken tool.
  const fixable = showFixable && issue.safeFix
    ? ` ${c(C.green, "[fixable]")}`
    : issue.manual
    ? ` ${c(C.yellow, "[manual]")}`
    : "";
  const manual = issue.manual
    ? `\n     ${c(C.yellow, `⚑ ${issue.manual}`)}`
    : "";
  return `  ${c(color, `${icon} ${label}`)}  ${
    c(C.dim, `[${issue.area}]`)
  } ${issue.message}${fixable}${loc}${manual}${fix}`;
}

// ── Output ──────────────────────────────────────────────────────────

/** Print a lint report — human-readable by default, machine-readable with
 *  `json` (which always keeps every issue, including hints). `hideHints`
 *  silences hint-severity lines in the human report only. */
export function printReport(
  report: Report,
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

  console.log(`\n${c(C.bold, `aiol v${VERSION}`)} — scanning project\n`);

  // Passed checks
  if (report.passed.length) {
    for (const p of report.passed) {
      console.log(`  ${c(C.green, "✓")} ${p}`);
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

  console.log(c(C.dim, "─".repeat(60)));
  console.log(
    `  ${c(C.bold, "Files:")} ${report.stats.filesScanned}  ${
      c(C.bold, "Cells:")
    } ${report.stats.cellsFound}  ${
      c(C.bold, "Tests:")
    } ${report.stats.testsFound}`,
  );

  const fixable = report.issues.filter((i) => i.safeFix).length;

  // With --no-hints, hint-only projects read as clean; the count is still noted
  // (dimmed) so nothing is hidden silently — you know they're there, muted.
  const hintNote = hideHints && h
    ? `  ${
      c(C.dim, `(${h} hint${h > 1 ? "s" : ""} hidden — drop --no-hints to see)`)
    }`
    : "";
  if (total === 0) {
    // The verdict claims exactly what was checked: aiol is fmt-agnostic on
    // purpose, and "clean project!" read as a stronger promise than it was —
    // a contributor who trusted it committed an unformatted tree that CI then
    // rejected (a field report). Architecture is aiol's scope; formatting is
    // `deno fmt`'s.
    console.log(
      `  ${c(C.green + C.bold, "✓ No architectural issues found")}  ${
        c(C.dim, "(formatting is deno fmt's job — run it before a commit)")
      }`,
    );
  } else if (hideHints && e === 0 && w === 0) {
    console.log(
      `  ${c(C.green + C.bold, "✓ No errors or warnings")}${hintNote}`,
    );
  } else {
    const parts: string[] = [];
    if (e) parts.push(c(C.red, `${e} error${e > 1 ? "s" : ""}`));
    if (w) parts.push(c(C.yellow, `${w} warning${w > 1 ? "s" : ""}`));
    if (h && !hideHints) parts.push(c(C.cyan, `${h} hint${h > 1 ? "s" : ""}`));
    console.log(`  ${parts.join(" · ")}${hintNote}`);
    if (fixable > 0 && !showFixable) {
      console.log(
        `  ${c(C.green, `${fixable} auto-fixable`)} — run with ${
          c(C.bold, "--safe-fix")
        } to apply`,
      );
    }
  }
  console.log();
}

// ── Safe fix execution ──────────────────────────────────────────────

async function applySafeFixes(
  report: Report,
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
          `  ${c(C.green, "✓ fixed")}  ${
            c(C.dim, `[${issue.area}]`)
          } ${issue.message}`,
        );
      }
    } catch (e) {
      say(
        `  ${c(C.red, "✗ failed")} ${
          c(C.dim, `[${issue.area}]`)
        } ${issue.message}: ${e}`,
      );
    }
  }
  return applied;
}

// ── CLI ─────────────────────────────────────────────────────────────

/** Run all aiol checks against a project directory and return a structured report */
export async function lint(projectDir: string): Promise<Report> {
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
 *  `--safe_fix`, `--fix`). */
export function nearestFlag(given: string): string | null {
  const dist = (a: string, b: string): number => {
    let prev = [...Array(b.length + 1).keys()];
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(
          prev[j]! + 1,
          cur[j - 1]! + 1,
          prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
      }
      prev = cur;
    }
    return prev[b.length]!;
  };
  let best: string | null = null;
  let bestD = 4;
  for (const f of FLAGS) {
    const d = dist(given, f);
    if (d < bestD) {
      bestD = d;
      best = f;
    }
  }
  return best;
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

  const report = await lint(projectDir);

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
      say(`  ${c(C.dim, "No auto-fixable issues found.")}`);
      printReport(report, json, true, hideHints);
    } else {
      say(`\n${c(C.bold, `aiol v${VERSION}`)} — applying safe fixes\n`);
      const applied = await applySafeFixes(report, projectDir, say);
      say(
        `\n  ${
          c(
            C.green + C.bold,
            `${applied} fix${applied !== 1 ? "es" : ""} applied`,
          )
        }\n`,
      );
      // What REMAINS is the truth the caller acts on — print it (report-only
      // findings must stay visible) and judge the exit from it.
      finalReport = await lint(projectDir);
      printReport(finalReport, json, true, hideHints);
    }
  } else {
    printReport(report, json, true, hideHints);
  }

  // Exit code: 1 if errors REMAIN, 0 otherwise.
  const hasErrors = finalReport.issues.some((i) => i.severity === "error");
  Deno.exit(hasErrors ? 1 : 0);
}
