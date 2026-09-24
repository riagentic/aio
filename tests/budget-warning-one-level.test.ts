// A blown reduce budget is a WARN-class code: the console said WARN, and the
// SAME report reached the log files as an ERROR (with a full framework stack),
// because the report shim offered `reportError` only an `error` writer — one
// event at two levels, and a red line for a warning (a user-driven hunt). The
// header also printed the raw `performance.now()` delta, `95.9382579999999ms`,
// one line above "95.9ms".
import { assert, assertEquals } from "@std/assert";
import { buildReportOpts } from "../src/server/aio-run-helpers.ts";
import { setLogger } from "../src/diagnostics/logger-api.ts";
import type { LogSink } from "../src/diagnostics/logger-types.ts";
import {
  createAioError,
  formatErrorBox,
  reportError,
} from "../src/diagnostics/error.ts";

const budget = () =>
  createAioError("BUDGET_REDUCE", "reduce exceeded budget: 95.9ms > 16ms", {
    cellName: "catalog",
    actionType: "catalog:fill",
    duration: 95.9382579999999,
    budget: 16,
  });

Deno.test("a blown budget reaches the log file at WARN, the level the console says", () => {
  const levels: string[] = [];
  setLogger({
    pub: (lvl: string) => levels.push(lvl),
  } as unknown as LogSink);
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    reportError(
      budget(),
      buildReportOpts({ onError: undefined, getTT: () => null, prod: true }),
    );
  } finally {
    setLogger(null);
    console.warn = origWarn;
    console.error = origError;
  }
  assert(levels.length > 0, "the report reached the file logger");
  assertEquals(levels.filter((l) => l === "error"), [], levels.join(","));
});

Deno.test("the error box header rounds the duration like its message", () => {
  const box = formatErrorBox(budget());
  assert(box.includes("95.9ms"), box);
  assert(!box.includes("95.938"), box);
});
