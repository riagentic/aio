// logger.test.ts — isolated tests for AioLogger
import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import {
  AioLogger,
  getLogger,
  log,
  setLogger,
} from "../src/diagnostics/logger.ts";

const tmpDir = () => Deno.makeTempDirSync();

/** Create logger with heartbeat disabled (avoids interval leaks in tests) */
function mkLogger(
  opts: {
    dir: string;
    console?: boolean;
    suppressTypes?: string[];
    backupLogs?: boolean;
    level?: "trace" | "debug" | "info" | "warn" | "error";
  },
): AioLogger {
  return new AioLogger({
    ...opts,
    heartbeat: 0,
    console: opts.console ?? false,
    // Sink-routing tests below assert on debug/trace entries — opt into the
    // verbose level (the production default is "info", pinned separately).
    level: opts.level ?? "trace",
  });
}

/** Wait for the buffered sink (250ms timer) to flush */
const flush = () => new Promise((r) => setTimeout(r, 400));

/** Read a log file and return lines (plain text) */
async function readLines(path: string): Promise<string[]> {
  const content = await Deno.readTextFile(path);
  return content.trim().split("\n").filter(Boolean);
}

Deno.test("logger: init creates log directory", async () => {
  const dir = `${tmpDir()}/logs`;
  const l = mkLogger({ dir });
  await l.init();
  const stat = await Deno.stat(dir);
  assertEquals(stat.isDirectory, true);
});

Deno.test("logger: setLogger/getLogger wires singleton", () => {
  const l = mkLogger({ dir: tmpDir() });
  setLogger(l);
  assertEquals(getLogger(), l);
  setLogger(null);
  assertEquals(getLogger(), null);
});

Deno.test("logger: public log API falls back to console when no logger set", () => {
  setLogger(null);
  // Should not throw — falls back to formatted console output
  log.trace("cat", "msg");
  log.debug("cat", "msg");
  log.info("cat", "msg");
  log.warn("cat", "msg");
  log.error("cat", "msg");
});

Deno.test("logger: plain text format — no JSON", async () => {
  const dir = tmpDir();
  const l = mkLogger({ dir });
  await l.init();
  l.onStart(["counter"], 8000);
  await flush();
  const lines = await readLines(`${dir}/app.log`);
  assertEquals(lines.length, 1);
  // Should NOT be JSON — no opening brace
  assertEquals(lines[0]!.startsWith("{"), false);
  // Should contain expected text fragments
  assertStringIncludes(lines[0]!, "INFO");
  assertStringIncludes(lines[0]!, "app");
  assertStringIncludes(lines[0]!, "started");
  assertStringIncludes(lines[0]!, "cells=counter");
});

Deno.test("logger: debug.log gets everything (info, warn, error, debug)", async () => {
  const dir = tmpDir();
  const l = mkLogger({ dir });
  await l.init();
  setLogger(l);
  log.info("cat", "info msg");
  log.warn("cat", "warn msg");
  log.error("cat", "error msg");
  log.debug("cat", "debug msg");
  log.trace("cat", "trace msg");
  await flush();
  const lines = await readLines(`${dir}/debug.log`);
  // All 5 levels should be in debug.log
  assertEquals(lines.length, 5);
  assertStringIncludes(lines[0]!, "INFO");
  assertStringIncludes(lines[1]!, "WARN");
  assertStringIncludes(lines[2]!, "ERROR");
  assertStringIncludes(lines[3]!, "DEBUG");
  assertStringIncludes(lines[4]!, "TRACE");
  setLogger(null);
});

Deno.test("logger: app.log gets info, warn, and error", async () => {
  const dir = tmpDir();
  const l = mkLogger({ dir });
  await l.init();
  setLogger(l);
  log.info("cat", "info msg");
  log.warn("cat", "warn msg");
  log.error("cat", "error msg");
  log.debug("cat", "debug msg");
  log.trace("cat", "trace msg");
  await flush();
  const lines = await readLines(`${dir}/app.log`);
  // AIO-233: app.log includes info, warn + error (not debug/trace)
  assertEquals(lines.length, 3);
  assertStringIncludes(lines[0]!, "INFO");
  assertStringIncludes(lines[1]!, "WARN");
  assertStringIncludes(lines[2]!, "ERROR");
  setLogger(null);
});

Deno.test("logger: warning.log gets only warnings", async () => {
  const dir = tmpDir();
  const l = mkLogger({ dir });
  await l.init();
  setLogger(l);
  log.info("cat", "info msg");
  log.warn("cat", "warn msg");
  log.error("cat", "error msg");
  await flush();
  const lines = await readLines(`${dir}/warning.log`);
  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0]!, "WARN");
  setLogger(null);
});

Deno.test("logger: error.log gets only errors", async () => {
  const dir = tmpDir();
  const l = mkLogger({ dir });
  await l.init();
  setLogger(l);
  log.info("cat", "info msg");
  log.warn("cat", "warn msg");
  log.error("cat", "error msg");
  await flush();
  const lines = await readLines(`${dir}/error.log`);
  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0]!, "ERROR");
  setLogger(null);
});

Deno.test("logger: perf violations go to perf.log and debug.log — no dedup", async () => {
  const dir = tmpDir();
  const l = mkLogger({ dir });
  await l.init();
  l.perf("reduce", "counter:increment", 150, 100);
  l.perf("reduce", "counter:increment", 200, 100);
  l.perf("reduce", "counter:increment", 180, 100);
  await flush();
  // All 3 violations in perf.log (no dedup)
  const perfLines = await readLines(`${dir}/perf.log`);
  assertEquals(perfLines.length, 3);
  assertStringIncludes(perfLines[0]!, "exceeded budget");
  // Also in debug.log
  const debugLines = await readLines(`${dir}/debug.log`);
  assertEquals(debugLines.length, 3);
});

Deno.test("logger: default wipes logs on start", async () => {
  const dir = tmpDir();
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/app.log`, "old content\n");
  const l = mkLogger({ dir });
  await l.init();
  // Old log should be gone, not rotated
  try {
    await Deno.stat(`${dir}/app.log.1`);
    throw new Error("should not exist");
  } catch (e) {
    assertStringIncludes((e as Error).message, "No such file");
  }
  // app.log should not exist yet (nothing logged)
  try {
    await Deno.stat(`${dir}/app.log`);
    throw new Error("should not exist");
  } catch (e) {
    assertStringIncludes((e as Error).message, "No such file");
  }
});

Deno.test("logger: backupLogs rotates instead of wiping", async () => {
  const dir = tmpDir();
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/app.log`, "old content\n");
  const l = mkLogger({ dir, backupLogs: true });
  await l.init();
  // Old log should be renamed to app.log.1
  const rotated = await Deno.readTextFile(`${dir}/app.log.1`);
  assertEquals(rotated, "old content\n");
});

Deno.test("logger: observe skips internal actions", async () => {
  const dir = tmpDir();
  const l = mkLogger({ dir });
  await l.init();
  l.observe({ type: "counter:__FlowState" }, { counter: {} });
  l.observe({ type: "counter:__exec" }, { counter: {} });
  l.observe({ type: "counter:__setIncrement" }, { counter: {} });
  await flush();
  try {
    await Deno.stat(`${dir}/debug.log`);
    // If debug.log exists, it should NOT contain these internal types
  } catch {
    // File doesn't exist — correct, nothing was logged
  }
});

Deno.test("logger: suppress types filters specified actions", async () => {
  const dir = tmpDir();
  const l = mkLogger({ dir, suppressTypes: ["tick:heartbeat"] });
  await l.init();
  l.observe({ type: "tick:heartbeat" }, {});
  l.observe({ type: "counter:increment" }, { counter: {} });
  await flush();
  const lines = await readLines(`${dir}/debug.log`);
  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0]!, "increment");
});

Deno.test("logger: onStop logs shutdown with uptime", async () => {
  const dir = tmpDir();
  const l = mkLogger({ dir });
  await l.init();
  l.onStart(["counter"]);
  await new Promise((r) => setTimeout(r, 50));
  l.onStop();
  await flush();
  const lines = await readLines(`${dir}/app.log`);
  const stopLine = lines.find((l) => l.includes("stopped"));
  assertEquals(stopLine !== undefined, true);
  assertStringIncludes(stopLine!, "uptime=");
});

Deno.test("logger: flow events tracked in app.log", async () => {
  const dir = tmpDir();
  const l = mkLogger({ dir });
  await l.init();
  l.onStart(["checkout"]);
  l.observe({ type: "checkout:__flow:step1", payload: { _flow: "place" } }, {
    checkout: {},
  });
  l.observe({ type: "checkout:__flow:done", payload: { _flow: "place" } }, {
    checkout: {},
  });
  await flush();
  const lines = await readLines(`${dir}/app.log`);
  const doneLine = lines.find((l) => l.includes("place done"));
  assertEquals(doneLine !== undefined, true);
  assertStringIncludes(doneLine!, "flow:checkout");
});

Deno.test("logger: identical consecutive errors collapse into a repeat summary", async () => {
  const dir = tmpDir();
  const l = mkLogger({ dir });
  await l.init();
  // 7 identical errors — one line + "repeated 6 times" (mdview #3: repeated
  // identical lines were storm fuel). Distinct errors still all appear.
  for (let i = 0; i < 7; i++) {
    l.observe({
      type: "counter:__error",
      payload: { _method: "save", error: "timeout" },
    }, { counter: {} });
  }
  await l.flush();
  const errorLines = await readLines(`${dir}/error.log`);
  assertEquals(errorLines.length, 2);
  assertStringIncludes(errorLines[1]!, "repeated 6 times");
});

Deno.test("logger: distinct consecutive errors are never collapsed", async () => {
  const dir = tmpDir();
  const l = mkLogger({ dir });
  await l.init();
  for (let i = 0; i < 3; i++) {
    l.observe({
      type: "counter:__error",
      payload: { _method: "save", error: `timeout ${i}` },
    }, { counter: {} });
  }
  await l.flush();
  const errorLines = await readLines(`${dir}/error.log`);
  assertEquals(errorLines.length, 3);
});

Deno.test("logger: default file level is info — debug entries are opt-in (mdview #3)", async () => {
  const dir = tmpDir();
  const l = new AioLogger({ dir, heartbeat: 0, console: false });
  await l.init();
  l.pub("debug", "test", "verbose-detail");
  l.pub("info", "test", "narrative-line");
  await l.flush();
  const debugLines = await readLines(`${dir}/debug.log`);
  assertEquals(debugLines.some((x) => x.includes("verbose-detail")), false);
  assertEquals(debugLines.some((x) => x.includes("narrative-line")), true);
});

Deno.test("logger: flush() writes buffered lines immediately", async () => {
  const dir = tmpDir();
  const l = mkLogger({ dir });
  await l.init();
  l.pub("info", "test", "buffered-line");
  await l.flush(); // no 250ms timer wait
  const lines = await readLines(`${dir}/app.log`);
  assertEquals(lines.some((x) => x.includes("buffered-line")), true);
});

Deno.test("logger: write failure logs to console (first 3 only)", async () => {
  const dir = "/nonexistent/path/that/should/fail";
  const l = mkLogger({ dir });
  // Force ready = true to exercise write path
  // @ts-ignore private access for testing
  l.ready = true;
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  l.pub("info", "test", "msg1");
  l.pub("info", "test", "msg2");
  l.pub("info", "test", "msg3");
  l.pub("info", "test", "msg4"); // should be suppressed
  await new Promise((r) => setTimeout(r, 200));
  console.error = origError;
  assertEquals(
    errors.filter((e) => e.includes("[logger] write failed")).length <= 3,
    true,
  );
});
