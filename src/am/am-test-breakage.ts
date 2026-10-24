/**
 * @module
 * `am migrate --tests` — the TEST shapes an upgrade turns red, found in THIS
 * app, in the order they will fail.
 *
 * `am migrate` knows retired APIs (`REMOVALS`). What broke a field report's
 * 73 tests between 1.0.9 and 1.0.20 was not an API: the harness got stricter
 * (tests are the strictest environment by design), one release at a time, and
 * the suite said so one cascade at a time. {@linkcode TEST_BREAKAGES} is the
 * machine-readable index of those shapes — the list in docs/upgrade/README.md
 * § "Tests that can go red" and each guide's "Tests that can go red" — with
 * the release that made each one fail and a matcher over source text.
 *
 * A match is a PREDICTION (a shape that can go red), never a verdict: the
 * command lists, it does not refuse. Shapes an upgrade cannot break (an
 * opt-in such as `wire.refuseShortCalls`, a fence a later release lifted)
 * are not here.
 */
import { relative } from "@std/path";
import { isFixturePath } from "../state/removals.ts";
import { appSourceFiles } from "./app-source-scope.ts";
import { seriesRank } from "./am-cmd-migrate.ts";

/** One shape an upgrade turns red. */
export interface TestBreakage {
  /** Stable id — the `--json` key a script matches on. */
  id: string;
  /** The release from which it fails. */
  since: string;
  /** Where it lives: a test file, or the app's own source. */
  scope: "tests" | "app";
  /** Matches the shape in one file's text (global flag); the line reported
   *  is where the match ENDS (the call that fails). */
  pattern: RegExp;
  what: string;
  fix: string;
  guide: string;
}

const README = "docs/upgrade/README.md";
const G24 = "docs/upgrade/from-1.0.23-beta-to-1.0.24-beta.md";

/** The index, oldest first. A new strictness that turns a passing test red
 *  gets a row here AND a line in its upgrade guide. */
export const TEST_BREAKAGES: readonly TestBreakage[] = [
  {
    id: "present-hidden-display",
    since: "1.0.0-alpha77",
    scope: "app",
    pattern: /\bhidden=\{/g,
    what: "`ui.present(name)` is true for a `hidden={…}` element whose CSS " +
      "gives it a `display` (author CSS beats `[hidden] { display: none }`)",
    fix: "render nothing (`{ready && <X/>}`) or add " +
      "`[hidden] { display: none }`",
    guide: README,
  },
  {
    id: "oninit-timer-dispatch",
    since: "1.0.11-beta",
    scope: "app",
    pattern: /\bonInit\s*\([^)]*\)\s*\{[^]{0,400}?\bsetTimeout\s*\(/g,
    what: "a timer in `onInit` that calls a method fires after the test's " +
      "boot retired — the late call is refused",
    fix: '`onInit(app) { app.dispatch({ type: "cell:method", payload: ' +
      "{ args: [] } }) }` or `aio.run({ onStart })`",
    guide: README,
  },
  {
    id: "oninit-throws",
    since: "1.0.11-beta",
    scope: "app",
    pattern: /\bonInit\s*\([^)]*\)\s*\{[^]{0,400}?\bthrow\b/g,
    what: "an `onInit` that throws fails the `bootCells`/`testUI` test " +
      "(it used to be only logged)",
    fix: "fix the throw, or catch it inside `onInit`",
    guide: README,
  },
  {
    id: "testui-non-json-arg",
    since: "1.0.19-beta",
    scope: "tests",
    pattern: /\bnew\s+(?:Date|Map|Set)\s*\(/g,
    what: "`testUI` calls cross the production wire encode: a `Date`, `Map`, " +
      "`Set` or class instance argument fails, by path",
    fix: "pass ISO strings / plain data",
    guide: README,
  },
  {
    id: "advance-after-click",
    since: "1.0.24-beta",
    scope: "tests",
    pattern: /\.click\([^)]*\)\s*;?\s*(?:await\s+)?[\w$.]+\.advance\s*\(/g,
    what: "`ui.X.click(); await ui.advance(ms)` runs the click BEFORE the " +
      'clock moves — a "not fired yet" assertion may now see the timer fire',
    fix: "assert what the click causes after the advance",
    guide: G24,
  },
  {
    id: "async-predicate",
    since: "1.0.24-beta",
    scope: "tests",
    pattern:
      /\b(?:waitFor|expectCell|waitForPatch|expect\.state|expect\.invariant)\s*\((?:[^()]|\([^()]*\))*?\basync\s*(?:\(|[\w$]+\s*=>)/g,
    what: "an async predicate (`waitFor`, `expectCell`, `waitForPatch`, " +
      "`t.expect.state`/`invariant`) is refused — it passed on the first look",
    fix: "make the predicate synchronous",
    guide: G24,
  },
  {
    id: "surface-renumbered-name",
    since: "1.0.24-beta",
    scope: "tests",
    pattern: /\b[A-Z][\w$]*Rc[1-9]\d*[A-Z][\w$]*\b|\bRetryButton\d+\b/g,
    what: "a surface name 1.0.23 renumbered (`AioRadioRc1Radio`, " +
      "`RetryButton2`) is back to its earlier spelling",
    fix: "use the name `am surface` / `ui.names()` prints now",
    guide: G24,
  },
];

export type TestBreakageFinding = {
  id: string;
  since: string;
  file: string;
  line: number;
  text: string;
  what: string;
  fix: string;
  guide: string;
};

/** A test file: a fixture path, `*_test.*` or `*.spec.*`. Pure. */
export function isTestPath(rel: string): boolean {
  return isFixturePath(rel) || /(^|[\\/])[^\\/]*(_test|\.spec)\.[jt]sx?$/
    .test(rel);
}

/** The shapes that fail AFTER `from` (none given: all). Unknown `from`
 *  shows all — under-reporting is the failure that costs an afternoon. */
export function breakagesAfter(from: string | undefined): TestBreakage[] {
  const floor = from ? seriesRank(from) : -1;
  if (floor === Number.MAX_SAFE_INTEGER) return [...TEST_BREAKAGES];
  return TEST_BREAKAGES.filter((b) => seriesRank(b.since) > floor);
}

/** Every match of `shapes` in one file's text. Pure. */
export function breakagesInText(
  rel: string,
  text: string,
  shapes: readonly TestBreakage[],
): TestBreakageFinding[] {
  const test = isTestPath(rel);
  const lines = text.split("\n");
  const out: TestBreakageFinding[] = [];
  for (const b of shapes) {
    if ((b.scope === "tests") !== test) continue;
    for (const m of text.matchAll(new RegExp(b.pattern.source, "g"))) {
      const end = m.index! + m[0].length;
      const line = text.slice(0, end).split("\n").length;
      out.push({
        id: b.id,
        since: b.since,
        file: rel,
        line,
        text: (lines[line - 1] ?? "").trim().slice(0, 160),
        what: b.what,
        fix: b.fix,
        guide: b.guide,
      });
    }
  }
  return out;
}

/** Scan the app at `root` (the scope `am migrate` reads) for the shapes that
 *  fail after `from`, in the order they will fail: oldest release first. */
export async function scanTestBreakages(
  root: string,
  from: string | undefined,
): Promise<TestBreakageFinding[]> {
  const shapes = breakagesAfter(from);
  const found: TestBreakageFinding[] = [];
  let present = false;
  for await (const file of appSourceFiles(root)) {
    let text: string;
    try {
      text = await Deno.readTextFile(file);
    } catch {
      continue; // aio-ok: a file that vanished mid-scan is not a finding
    }
    const rel = relative(root, file) || file;
    if (isTestPath(rel) && /\.present\s*\(/.test(text)) present = true;
    found.push(...breakagesInText(rel, text, shapes));
  }
  // `hidden={…}` matters only to a suite that asks `present()`.
  const kept = present
    ? found
    : found.filter((f) => f.id !== "present-hidden-display");
  return kept.sort((a, b) =>
    seriesRank(a.since) - seriesRank(b.since) ||
    a.file.localeCompare(b.file) || a.line - b.line
  );
}
