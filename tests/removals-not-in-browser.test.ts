// The removals registry is a TOOLING table, and it was shipping to every page.
//
// Three browser-reachable modules look a removal up by key (cell-impl,
// schedule, cell-methods-factory — plus cell-create, cell-helpers and the
// memory monitor), and a lookup pulls the whole array: 36 rows of `am publish`
// prose, deno.json migrations and `aiol --safe-fix` import moves, ~4.5 KB raw
// / 1.3 KB gzipped that a page can never use, on every page load.
//
// The fix is structural, not a diet: the rows a RUNNING app can trip live in
// removals-core.ts, and the rows only `am`/`aiol`/the build read stay in
// removals.ts, which imports core and re-exports it. Tree-shaking does the
// rest — but only for as long as no browser-reachable module reaches for the
// tooling half again, which is what this pins.
import { assert, assertEquals } from "@std/assert";
import { CORE_REMOVALS } from "../src/state/removals-core.ts";
import { REMOVALS } from "../src/state/removals.ts";

/** Modules a page's bundle reaches that consult the registry. Reaching for
 *  `removals.ts` from one of these puts the whole table back in the bundle. */
const BROWSER_REACHABLE = [
  "src/state/cell-impl.ts",
  "src/state/cell-create.ts",
  "src/state/cell-helpers.ts",
  "src/state/cell-methods-factory.ts",
  "src/state/schedule.ts",
  "src/diagnostics/memory-monitor.ts",
];

Deno.test("removals: no browser-reachable module imports the tooling registry", async () => {
  const root = new URL("../", import.meta.url).pathname;
  const offenders: string[] = [];
  for (const file of BROWSER_REACHABLE) {
    const src = await Deno.readTextFile(root + file);
    if (/from\s+"(?:\.\.?\/)+(?:state\/)?removals\.ts"/.test(src)) {
      offenders.push(file);
    }
  }
  assertEquals(
    offenders,
    [],
    `these ship the whole removal registry to every page — import ` +
      `removals-core.ts instead, and put the row there if it is missing:\n  ` +
      offenders.join("\n  "),
  );
});

Deno.test("removals: the core rows are the ones a running app can trip, and no more", () => {
  // A row drifting into core costs every page load; a row missing from core
  // makes `removalOf` throw at the moment it was supposed to teach. Both are
  // caught by naming the set.
  assertEquals(
    CORE_REMOVALS.map((r) => r.key).sort(),
    [
      "actions",
      "call({ timeout })",
      "cell({ ui })",
      "cellDefaults.ui",
      "execute",
      "generators",
      "listensTo: [...]",
      "machine",
      "memory.gcStressRatio",
      "reduce",
      "return effect(s) from a method",
      "schedule.backoff/poll(id, attempt, opts, action)",
      "schedule.poll({ backoff })",
      "selector deps as a spread",
    ],
    "core = what a RUNNING app looks up (see removals-core.ts's header)",
  );
  // Every cell-config row must be here: `removalsUsedBy` and cell() reject
  // them at runtime, from a module a page reaches.
  assertEquals(
    REMOVALS.filter((r) => r.kind === "cell-config").map((r) => r.key),
    CORE_REMOVALS.filter((r) => r.kind === "cell-config").map((r) => r.key),
  );
});

Deno.test("removals: splitting the table lost nothing — core is a prefix of the record", () => {
  const keys = REMOVALS.map((r) => r.key);
  assertEquals(
    keys.slice(0, CORE_REMOVALS.length),
    CORE_REMOVALS.map((r) => r.key),
  );
  assertEquals(new Set(keys).size, keys.length, "no row is duplicated");
  assert(
    REMOVALS.length > CORE_REMOVALS.length,
    "the tooling half still exists",
  );
});
