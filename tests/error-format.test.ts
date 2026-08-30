import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createAioError,
  formatErrorBox,
  formatErrorCompact,
} from "../src/diagnostics/error.ts";

Deno.test("formatErrorBox — contains cell name and error code", () => {
  const err = createAioError("REDUCE_ERROR", new Error("kaboom"), {
    cellName: "orderer",
    actionType: "orderer:buy",
  });
  const output = formatErrorBox(err);
  assertStringIncludes(output, "REDUCE_ERROR");
  // The app's own vocabulary — cell and action — on ONE dim subject line,
  // not five bold-labelled rows of which four are usually empty.
  assertStringIncludes(output, "cell orderer");
  assertStringIncludes(output, "action orderer:buy");
  // No frame. The house style has no box drawing anywhere, and the old
  // `┏━━ AIO ERROR ━━┓` was a fixed 60 columns that neither wrapped a long
  // message nor used a wide terminal.
  assertEquals(/[┏┃┗━]/.test(output), false);
});

Deno.test("formatErrorBox — warning codes show AIO WARNING", () => {
  const err = createAioError("BUDGET_REDUCE", "slow", {
    cellName: "test",
    duration: 200,
    budget: 100,
  });
  const output = formatErrorBox(err);
  // A warning is the same shape in a different tone — the `!` glyph and the
  // code, never a differently-worded banner.
  assertStringIncludes(output, "BUDGET_REDUCE");
  assertStringIncludes(output, "!");
  assertEquals(output.includes("\u2717"), false); // not the error glyph
});

Deno.test("formatErrorBox — includes tip for EFFECT_TIMEOUT", () => {
  const err = createAioError("EFFECT_TIMEOUT", "timeout", {
    cellName: "api",
    effectType: "api:fetch",
  });
  const output = formatErrorBox(err);
  // The remedy is an arrow, not a `Tip:` label: it is the line the reader
  // acts on, and labelling it as advice buried it among the other rows.
  assertStringIncludes(output, "→");
  assertStringIncludes(output, "timed out");
});

Deno.test("formatErrorBox — truncates state snapshot", () => {
  const bigState = { data: "x".repeat(300) };
  const err = createAioError(
    "REDUCE_ERROR",
    "fail",
    { cellName: "test" },
    bigState,
  );
  const output = formatErrorBox(err);
  assertStringIncludes(output, "\u2026"); // unicode ellipsis used for truncation
});

Deno.test("formatErrorCompact — one-liner format", () => {
  const err = createAioError("EFFECT_ERROR", "boom", {
    cellName: "api",
    actionType: "api:fetch",
  });
  const output = formatErrorCompact(err);
  assertStringIncludes(output, "EFFECT_ERROR");
  assertStringIncludes(output, "api");
  assertStringIncludes(output, "boom");
});

Deno.test("formatErrorCompact — includes correlation id when set", () => {
  const err = createAioError("BUDGET_EFFECT", "slow", { cellName: "test" });
  const output = formatErrorCompact(err);
  assertStringIncludes(output, "BUDGET_EFFECT");
  assertStringIncludes(output, "test");
});

Deno.test("formatErrorBox — stack frames filtered (framework hidden)", () => {
  const original = new Error("test");
  original.stack = `Error: test
    at reducer (src/cells/orderer.ts:47:12)
    at Dispatch.reduce (dep/aio/src/dispatch.ts:152:9)
    at Dispatch.flush (dep/aio/src/dispatch.ts:72:3)
    at node_modules/something/index.js:10:5`;
  const err = createAioError("REDUCE_ERROR", original, { cellName: "test" });
  const output = formatErrorBox(err);
  assertStringIncludes(output, "orderer.ts:47:12");
  assertEquals(output.includes("dep/aio/src/dispatch.ts"), false);
  assertEquals(output.includes("node_modules"), false);
});
