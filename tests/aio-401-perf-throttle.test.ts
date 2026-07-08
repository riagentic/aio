// AIO-401: perf/vitals violations (BUDGET_EFFECT etc.) fire on every occurrence
// — a slow or long-running effect trips the budget hundreds of times, flooding
// the console/log with identical noise. reportError now (a) logs WARN codes at
// warn level, not error, and (b) throttles the repetitive perf codes' console +
// logger output per (code, action) while still counting them.
import { assertEquals } from "@std/assert";
import {
  _resetPerfThrottle,
  createAioError,
  reportError,
} from "../src/diagnostics/error.ts";

function capture() {
  const warns: string[] = [], errors: string[] = [];
  const ow = console.warn, oe = console.error;
  console.warn = (m?: unknown) => warns.push(String(m));
  console.error = (m?: unknown) => errors.push(String(m));
  return {
    warns,
    errors,
    restore() {
      console.warn = ow;
      console.error = oe;
    },
  };
}

Deno.test("perf budget is a WARN, not an ERROR", () => {
  _resetPerfThrottle();
  const cap = capture();
  try {
    reportError(
      createAioError("BUDGET_EFFECT", "slow", { actionType: "c:m" }),
      { prod: true },
    );
  } finally {
    cap.restore();
  }
  assertEquals(cap.warns.length, 1);
  assertEquals(cap.errors.length, 0);
});

Deno.test("repeated perf violations are throttled to one console line", () => {
  _resetPerfThrottle();
  const cap = capture();
  let counted = 0;
  try {
    for (let i = 0; i < 50; i++) {
      reportError(
        createAioError("BUDGET_EFFECT", "slow", { actionType: "c:m" }),
        { prod: true, countError: () => counted++ },
      );
    }
  } finally {
    cap.restore();
  }
  assertEquals(cap.warns.length, 1); // 50 fired → 1 logged
  assertEquals(counted, 50); // but all 50 counted
});

Deno.test("logger.warn used for warn codes; falls back to error if absent", () => {
  _resetPerfThrottle();
  const warned: string[] = [], errored: string[] = [];
  reportError(createAioError("BUDGET_EFFECT", "slow", { actionType: "a:1" }), {
    logger: { error: (m) => errored.push(m), warn: (m) => warned.push(m) },
  });
  assertEquals(warned.length, 1);
  assertEquals(errored.length, 0);
  _resetPerfThrottle();
  const only: string[] = [];
  reportError(createAioError("BUDGET_EFFECT", "slow", { actionType: "b:1" }), {
    logger: { error: (m) => only.push(m) }, // no warn → falls back
  });
  assertEquals(only.length, 1);
});

Deno.test("distinct actions are throttled independently", () => {
  _resetPerfThrottle();
  const cap = capture();
  try {
    reportError(createAioError("BUDGET_EFFECT", "s", { actionType: "a:1" }), {
      prod: true,
    });
    reportError(createAioError("BUDGET_EFFECT", "s", { actionType: "b:2" }), {
      prod: true,
    });
    reportError(createAioError("BUDGET_EFFECT", "s", { actionType: "a:1" }), {
      prod: true,
    });
  } finally {
    cap.restore();
  }
  assertEquals(cap.warns.length, 2); // a:1 once, b:2 once, second a:1 suppressed
});

Deno.test("non-throttled errors are never suppressed", () => {
  _resetPerfThrottle();
  const cap = capture();
  try {
    for (let i = 0; i < 3; i++) {
      reportError(
        createAioError("EFFECT_ERROR", "boom", { actionType: "c:m" }),
        { prod: true },
      );
    }
  } finally {
    cap.restore();
  }
  assertEquals(cap.errors.length, 3); // real errors always reported
});
