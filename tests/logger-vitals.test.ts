// logger-vitals.ts — no test file named it. 98 lines, three functions, and
// each one decides where a performance record is written and how loud it is.
//
// The invariant worth holding is the duplication: every entry goes to its own
// log AND to the debug log. That is what makes the debug log a complete record
// of a run — and `logging: false` silently stopping the action log and crash
// checkpoint is a bug this project has already had once, in the two artifacts
// that exist to explain a crash.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  logPerf,
  logVitals,
  logVitalsSummary,
} from "../src/diagnostics/logger-vitals.ts";
import type { LogEntry } from "../src/diagnostics/logger-types.ts";

type Written = { path: string; entry: LogEntry };

function sink() {
  const writes: Written[] = [];
  return {
    writes,
    write: (path: string, entry: LogEntry) => writes.push({ path, entry }),
    // The real pathFn maps a kind to a file; the kind is what matters here.
    pathFn: (kind: string) => `/logs/${kind}.log`,
    to: (kind: string) => writes.filter((w) => w.path === `/logs/${kind}.log`),
  };
}

const BREAKDOWN = {
  produce: 12.4,
  clone: 3.6,
  spread: 1.2,
  routing: 0.4,
  listeners: 8.9,
};

Deno.test("vitals: a perf violation lands in the perf log AND the debug log", () => {
  const s = sink();
  logPerf("reduce", "todo:add", 42.6, 16, undefined, s.write, s.pathFn, false);
  assertEquals(s.writes.length, 2, "a violation reached only one destination");
  assertEquals(s.to("perf").length, 1);
  assertEquals(s.to("debug").length, 1);
  // The same object both times — two logs, one fact.
  assertEquals(s.to("perf")[0]!.entry, s.to("debug")[0]!.entry);
});

Deno.test("vitals: the breakdown is carried as data, not only prose", () => {
  const s = sink();
  logPerf("reduce", "todo:add", 42.6, 16, BREAKDOWN, s.write, s.pathFn, false);
  const e = s.to("perf")[0]!.entry;

  // The message a person reads…
  assertStringIncludes(e.msg, "todo:add exceeded budget");
  assertStringIncludes(e.msg, "43ms > 16ms");
  assertStringIncludes(e.msg, "produce=12ms");
  assertStringIncludes(e.msg, "listeners=9ms");

  // …and the structure a tool reads. A breakdown that only exists inside a
  // sentence cannot be graphed, sorted or compared across runs.
  const data = e.data as {
    duration: number;
    budget: number;
    breakdown: unknown;
  };
  assertEquals(data.duration, 43);
  assertEquals(data.budget, 16);
  assertEquals(data.breakdown, BREAKDOWN);
  assertEquals(e.cat, "perf:reduce");
});

Deno.test("vitals: with no breakdown, neither the message nor the data invents one", () => {
  const s = sink();
  logPerf("effect", "sync:push", 20.2, 16, undefined, s.write, s.pathFn, false);
  const e = s.to("perf")[0]!.entry;
  assertEquals(e.cat, "perf:effect");
  assert(!e.msg.includes("produce="), `invented a breakdown: ${e.msg}`);
  assert(
    !("breakdown" in (e.data as Record<string, unknown>)),
    "an absent breakdown was recorded as present",
  );
});

Deno.test("vitals: `frozen` is a warning; everything else is a perf note", () => {
  // The one severity decision in the file. A frozen UI is not a data point,
  // it is the user staring at a page that does not move.
  const frozen = sink();
  logVitals(
    "render",
    "frozen",
    900,
    100,
    undefined,
    frozen.write,
    frozen.pathFn,
    false,
  );
  assertEquals(frozen.to("perf")[0]!.entry.lvl, "warn");

  for (const status of ["slow", "degraded", "ok"]) {
    const s = sink();
    logVitals("loop", status, 120, 100, undefined, s.write, s.pathFn, false);
    assertEquals(
      s.to("perf")[0]!.entry.lvl,
      "perf",
      `"${status}" was escalated to a warning`,
    );
  }
});

Deno.test("vitals: a hint carries its cause AND its fix into the line", () => {
  const s = sink();
  logVitals(
    "transport",
    "slow",
    310.7,
    200,
    {
      cause: "a 4 MB delta on every keystroke",
      suggestion: "narrow `visible` to the fields the page reads",
      severity: "high",
    },
    s.write,
    s.pathFn,
    false,
  );

  const e = s.to("perf")[0]!.entry;
  assertStringIncludes(e.msg, "[vitals:transport] slow 311ms");
  assertStringIncludes(e.msg, "threshold: 200ms");
  // A diagnosis with no way out is a diagnosis nobody can act on.
  assertStringIncludes(e.msg, "cause(high): a 4 MB delta");
  assertStringIncludes(e.msg, "fix: narrow `visible`");
  assertEquals(s.writes.length, 2);
});

Deno.test("vitals: without a hint the line stops rather than trailing empty labels", () => {
  const s = sink();
  logVitals("loop", "slow", 150, 100, undefined, s.write, s.pathFn, false);
  const msg = s.to("perf")[0]!.entry.msg;
  assertEquals(msg, "[vitals:loop] slow 150ms (threshold: 100ms)");
  assert(!msg.includes("cause"), "an empty cause label was printed");
});

Deno.test("vitals: the summary goes to the APP log, where a person is reading", () => {
  const s = sink();
  logVitalsSummary(
    "render p95 12ms · transport p95 30ms",
    s.write,
    s.pathFn,
    false,
  );
  // Not the perf log: a summary is the line you want in the ordinary output,
  // and the debug log keeps the complete record either way.
  assertEquals(s.to("app").length, 1);
  assertEquals(s.to("debug").length, 1);
  assertEquals(s.to("perf").length, 0);
  assertEquals(s.to("app")[0]!.entry.lvl, "info");
  assertEquals(s.to("app")[0]!.entry.cat, "vitals:summary");
});

Deno.test("vitals: the console is opt-in, and never at the cost of the files", () => {
  const lines: string[] = [];
  const real = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  console.warn = (...a: unknown[]) => lines.push(a.join(" "));
  console.error = (...a: unknown[]) => lines.push(a.join(" "));
  try {
    const off = sink();
    logPerf("reduce", "quiet", 42, 16, undefined, off.write, off.pathFn, false);
    assertEquals(lines.length, 0, "printed with the console disabled");
    assertEquals(off.writes.length, 2, "the files were skipped too");

    const on = sink();
    logPerf("reduce", "loud", 42, 16, undefined, on.write, on.pathFn, true);
    assert(lines.length > 0, "the console was enabled and stayed silent");
    assertEquals(on.writes.length, 2, "printing replaced writing");
  } finally {
    console.log = real.log;
    console.warn = real.warn;
    console.error = real.error;
  }
});
