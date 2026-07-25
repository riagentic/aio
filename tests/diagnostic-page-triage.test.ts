// The module-errors page must not bury the one real fatal under standing
// warnings (risoto 2026-07-26: "N-1 are pre-existing, never-fatal warnings and
// exactly 1 is the real fatal" — a 10-second fix became an archaeology dig).
import { assert, assertStringIncludes } from "@std/assert";
import { generateDiagnosticHTML } from "../src/server/server-html-diagnostic.ts";
import type { GraphError } from "../src/server/graph-validator.ts";

const fatal: GraphError = {
  category: "missing-import-map",
  message: 'unmapped import "chart.js"',
  file: "src/Chart.tsx",
  line: 3,
  fix: 'add "chart.js" to deno.json imports',
};
const warn = (n: number): GraphError => ({
  category: "server-only-api",
  message: `Deno.* used in a conditional path (${n})`,
  file: `src/lib/util${n}.ts`,
  fix: "guard the call or move it server-side",
});

Deno.test("diagnostic page: the header counts FATALS, not standing warnings", () => {
  const html = generateDiagnosticHTML(
    [warn(1), fatal, warn(2), warn(3)],
    "wallet",
  );
  assertStringIncludes(html, "1 module error");
  assert(
    !html.includes("4 module error"),
    "warnings must not inflate the count",
  );
  // The fatal is in the main list…
  const mainList = html.slice(0, html.indexOf("<details"));
  assertStringIncludes(mainList, "chart.js");
  // …and the warnings are demoted, labelled, and collapsed.
  assertStringIncludes(html, "3 standing warnings");
  assertStringIncludes(html, "not blocking");
  assertStringIncludes(html, "util1.ts");
});

Deno.test("diagnostic page: warnings alone are still shown (nothing hidden)", () => {
  const html = generateDiagnosticHTML([warn(1), warn(2)], "wallet");
  assertStringIncludes(html, "2 module errors");
  assertStringIncludes(html, "util2.ts");
  assert(
    !html.includes("<details"),
    "with no fatal there is nothing to demote",
  );
});
