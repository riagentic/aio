// aiol `--no-hints` — a 0-noise run: hint-severity issues are suppressed from
// the human report (count still noted, exit code unaffected) so a project that
// has consciously accepted its hints can lint cleanly. The JSON output always
// keeps every issue. (User request: make a 0-noise `lint:aio` run possible.)
import { assert, assertEquals } from "@std/assert";
import { printReport } from "../aiol/mod.ts";
import type { Report } from "../aiol/types.ts";

function capture(fn: () => void): string {
  const orig = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    fn();
  } finally {
    console.log = orig;
  }
  // strip ANSI so assertions are color-independent
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

const reportWith = (issues: Report["issues"]): Report => ({
  issues,
  passed: [],
  stats: { filesScanned: 1, cellsFound: 1, testsFound: 0 },
});

Deno.test("aiol --no-hints: hides hint lines but notes the count", () => {
  const report = reportWith([
    { severity: "hint", area: "perf", message: "prefer a memo here" },
    { severity: "hint", area: "style", message: "inline could be a class" },
  ]);

  const shown = capture(() => printReport(report, false, false, false));
  assert(shown.includes("prefer a memo here"), "default shows hint text");

  const hidden = capture(() => printReport(report, false, false, true));
  assert(!hidden.includes("prefer a memo here"), "--no-hints hides hint text");
  assert(hidden.includes("2 hints hidden"), "the hidden count is still noted");
  assert(
    hidden.includes("No errors or warnings"),
    "a hint-only project reads as clean under --no-hints",
  );
});

Deno.test("aiol --no-hints: errors/warnings still show; hints muted", () => {
  const report = reportWith([
    { severity: "error", area: "ui", message: "server import in a cell file" },
    { severity: "warn", area: "perf", message: "wide selector" },
    { severity: "hint", area: "style", message: "cosmetic nit" },
  ]);
  const out = capture(() => printReport(report, false, false, true));
  assert(out.includes("server import in a cell file"), "error shown");
  assert(out.includes("wide selector"), "warning shown");
  assert(!out.includes("cosmetic nit"), "hint hidden");
  assert(out.includes("1 hint hidden"));
});

Deno.test("aiol --no-hints: JSON output ALWAYS includes hints (machine-readable)", () => {
  const report = reportWith([
    { severity: "hint", area: "style", message: "cosmetic nit" },
  ]);
  const out = capture(() => printReport(report, true, false, true));
  const parsed = JSON.parse(out) as { summary: { hints: number } };
  assertEquals(parsed.summary.hints, 1, "JSON keeps the hint regardless");
});

Deno.test("aiol: a genuinely clean project keeps its original message", () => {
  const out = capture(() => printReport(reportWith([]), false, false, true));
  assert(out.includes("No issues found — clean project!"));
});
