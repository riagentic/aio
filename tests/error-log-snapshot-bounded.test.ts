// An error report must not write the app's WHOLE STATE into the log file.
//
// `formatErrorBox` already caps the snapshot it prints — "state  {…}" is cut at
// 200 characters, deliberately and with a comment. The STRUCTURED payload
// beside it (`err.toJSON()`, handed straight to the logger) carried the same
// snapshot uncapped, so the two halves of one report disagreed about the same
// question and only the half nobody reads on a server was unbounded.
//
// Measured: a reducer that throws on a crafted payload is reachable from any
// connected client (a deeply nested argument overflows the stack inside the
// reducer — the framework catches it and reports REDUCE_ERROR, which is
// correct). Each such report wrote the entire live state to `logs/`. On an app
// holding ten thousand rows that is megabytes per error, and an error that
// repeats — a bad row that throws on every dispatch — fills the disk while the
// console shows a tidy 200-character line. Nothing reports a log that is
// eating the disk.
//
// So: the report keeps the full snapshot on the ERROR OBJECT (the `onError`
// hook and the feedback capture still get everything), and what goes to the
// logger is bounded — with the cells and their sizes named, which is what a
// reader actually needs from a snapshot too big to read.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createAioError, reportError } from "../src/diagnostics/error.ts";

function bigState(rows: number): Record<string, unknown> {
  return {
    todos: {
      items: Array.from({ length: rows }, (_, i) => ({
        id: `id-${i}`,
        title: `a fairly ordinary todo title number ${i}`,
        done: i % 2 === 0,
      })),
    },
    tiny: { n: 1 },
  };
}

function capture() {
  const seen: Array<{ msg: string; data?: Record<string, unknown> }> = [];
  return {
    seen,
    logger: {
      error: (msg: string, data?: Record<string, unknown>) =>
        void seen.push({ msg, data }),
      warn: (msg: string, data?: Record<string, unknown>) =>
        void seen.push({ msg, data }),
    },
  };
}

Deno.test("a reduce error does not write the whole state to the log", () => {
  const state = bigState(5_000);
  const full = JSON.stringify(state).length;
  assert(full > 200_000, `the fixture must be big to prove anything (${full})`);

  const { seen, logger } = capture();
  const err = createAioError("REDUCE_ERROR", "boom", {
    cellName: "todos",
    actionType: "todos:add",
  }, state);
  reportError(err, { logger, prod: true });

  assertEquals(seen.length, 1);
  const written = JSON.stringify(seen[0]!.data ?? {}).length;
  assert(
    written < 8_000,
    `the logged payload must be bounded, was ${written} bytes (state is ${full})`,
  );

  // …and still say what it dropped, and from where.
  const snap = JSON.stringify(seen[0]!.data?.stateSnapshot ?? null);
  assertStringIncludes(snap, "todos");
  assertStringIncludes(snap, String(full));

  // The ERROR OBJECT keeps everything — the onError hook and the feedback
  // capture are not the log file, and they were never the problem.
  assertEquals(
    JSON.stringify(err.stateSnapshot).length,
    full,
    "the snapshot on the error itself is untouched",
  );
});

Deno.test("a small state is logged whole — the cap is a ceiling, not a rewrite", () => {
  const { seen, logger } = capture();
  const state = { c: { n: 1, s: "hello" } };
  reportError(
    createAioError("REDUCE_ERROR", "boom", { cellName: "c" }, state),
    { logger, prod: true },
  );
  assertEquals(
    seen[0]!.data?.stateSnapshot,
    state,
    "under the budget the snapshot is the state, unchanged",
  );
});
